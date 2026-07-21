'use client';

/**
 * API keys — list, revoke, and a "create" affordance.
 *
 * `GET /api/v1/auth/api-keys` is attempted through a normalising helper
 * (lib/api/integrate.ts) since the exact response shape isn't confirmed
 * from here; error or empty payload renders an honest empty state.
 * Revoke attempts a conventional `DELETE /api/v1/auth/api-keys/{id}` and
 * reports back whatever the backend actually says. Key creation has no
 * confirmed request contract, so the modal explains the one-time-reveal
 * model but never fabricates a fake secret or calls the network.
 */

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  KeyRound,
  Plus,
  X,
  ShieldOff,
  RefreshCw,
  Clock,
  CalendarDays,
  Info,
  Loader2,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { cn, formatRelativeTime, formatDateTime } from '@/lib/utils';
import { fetchApiKeys, revokeApiKey, type ApiKeySummary } from '@/lib/api/integrate';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const SCOPE_OPTIONS = ['read', 'write', 'admin'];

export default function ApiKeysPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeySummary | null>(null);
  const queryClient = useQueryClient();

  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: fetchApiKeys,
    retry: 1,
  });

  const keys = keysQuery.data ?? [];

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div>
            <h1 className="font-display text-h2 font-semibold text-text-primary flex items-center gap-2.5">
              <KeyRound className="w-5 h-5 text-accent-brand" aria-hidden />
              API keys
            </h1>
            <p className="mt-1 text-body text-text-secondary">
              Programmatic access credentials for this workspace.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => keysQuery.refetch()}
              className="btn-secondary text-small px-3 py-1.5"
            >
              <RefreshCw className={cn('w-4 h-4', keysQuery.isFetching && 'animate-spin')} aria-hidden />
              Refresh
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary text-small px-3 py-1.5">
              <Plus className="w-4 h-4" aria-hidden />
              New API key
            </button>
          </div>
        </motion.div>

        <motion.div {...fade(0.06)}>
          {keysQuery.isLoading ? (
            <div className="card p-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-14 w-full" />
              ))}
            </div>
          ) : keysQuery.isError || keys.length === 0 ? (
            <div className="card p-10 text-center">
              <span
                className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
                style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
              >
                <KeyRound className="w-6 h-6" aria-hidden />
              </span>
              <h3 className="font-display text-h3 font-semibold text-text-primary">
                No API keys found
              </h3>
              <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
                {keysQuery.isError
                  ? 'The API keys endpoint didn’t respond successfully. Generate a key once the backend is reachable.'
                  : 'No API keys have been generated for this workspace yet.'}
              </p>
            </div>
          ) : (
            <div className="card overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-body">
                  <thead>
                    <tr className="border-b border-border-default text-small text-text-muted">
                      <th className="text-left font-medium px-4 py-3">Name</th>
                      <th className="text-left font-medium px-4 py-3">Scope</th>
                      <th className="text-left font-medium px-4 py-3">Last used</th>
                      <th className="text-left font-medium px-4 py-3">Created</th>
                      <th className="text-left font-medium px-4 py-3">Status</th>
                      <th className="text-right font-medium px-4 py-3">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-default">
                    {keys.map((key) => (
                      <tr key={key.id} className="hover:bg-white/5 transition-colors">
                        <td className="px-4 py-3">
                          <span className="text-body text-text-primary font-medium">{key.name}</span>
                        </td>
                        <td className="px-4 py-3">
                          {key.scope.length > 0 ? (
                            <div className="flex flex-wrap gap-1.5">
                              {key.scope.map((s) => (
                                <span key={s} className="badge-info font-mono">
                                  {s}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-small text-text-muted">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-small text-text-secondary whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <Clock className="w-3 h-3 text-text-muted" aria-hidden />
                            {key.lastUsedAt ? formatRelativeTime(key.lastUsedAt) : 'never'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-small text-text-secondary whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <CalendarDays className="w-3 h-3 text-text-muted" aria-hidden />
                            {key.createdAt ? formatDateTime(key.createdAt) : 'unknown'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          {key.revoked ? (
                            <span className="badge-error">Revoked</span>
                          ) : (
                            <span className="badge-success">Active</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {!key.revoked && (
                            <button
                              onClick={() => setRevokeTarget(key)}
                              className="btn-ghost text-small px-2.5 py-1.5"
                            >
                              <ShieldOff className="w-3.5 h-3.5" aria-hidden />
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {showCreate && <NewApiKeyModal onClose={() => setShowCreate(false)} />}
        {revokeTarget && (
          <RevokeModal
            apiKey={revokeTarget}
            onClose={() => setRevokeTarget(null)}
            onRevoked={() => {
              setRevokeTarget(null);
              queryClient.invalidateQueries({ queryKey: ['api-keys'] });
            }}
          />
        )}
      </AnimatePresence>
    </AppLayout>
  );
}

function ModalShell({
  titleId,
  onClose,
  children,
}: {
  titleId: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="absolute inset-0"
        style={{ background: 'rgb(var(--bg-overlay-rgb) / 0.55)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 16 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="card relative w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        {children}
      </motion.div>
    </div>
  );
}

function NewApiKeyModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<string[]>(['read']);

  const toggleScope = (s: string) => {
    setScope((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    toast(
      'Stub — key creation isn’t wired to a confirmed POST endpoint yet, so no key was generated.',
      { icon: 'ℹ️', duration: 6000 },
    );
    onClose();
  };

  return (
    <ModalShell titleId="new-key-title" onClose={onClose}>
      <div className="flex items-start justify-between gap-4 p-5 border-b border-border-default">
        <div>
          <h2 id="new-key-title" className="font-display text-h3 font-semibold text-text-primary">
            New API key
          </h2>
          <p className="mt-1 text-small text-text-secondary">Scoped credential for programmatic access.</p>
        </div>
        <button onClick={onClose} className="btn-ghost p-1.5 flex-shrink-0" aria-label="Close">
          <X className="w-4 h-4" aria-hidden />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div
          className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-small"
          style={{ background: 'rgb(var(--accent-brand-rgb) / 0.1)', color: 'rgb(var(--accent-brand-rgb))' }}
        >
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
          <span>
            The secret is shown <strong>once</strong>, immediately after generation — copy it into your secret
            manager right away. Veridoc never stores or displays it again.
          </span>
        </div>

        <div>
          <label htmlFor="key-name" className="block text-small font-medium text-text-secondary mb-1.5">
            Key name
          </label>
          <input
            id="key-name"
            type="text"
            required
            placeholder="e.g. billing-integration"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
        </div>

        <div>
          <span className="block text-small font-medium text-text-secondary mb-1.5">Scope</span>
          <div className="flex flex-wrap gap-1.5">
            {SCOPE_OPTIONS.map((s) => {
              const selected = scope.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleScope(s)}
                  className={cn('font-mono', selected ? 'badge-primary' : 'badge-info')}
                  style={!selected ? { opacity: 0.5 } : undefined}
                  aria-pressed={selected}
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        <p className="text-small text-text-muted">
          This form is a preview. Generating a real key requires a confirmed create-key contract on the backend.
        </p>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary text-small px-3.5 py-2">
            Cancel
          </button>
          <button type="submit" className="btn-primary text-small px-3.5 py-2">
            <Plus className="w-4 h-4" aria-hidden />
            Generate key
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function RevokeModal({
  apiKey,
  onClose,
  onRevoked,
}: {
  apiKey: ApiKeySummary;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [pending, setPending] = useState(false);

  const handleRevoke = async () => {
    setPending(true);
    const result = await revokeApiKey(apiKey.id);
    setPending(false);
    if (result.ok) {
      toast.success(`“${apiKey.name}” revoked.`);
      onRevoked();
    } else {
      toast.error(
        result.status
          ? `Revoke failed (${result.status}): ${result.message}`
          : `Revoke failed: ${result.message}`,
      );
    }
  };

  return (
    <ModalShell titleId="revoke-key-title" onClose={onClose}>
      <div className="p-5 space-y-4">
        <div className="flex items-start gap-3">
          <span
            className="grid place-items-center w-10 h-10 rounded-xl flex-shrink-0"
            style={{ background: 'rgb(var(--accent-danger-rgb) / 0.12)', color: 'rgb(var(--accent-danger-rgb))' }}
          >
            <ShieldOff className="w-5 h-5" aria-hidden />
          </span>
          <div>
            <h2 id="revoke-key-title" className="font-display text-h3 font-semibold text-text-primary">
              Revoke &ldquo;{apiKey.name}&rdquo;?
            </h2>
            <p className="mt-1 text-body text-text-secondary">
              Any integration using this key will lose access immediately. This can&apos;t be undone.
            </p>
          </div>
        </div>

        <p className="text-small text-text-muted">
          Attempts <code className="font-mono">DELETE /api/v1/auth/api-keys/{apiKey.id}</code> — the exact revoke
          contract isn&apos;t confirmed, so this may fail if the backend expects something different.
        </p>

        <div className="flex items-center justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary text-small px-3.5 py-2" disabled={pending}>
            Cancel
          </button>
          <button type="button" onClick={handleRevoke} className="btn-danger text-small px-3.5 py-2" disabled={pending}>
            {pending ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <ShieldOff className="w-4 h-4" aria-hidden />}
            Revoke key
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
