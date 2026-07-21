'use client';

import React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import {
  ClipboardCheck,
  Cpu,
  FileText,
  RefreshCw,
  ShieldCheck,
  Timer,
  Upload,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { useDashboardData } from '@/hooks/useDashboard';
import { cn, formatDuration, formatPercentage } from '@/lib/utils';
import type { RecentActivity, TaskStatusResponse } from '@/types/api';

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
  delay = 0,
}: {
  label: string;
  value: React.ReactNode;
  icon: React.ComponentType<{ className?: string }>;
  hint?: string;
  delay?: number;
}) {
  return (
    <motion.div {...fade(delay)} className="stat-card">
      <div className="flex items-center justify-between">
        <span className="stat-label">{label}</span>
        <span
          className="grid place-items-center w-8 h-8 rounded-lg text-accent-brand"
          style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
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
  className,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('card p-5', className)}>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-h3 font-display font-semibold text-text-primary">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  );
}

function statusTone(status?: string) {
  const s = (status ?? '').toLowerCase();
  if (['completed', 'success', 'successful'].includes(s)) return 'status-dot-success';
  if (['failed', 'error', 'failure'].includes(s)) return 'status-dot-error';
  if (!status) return 'status-dot-info';
  return 'status-dot-warning';
}

function meterColor(v: number) {
  if (v > 85) return 'rgb(var(--accent-danger-rgb))';
  if (v > 60) return 'rgb(var(--accent-warning-rgb))';
  return 'rgb(var(--accent-success-rgb))';
}

export default function DashboardPage() {
  const { metrics, activity, activeTasks, isLoading } = useDashboardData();
  const m = metrics.data;
  const tasks = (activeTasks.data ?? []) as TaskStatusResponse[];
  const acts = (activity.data ?? []) as RecentActivity[];
  const sys = m?.system;

  const refresh = () => {
    metrics.refetch();
    activity.refetch();
    activeTasks.refetch();
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Subheader */}
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-body text-text-secondary">
            Throughput, confidence, and live extractions.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={refresh} className="btn-secondary text-small px-3 py-1.5">
              <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} aria-hidden />
              Refresh
            </button>
            <Link href="/documents/upload" className="btn-primary text-small px-3 py-1.5">
              <Upload className="w-4 h-4" aria-hidden />
              Upload
            </Link>
          </div>
        </motion.div>

        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            delay={0.02}
            label="Documents · today"
            icon={FileText}
            value={m?.documents_processed_today ?? 0}
            hint={`${m?.documents_processed_week ?? 0} this week`}
          />
          <StatCard
            delay={0.06}
            label="Avg extract"
            icon={Timer}
            value={m ? formatDuration(m.average_processing_time) : '—'}
            hint="per document"
          />
          <StatCard
            delay={0.1}
            label="Success rate"
            icon={ShieldCheck}
            value={m ? formatPercentage(m.success_rate) : '—'}
            hint="post-critic"
          />
          <StatCard
            delay={0.14}
            label="HITL queue"
            icon={ClipboardCheck}
            value={m?.human_review_pending ?? 0}
            hint="awaiting review"
          />
        </div>

        {/* Active extractions + system health */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <motion.div {...fade(0.06)} className="lg:col-span-2">
            <Panel
              title="Active extractions"
              action={
                <Link href="/tasks" className="text-small text-accent-brand">
                  View queue →
                </Link>
              }
            >
              {tasks.length === 0 ? (
                <div className="py-10 text-center text-body text-text-muted">
                  No live extractions right now.
                </div>
              ) : (
                <div className="space-y-1">
                  {tasks.slice(0, 6).map((t) => {
                    const pct = t.progress
                      ? Math.round((t.progress.current / Math.max(t.progress.total, 1)) * 100)
                      : undefined;
                    return (
                      <div
                        key={t.task_id}
                        className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-colors"
                      >
                        <span className={statusTone(t.status)} />
                        <span className="font-mono text-small text-text-secondary">
                          #{t.task_id.slice(0, 8)}
                        </span>
                        <span className="flex-1 text-body text-text-primary truncate">
                          {t.progress?.stage ?? t.status}
                        </span>
                        {pct !== undefined && (
                          <div
                            className="w-28 h-1.5 rounded-full overflow-hidden"
                            style={{ background: 'rgb(var(--text-primary-rgb) / 0.08)' }}
                          >
                            <div
                              className="h-full rounded-full bg-accent-brand"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        )}
                        <span className="badge-info">{t.status}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </motion.div>

          <motion.div {...fade(0.1)}>
            <Panel title="System health">
              {sys ? (
                <div className="space-y-4">
                  {[
                    { label: 'CPU', value: sys.cpu_usage, icon: true },
                    { label: 'Memory', value: sys.memory_usage },
                    { label: 'Disk', value: sys.disk_usage },
                  ].map((row) => (
                    <div key={row.label}>
                      <div className="flex items-center justify-between text-small mb-1.5">
                        <span className="inline-flex items-center gap-1.5 text-text-secondary">
                          {row.icon && <Cpu className="w-3.5 h-3.5" aria-hidden />}
                          {row.label}
                        </span>
                        <span className="font-mono text-text-primary">{Math.round(row.value)}%</span>
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
              ) : (
                <div className="py-10 text-center text-body text-text-muted">
                  Metrics unavailable.
                </div>
              )}
            </Panel>
          </motion.div>
        </div>

        {/* Recent activity */}
        <motion.div {...fade(0.14)}>
          <Panel
            title="Recent activity"
            action={<span className="text-small text-text-muted">last 24 hours</span>}
          >
            {acts.length === 0 ? (
              <div className="py-10 text-center text-body text-text-muted">
                No recent activity yet — run an extraction to see it here.
              </div>
            ) : (
              <div className="divide-y divide-border-default">
                {acts.map((a) => (
                  <div key={a.id} className="flex items-center gap-3 py-2.5">
                    <span className={statusTone(a.status)} />
                    <span className="flex-1 text-body text-text-primary">{a.description}</span>
                    {a.document_name && (
                      <span className="text-small font-mono text-text-muted">{a.document_name}</span>
                    )}
                    <span className="text-small text-text-muted">
                      {new Date(a.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </motion.div>
      </div>
    </AppLayout>
  );
}
