'use client';

import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Database,
  HardDrive,
  RefreshCw,
  Server,
  Shield,
  Zap,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { healthApi } from '@/lib/api';
import { cn, formatDateTime } from '@/lib/utils';
import type { ComponentHealth } from '@/types/api';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const POLL_MS = 30000;

type NormalizedStatus = 'healthy' | 'degraded' | 'unhealthy' | 'disabled' | 'not_configured' | 'unknown';

const KNOWN_STATUSES: NormalizedStatus[] = [
  'healthy',
  'degraded',
  'unhealthy',
  'disabled',
  'not_configured',
];

function normalizeStatus(raw: unknown): NormalizedStatus {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.toLowerCase();
  return (KNOWN_STATUSES as string[]).includes(s) ? (s as NormalizedStatus) : 'unknown';
}

function statusDotClass(status: NormalizedStatus) {
  switch (status) {
    case 'healthy':
      return 'status-dot-success';
    case 'unhealthy':
      return 'status-dot-error';
    case 'degraded':
    case 'disabled':
    case 'not_configured':
      return 'status-dot-warning';
    default:
      return 'status-dot-info';
  }
}

function statusBadgeClass(status: NormalizedStatus) {
  switch (status) {
    case 'healthy':
      return 'badge-success';
    case 'unhealthy':
      return 'badge-error';
    case 'degraded':
    case 'disabled':
    case 'not_configured':
      return 'badge-warning';
    default:
      return 'badge-info';
  }
}

function statusLabel(status: NormalizedStatus) {
  if (status === 'not_configured') return 'not configured';
  if (status === 'unknown') return 'not reported';
  return status;
}

const COMPONENT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  api: Server,
  redis: Database,
  workers: Activity,
  vlm: Cpu,
  system: HardDrive,
  security: Shield,
  monitoring: Zap,
};

function componentIcon(name: string): React.ComponentType<{ className?: string }> {
  return COMPONENT_ICONS[name.toLowerCase()] ?? Server;
}

/** Real check against whatever the VLM component reports — model id,
 * provider name, or the LM Studio available-models list — never fabricated. */
function isQwenBackend(component: ComponentHealth): boolean {
  const candidates: unknown[] = [component.model, component.provider, component.available_models];
  for (const c of candidates) {
    if (typeof c === 'string' && c.toLowerCase().includes('qwen')) return true;
    if (Array.isArray(c) && c.some((v) => typeof v === 'string' && v.toLowerCase().includes('qwen'))) {
      return true;
    }
  }
  return false;
}

function meterColor(v: number) {
  if (v > 85) return 'rgb(var(--accent-danger-rgb))';
  if (v > 60) return 'rgb(var(--accent-warning-rgb))';
  return 'rgb(var(--accent-success-rgb))';
}

