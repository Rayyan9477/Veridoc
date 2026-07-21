'use client';

/**
 * Security overview — the admin-facing read on Veridoc's compliance
 * posture: the tamper-evident audit chain, PHI enforcement mode, and
 * live security-component health.
 *
 * Backed by `GET /api/v1/health/security` (admin-only, requires the
 * `system:metrics` permission — see `src/api/routes/health.py`). Two of
 * the four headline stats (active sessions, failed logins) have no
 * backend endpoint yet, so they render an honest "not tracked" state
 * rather than invented numbers. Likewise the audit-log preview links out
 * to `/audit`, which itself has no query endpoint yet.
 */

import { useState, type ComponentType, type ReactNode } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ArrowRight,
  CheckCircle2,
  Database,
  KeyRound,
  Lock,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  XCircle,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { cn, formatRelativeTime } from '@/lib/utils';
import {
  ApiError,
  securityApi,
  type HipaaComplianceFlags,
  type SecurityComponentStatus,
} from '@/lib/api/admin';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  tone,
  delay = 0,
}: {
  label: string;
  value: ReactNode;
  icon: ComponentType<{ className?: string }>;
  hint?: ReactNode;
  tone?: 'success' | 'warning' | 'error' | 'info';
  delay?: number;
}) {
  const toneVar =
    tone === 'success'
      ? '--accent-success-rgb'
      : tone === 'warning'
        ? '--accent-warning-rgb'
        : tone === 'error'
          ? '--accent-danger-rgb'
          : '--accent-brand-rgb';
  return (
    <motion.div {...fade(delay)} className="stat-card">
      <div className="flex items-center justify-between">
        <span className="stat-label">{label}</span>
        <span
          className="grid place-items-center w-8 h-8 rounded-lg"
          style={{ background: `rgb(var(${toneVar}) / 0.12)`, color: `rgb(var(${toneVar}))` }}
        >
          <Icon className="w-4 h-4" />
        </span>
      </div>
      <div className="stat-value">{value}</div>
      {hint && <span className="text-small text-text-muted">{hint}</span>}
    </motion.div>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-h3 font-display font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

const COMPONENT_LABELS: Record<string, { label: string; icon: ComponentType<{ className?: string }> }> = {
  encryption: { label: 'Encryption', icon: Lock },
  audit_logging: { label: 'Audit logging', icon: ScrollText },
  rbac: { label: 'RBAC', icon: UserCog },
  data_cleanup: { label: 'Data cleanup', icon: Database },
};

function componentDot(status: string) {
  if (status === 'healthy') return 'status-dot-success';
  if (status === 'not_configured' || status === 'disabled') return 'status-dot-warning';
  if (status === 'unknown') return 'status-dot-info';
  return 'status-dot-error';
}

function componentDetail(status: SecurityComponentStatus): string | undefined {
  if (typeof status.algorithm === 'string') return status.algorithm;
  if (typeof status.message === 'string') return status.message;
  if (typeof status.error === 'string') return status.error;
  if (status.jwt_enabled === true) return 'JWT enabled';
  if (status.secure_deletion === true) return 'Secure deletion enabled';
  return undefined;
}

const HIPAA_LABELS: Record<keyof HipaaComplianceFlags, string> = {
  encryption_at_rest: 'Encryption at rest',
  audit_logging: 'Audit logging active',
  access_control: 'Access control (RBAC)',
  secure_deletion: 'Secure deletion',
  phi_masking: 'PHI masking',
  tamper_evident_logs: 'Tamper-evident logs',
};

export default function SecurityPage() {
  const [lastVerified, setLastVerified] = useState<string | null>(null);
  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['admin', 'security-status'],
    queryFn: () => securityApi.getStatus(),
    retry: (count, err) => !(err instanceof ApiError && err.status === 403) && count < 2,
  });

  const forbidden = error instanceof ApiError && error.status === 403;
  const unreachable = !!error && !forbidden;

  const handleVerify = async () => {
    try {
      const result = await refetch();
      if (result.data) {
        setLastVerified(result.data.timestamp);
        const intact = result.data.hipaa_compliance.tamper_evident_logs;
        toast[intact ? 'success' : 'error'](
          intact
            ? `Chain check passed — tamper-evident logging is on (${result.data.compliance_score}% compliance).`
            : 'Chain check flagged an issue — tamper-evident logging is off.',
        );
      } else if (result.error) {
        throw result.error;
      }
    } catch (e) {
      const msg =
        e instanceof ApiError
          ? e.status === 403
            ? 'Verification requires the system:metrics permission.'
            : e.message
          : 'Could not reach the security status endpoint.';
      toast.error(msg);
    }
  };

  const chainIntact = data?.hipaa_compliance.tamper_evident_logs;
  const phiEnforced = data?.hipaa_compliance.phi_masking;

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-body text-text-secondary max-w-2xl">
            Compliance posture for this tenant — audit-chain integrity, PHI enforcement,
            and the live status of every security component.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => refetch()}
              className="btn-secondary text-small px-3 py-1.5"
              disabled={isFetching}
            >
              <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} aria-hidden />
              Refresh
            </button>
            <button onClick={handleVerify} className="btn-primary text-small px-3 py-1.5">
              <ShieldCheck className="w-4 h-4" aria-hidden />
              Verify audit chain
            </button>
          </div>
        </motion.div>

        {forbidden && (
          <motion.div {...fade(0.02)} className="card p-4 flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-accent-warning shrink-0" aria-hidden />
            <p className="text-body text-text-secondary">
              Your account doesn&apos;t have the <span className="font-mono text-small">system:metrics</span>{' '}
              permission, so live security status can&apos;t be loaded. The panels below show what would be
              tracked once access is granted.
            </p>
          </motion.div>
        )}
        {unreachable && (
          <motion.div {...fade(0.02)} className="card p-4 flex items-center gap-3">
            <ShieldAlert className="w-5 h-5 text-accent-danger shrink-0" aria-hidden />
            <p className="text-body text-text-secondary">
              Couldn&apos;t reach the security status endpoint. Retry once the API is back.
            </p>
          </motion.div>
        )}

        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            delay={0.02}
            label="Audit chain"
            icon={ScrollText}
            tone={chainIntact === true ? 'success' : chainIntact === false ? 'error' : undefined}
            value={
              isLoading ? (
                <span className="skeleton inline-block w-16 h-7 align-middle" />
              ) : chainIntact === undefined ? (
                '—'
              ) : chainIntact ? (
                'Intact'
              ) : (
                'Broken'
              )
            }
            hint={
              data
                ? `hash-chained JSONL · ${data.compliance_score}% compliance`
                : forbidden
                  ? 'requires system:metrics'
                  : 'tamper-evident hash chain'
            }
          />
          <StatCard
            delay={0.06}
            label="PHI mode"
            icon={Lock}
            tone={phiEnforced === true ? 'success' : phiEnforced === false ? 'warning' : undefined}
            value={
              isLoading ? (
                <span className="skeleton inline-block w-20 h-7 align-middle" />
              ) : phiEnforced === undefined ? (
                '—'
              ) : phiEnforced ? (
                'Enforced'
              ) : (
                'Bypassed'
              )
            }
            hint="tenant-scoped masking"
          />
          <StatCard
            delay={0.1}
            label="Active sessions"
            icon={KeyRound}
            value="—"
            hint="session analytics not exposed yet"
          />
          <StatCard
            delay={0.14}
            label="Failed logins · 24h"
            icon={ShieldAlert}
            value="—"
            hint="login-audit query coming soon"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Component health */}
          <motion.div {...fade(0.1)}>
            <Panel title="Component health">
              {isLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-10 w-full" />
                  ))}
                </div>
              ) : !data ? (
                <div className="py-10 text-center text-body text-text-muted">
                  {forbidden ? 'No permission to view component health.' : 'Component health unavailable.'}
                </div>
              ) : (
                <ul className="divide-y divide-border-default">
                  {Object.entries(data.components).map(([key, status]) => {
                    const meta = COMPONENT_LABELS[key] ?? { label: key, icon: ShieldCheck };
                    const Icon = meta.icon;
                    const detail = componentDetail(status);
                    return (
                      <li key={key} className="flex items-center gap-3 py-2.5">
                        <Icon className="w-4 h-4 text-text-muted shrink-0" aria-hidden />
                        <span className="flex-1 text-body text-text-primary">{meta.label}</span>
                        {detail && (
                          <span className="text-small font-mono text-text-muted truncate max-w-[10rem]">
                            {detail}
                          </span>
                        )}
                        <span className={componentDot(status.status)} />
                        <span className="text-small text-text-secondary capitalize w-24 text-right">
                          {status.status.replace(/_/g, ' ')}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </motion.div>

          {/* HIPAA compliance checklist */}
          <motion.div {...fade(0.14)}>
            <Panel title="HIPAA compliance checklist">
              {isLoading ? (
                <div className="space-y-3">
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="skeleton h-6 w-full" />
                  ))}
                </div>
              ) : !data ? (
                <div className="py-10 text-center text-body text-text-muted">
                  {forbidden ? 'No permission to view compliance flags.' : 'Compliance flags unavailable.'}
                </div>
              ) : (
                <ul className="space-y-2.5">
                  {(Object.keys(HIPAA_LABELS) as Array<keyof HipaaComplianceFlags>).map((key) => {
                    const on = data.hipaa_compliance[key];
                    return (
                      <li key={key} className="flex items-center gap-2.5">
                        {on ? (
                          <CheckCircle2 className="w-4 h-4 text-accent-success shrink-0" aria-hidden />
                        ) : (
                          <XCircle className="w-4 h-4 text-accent-danger shrink-0" aria-hidden />
                        )}
                        <span className="text-body text-text-primary">{HIPAA_LABELS[key]}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
          </motion.div>
        </div>

        {/* Audit log preview */}
        <motion.div {...fade(0.18)}>
          <Panel
            title="Audit log preview"
            action={
              <Link href="/audit" className="text-small text-accent-brand inline-flex items-center gap-1">
                Open audit log <ArrowRight className="w-3.5 h-3.5" aria-hidden />
              </Link>
            }
          >
            <div className="py-10 text-center space-y-2">
              <ScrollText className="w-8 h-8 mx-auto text-text-muted" aria-hidden />
              <p className="text-body text-text-secondary">Audit query endpoint coming soon.</p>
              <p className="text-small text-text-muted max-w-md mx-auto">
                Events are already written to a tamper-evident, hash-chained JSONL log
                (<span className="font-mono">src/security/audit.py</span>). This preview will populate once
                that log is queryable from the API.
              </p>
            </div>
          </Panel>
        </motion.div>

        {(lastVerified || data?.timestamp) && (
          <p className="text-small text-text-muted text-right">
            Last checked {formatRelativeTime(lastVerified ?? data!.timestamp)}
          </p>
        )}
      </div>
    </AppLayout>
  );
}
