'use client';

/**
 * Users — the RBAC roster.
 *
 * Backed by the real, persistent user store: `GET /api/v1/users` reads
 * `data/users.json` via the same `UserStore` the auth/RBAC layer uses
 * (see `src/security/rbac.py`). Password hashes are never returned.
 *
 * The roster is read-only here. Creating users and editing role/permission
 * mappings flow through the auth subsystem's privileged paths, so the
 * "New user" and "Roles matrix" actions remain clearly-labeled shells
 * rather than silently doing nothing.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Grid3x3, ShieldQuestion, UserPlus, Users as UsersIcon } from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { usersApi, type UserRow } from '@/lib/api/admin';

const ROLE_OPTIONS = ['All roles', 'Admin', 'Reviewer', 'Auditor', 'Viewer'];
const MFA_OPTIONS = ['All', 'Enabled', 'Disabled'] as const;

const TABLE_COLUMNS = ['User', 'Roles', 'Tenant', 'Last active', 'MFA'] as const;

function formatLastActive(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

export default function UsersPage() {
  const [tenant, setTenant] = useState('');
  const [role, setRole] = useState(ROLE_OPTIONS[0]);
  const [mfa, setMfa] = useState<(typeof MFA_OPTIONS)[number]>('All');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.list,
  });

  const filtered = useMemo(() => {
    const all = data ?? [];
    return all.filter((u) => {
      if (tenant.trim() && !u.tenant_id.toLowerCase().includes(tenant.trim().toLowerCase())) {
        return false;
      }
      if (role !== ROLE_OPTIONS[0]) {
        const want = role.toLowerCase();
        if (!u.roles.some((r) => r.toLowerCase() === want)) return false;
      }
      if (mfa === 'Enabled' && u.mfa_enabled !== true) return false;
      if (mfa === 'Disabled' && u.mfa_enabled !== false) return false;
      return true;
    });
  }, [data, tenant, role, mfa]);

  const notReady = (what: string) => () =>
    toast(`${what} needs a privileged admin endpoint — read-only roster for now.`, { icon: '🔒' });

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-body text-text-secondary max-w-2xl">
            Manage who can access this tenant and what they can do — roles, MFA status, and
            last-active tracking.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={notReady('Roles matrix')} className="btn-secondary text-small px-3 py-1.5">
              <Grid3x3 className="w-4 h-4" aria-hidden />
              Roles matrix
            </button>
            <button onClick={notReady('Creating a user')} className="btn-primary text-small px-3 py-1.5">
              <UserPlus className="w-4 h-4" aria-hidden />
              New user
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="card p-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-small text-text-muted mb-1 block" htmlFor="users-tenant">
                Tenant
              </label>
              <input
                id="users-tenant"
                type="text"
                placeholder="tenant id"
                value={tenant}
                onChange={(e) => setTenant(e.target.value)}
                className="input"
              />
            </div>
            <div>
              <label className="text-small text-text-muted mb-1 block" htmlFor="users-role">
                Role
              </label>
              <select
                id="users-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="input"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-small text-text-muted mb-1 block" htmlFor="users-mfa">
                MFA
              </label>
              <select
                id="users-mfa"
                value={mfa}
                onChange={(e) => setMfa(e.target.value as (typeof MFA_OPTIONS)[number])}
                className="input"
              >
                {MFA_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* RBAC table */}
        <div className="card overflow-hidden">
          <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 border-b border-border-default text-small uppercase tracking-wide text-text-muted">
            <div className="col-span-4">{TABLE_COLUMNS[0]}</div>
            <div className="col-span-3">{TABLE_COLUMNS[1]}</div>
            <div className="col-span-2">{TABLE_COLUMNS[2]}</div>
            <div className="col-span-2">{TABLE_COLUMNS[3]}</div>
            <div className="col-span-1">{TABLE_COLUMNS[4]}</div>
          </div>

          {isLoading ? (
            <div className="divide-y divide-border-default">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="px-5 py-3">
                  <div className="skeleton h-6 w-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="py-16 text-center space-y-2">
              <UsersIcon className="w-8 h-8 mx-auto text-accent-danger" aria-hidden />
              <p className="text-body text-text-secondary">Couldn’t load the user roster.</p>
              <button onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5 mt-2">
                Try again
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <UsersIcon className="w-8 h-8 mx-auto text-text-muted" aria-hidden />
              <p className="text-body text-text-secondary">
                {(data?.length ?? 0) === 0 ? 'No users in the store yet.' : 'No users match these filters.'}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border-default">
              {filtered.map((u) => (
                <UserTableRow key={u.user_id} user={u} />
              ))}
            </ul>
          )}
        </div>

        {/* Explainer for the disabled actions above */}
        <div className="card p-4 flex items-start gap-3">
          <ShieldQuestion className="w-5 h-5 text-accent-brand shrink-0 mt-0.5" aria-hidden />
          <p className="text-small text-text-secondary">
            This roster is read-only.{' '}
            <span className="text-text-primary font-medium">New user</span> and{' '}
            <span className="text-text-primary font-medium">Roles matrix</span> surface a reminder
            rather than silently doing nothing — creating users and editing role/permission mappings
            run through the auth subsystem&apos;s privileged paths, not this screen.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}

function UserTableRow({ user }: { user: UserRow }) {
  return (
    <li className="grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 px-5 py-3 hover:bg-white/5 transition-colors">
      <div className="md:col-span-4 min-w-0">
        <p className="text-body font-medium text-text-primary truncate">{user.username}</p>
        <p className="text-small text-text-muted truncate">{user.email}</p>
      </div>
      <div className="md:col-span-3 flex flex-wrap gap-1.5 items-start">
        {user.roles.length > 0 ? (
          user.roles.map((r) => (
            <span key={r} className="badge-info capitalize">
              {r}
            </span>
          ))
        ) : (
          <span className="text-small text-text-muted">—</span>
        )}
      </div>
      <div className="md:col-span-2 text-body text-text-secondary truncate">{user.tenant_id}</div>
      <div className="md:col-span-2 text-body text-text-secondary">{formatLastActive(user.last_login)}</div>
      <div className="md:col-span-1">
        {user.mfa_enabled === true ? (
          <span className="badge-success">On</span>
        ) : user.mfa_enabled === false ? (
          <span className="badge-warning">Off</span>
        ) : (
          <span className="text-small text-text-muted">—</span>
        )}
      </div>
    </li>
  );
}