function InfoTile({ label, value, error, mono }: { label: string; value: string; error?: boolean; mono?: boolean }) {
  return (
    <div className="rounded-xl p-3 glass-hairline min-w-0">
      <p className="text-small text-text-muted">{label}</p>
      <p
        className={cn(
          'text-body truncate',
          error ? 'conf-low' : 'text-text-primary',
          mono && 'font-mono text-small',
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

const PRIMITIVE_META_EXCLUDE = new Set(['status', 'error', 'message', 'latency_ms']);

function ComponentCard({
  name,
  component,
  delay,
}: {
  name: string;
  component: Record<string, unknown>;
  delay: number;
}) {
  const status = normalizeStatus(component.status);
  const Icon = componentIcon(name);
  const latency = typeof component.latency_ms === 'number' ? component.latency_ms : undefined;
  const message = typeof component.message === 'string' ? component.message : undefined;
  const error = typeof component.error === 'string' ? component.error : undefined;

  const subEntries = Object.entries(component).filter(
    ([, v]) => typeof v === 'object' && v !== null && !Array.isArray(v) && 'status' in (v as Record<string, unknown>),
  ) as [string, Record<string, unknown>][];

  const metaEntries = Object.entries(component).filter(
    ([k, v]) =>
      !PRIMITIVE_META_EXCLUDE.has(k) &&
      (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
  ) as [string, string | number | boolean][];

  return (
    <motion.div {...fade(delay)} className="card p-5">
      <div className="flex items-center justify-between mb-3 gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="grid place-items-center w-9 h-9 rounded-xl text-text-secondary flex-shrink-0"
            style={{ background: 'rgb(var(--text-primary-rgb) / 0.06)' }}
          >
            <Icon className="w-4 h-4" aria-hidden />
          </span>
          <h3 className="font-display text-h3 font-semibold text-text-primary capitalize truncate">
            {name.replace(/_/g, ' ')}
          </h3>
        </div>
        <span className={statusDotClass(status)} title={statusLabel(status)} aria-hidden />
      </div>

      <span className={statusBadgeClass(status)}>{statusLabel(status)}</span>

      {latency !== undefined && (
        <p className="mt-3 text-small text-text-muted">
          Latency <span className="font-mono text-text-secondary">{latency}ms</span>
        </p>
      )}
      {message && <p className="mt-2 text-small text-text-secondary">{message}</p>}
      {error && <p className="mt-2 text-small conf-low">{error}</p>}

      {metaEntries.length > 0 && (
        <dl className="mt-3 space-y-1 text-small">
          {metaEntries.map(([k, v]) => (
            <div key={k} className="flex items-center justify-between gap-2">
              <dt className="text-text-muted capitalize truncate">{k.replace(/_/g, ' ')}</dt>
              <dd className="font-mono text-text-secondary truncate">{String(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {subEntries.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-t border-border-default pt-3">
          {subEntries.map(([subName, subVal]) => {
            const subStatus = normalizeStatus(subVal.status);
            return (
              <li key={subName} className="flex items-center justify-between text-small gap-2">
                <span className="text-text-secondary capitalize truncate">{subName.replace(/_/g, ' ')}</span>
                <span className="inline-flex items-center gap-1.5 flex-shrink-0">
                  <span className={statusDotClass(subStatus)} aria-hidden />
                  <span className="text-text-muted">{statusLabel(subStatus)}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </motion.div>
  );
}

function SystemMetricsCard({ system, delay }: { system: Record<string, unknown>; delay: number }) {
  const cpu = system.cpu as Record<string, unknown> | undefined;
  const memory = system.memory as Record<string, unknown> | undefined;
  const disk = system.disk as Record<string, unknown> | undefined;
  const error = typeof system.error === 'string' ? system.error : undefined;

  const rows: { label: string; value: number }[] = [];
  if (cpu && typeof cpu.percent === 'number') rows.push({ label: 'CPU', value: cpu.percent });
  if (memory && typeof memory.percent === 'number') rows.push({ label: 'Memory', value: memory.percent });
  if (disk && typeof disk.percent === 'number') rows.push({ label: 'Disk', value: disk.percent });

  return (
    <motion.div {...fade(delay)} className="card p-5">
      <div className="flex items-center gap-2.5 mb-4">
        <span
          className="grid place-items-center w-9 h-9 rounded-xl text-text-secondary"
          style={{ background: 'rgb(var(--text-primary-rgb) / 0.06)' }}
        >
          <HardDrive className="w-4 h-4" aria-hidden />
        </span>
        <h3 className="font-display text-h3 font-semibold text-text-primary">System</h3>
      </div>
      {error ? (
        <p className="text-small conf-low">{error}</p>
      ) : rows.length === 0 ? (
        <p className="text-small text-text-muted">No system metrics reported.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={row.label}>
              <div className="flex items-center justify-between text-small mb-1.5">
                <span className="text-text-secondary">{row.label}</span>
                <span className="font-mono text-text-primary tabular-nums">{Math.round(row.value)}%</span>
              </div>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: 'rgb(var(--text-primary-rgb) / 0.08)' }}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.min(row.value, 100)}%`, background: meterColor(row.value) }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      {typeof system.platform === 'string' && (
        <p className="mt-3 text-small text-text-muted truncate" title={system.platform}>
          {system.platform}
        </p>
      )}
    </motion.div>
  );
}

export default function HealthPage() {
  const { data, isLoading, isFetching, isError, refetch } = useQuery({
    queryKey: ['health', 'detailed'],
    queryFn: () => healthApi.detailed(),
    refetchInterval: POLL_MS,
  });

  const components = data?.components ?? {};
  const entries = Object.entries(components);
  const vlmEntry = entries.find(([name]) => name.toLowerCase() === 'vlm');
  const systemEntry = entries.find(([name]) => name.toLowerCase() === 'system');
  const otherEntries = entries
    .filter(([name]) => !['vlm', 'system'].includes(name.toLowerCase()))
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Subheader */}
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-body text-text-secondary">
            Component readiness across the extraction pipeline — auto-refreshing every{' '}
            {POLL_MS / 1000}s.
          </p>
          <button onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5">
            <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </motion.div>

        {/* Overall status */}
        <motion.div {...fade(0.02)} className="card p-6 flex items-center gap-5">
          <span
            className="grid place-items-center w-14 h-14 rounded-2xl flex-shrink-0"
            style={{
              background:
                data?.status === 'healthy'
                  ? 'rgb(var(--accent-success-rgb) / 0.14)'
                  : 'rgb(var(--accent-warning-rgb) / 0.14)',
            }}
          >
            {isError ? (
              <AlertTriangle className="w-7 h-7 conf-low" aria-hidden />
            ) : data?.status === 'healthy' ? (
              <CheckCircle2 className="w-7 h-7 conf-high" aria-hidden />
            ) : (
              <AlertTriangle className="w-7 h-7 conf-med" aria-hidden />
            )}
          </span>
          <div className="min-w-0">
            <h1 className="font-display text-h1 font-semibold text-text-primary">
              {isError
                ? "Couldn't reach the health endpoint"
                : !data
                  ? 'Checking system health…'
                  : data.status === 'healthy'
                    ? 'All systems operational'
                    : 'Degraded'}
            </h1>
            <p className="mt-1 text-small text-text-muted">
              {isError
                ? '/health/detailed requires the system:metrics permission — confirm the caller is authenticated.'
                : data
                  ? `v${data.version} · last checked ${formatDateTime(data.timestamp)}`
                  : 'Waiting for the first probe.'}
            </p>
          </div>
        </motion.div>

        {/* VLM backend — shown prominently */}
        {vlmEntry &&
          (() => {
            const [, component] = vlmEntry;
            const status = normalizeStatus(component.status);
            const qwen = isQwenBackend(component);
            const model = typeof component.model === 'string' ? component.model : undefined;
            const provider = typeof component.provider === 'string' ? component.provider : undefined;
            const endpoint = typeof component.endpoint === 'string' ? component.endpoint : undefined;
            const connected = typeof component.connected === 'boolean' ? component.connected : undefined;
            const error = typeof component.error === 'string' ? component.error : undefined;

            return (
              <motion.div {...fade(0.05)} className="card p-6" style={{ borderColor: 'rgb(var(--accent-brand-rgb) / 0.3)' }}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="flex items-center gap-4 min-w-0">
                    <span
                      className="grid place-items-center w-14 h-14 rounded-2xl text-accent-brand flex-shrink-0"
                      style={{ background: 'rgb(var(--accent-brand-rgb) / 0.14)' }}
                    >
                      <Cpu className="w-7 h-7" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h2 className="font-display text-h2 font-semibold text-text-primary">
                          {qwen ? 'Qwen VLM Backend' : 'VLM Backend'}
                        </h2>
                        {qwen && <span className="badge-primary">Qwen</span>}
                        <span className={statusDotClass(status)} aria-hidden />
                      </div>
                      <p className="text-small text-text-muted mt-1 truncate">
                        {provider ? `provider: ${provider}` : 'primary vision-language extraction engine'}
                        {model ? ` · ${model}` : ''}
                      </p>
                    </div>
                  </div>
                  <span className={statusBadgeClass(status)}>{statusLabel(status)}</span>
                </div>

                {(endpoint || connected !== undefined || error) && (
                  <div className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {endpoint && <InfoTile label="Endpoint" value={endpoint} mono />}
                    {connected !== undefined && (
                      <InfoTile label="Connected" value={connected ? 'yes' : 'no'} error={!connected} />
                    )}
                    {error && <InfoTile label="Error" value={error} error />}
                  </div>
                )}
              </motion.div>
            );
          })()}

        {/* Component grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {isLoading
            ? Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="card p-5">
                  <div className="skeleton h-9 w-9 rounded-xl mb-3" />
                  <div className="skeleton h-4 w-24 mb-2" />
                  <div className="skeleton h-3 w-16" />
                </div>
              ))
            : (
                <>
                  {systemEntry && (
                    <SystemMetricsCard system={systemEntry[1] as Record<string, unknown>} delay={0.08} />
                  )}
                  {otherEntries.map(([name, component], i) => (
                    <ComponentCard
                      key={name}
                      name={name}
                      component={component as unknown as Record<string, unknown>}
                      delay={0.1 + i * 0.03}
                    />
                  ))}
                </>
              )}
          {!isLoading && !vlmEntry && !systemEntry && otherEntries.length === 0 && (
            <div className="col-span-full card p-10 text-center text-body text-text-muted">
              No component data reported yet.
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
