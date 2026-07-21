'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { Activity, Gauge, Layers, RefreshCw, Server, Upload, X, Zap } from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { queueApi, tasksApi } from '@/lib/api';
import { cn, formatDuration } from '@/lib/utils';
import type { QueueStats, TaskStatusResponse, WorkerStatus } from '@/types/api';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const POLL_MS = 3000;

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

function statusTone(status?: string) {
  const s = (status ?? '').toLowerCase();
  if (['completed', 'success', 'successful'].includes(s)) return 'status-dot-success';
  if (['failed', 'error', 'failure', 'cancelled'].includes(s)) return 'status-dot-error';
  if (!status) return 'status-dot-info';
  return 'status-dot-warning';
}

export default function TasksPage() {
  const qc = useQueryClient();

  // retry:false — the queue endpoints degrade slowly when no broker is
  // present (dev without Redis); don't amplify that with retries.
  const statsQuery = useQuery<QueueStats[]>({
    queryKey: ['queue', 'stats'],
    queryFn: () => queueApi.getStats(),
    refetchInterval: POLL_MS,
    retry: false,
  });
  const workersQuery = useQuery<WorkerStatus[]>({
    queryKey: ['queue', 'workers'],
    queryFn: () => queueApi.getWorkers(),
    refetchInterval: POLL_MS,
    retry: false,
  });
  const tasksQuery = useQuery<TaskStatusResponse[]>({
    queryKey: ['tasks', 'active'],
    queryFn: () => tasksApi.listActive(),
    refetchInterval: POLL_MS,
    retry: false,
  });

  const cancelMutation = useMutation({
    mutationFn: (taskId: string) => tasksApi.cancel(taskId),
    onSuccess: () => {
      toast.success('Task cancelled');
      qc.invalidateQueries({ queryKey: ['tasks', 'active'] });
    },
    onError: () => toast.error('Failed to cancel task'),
  });

  const stats = statsQuery.data ?? [];
  const workers = workersQuery.data ?? [];
  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);

  // Defensive numeric coercion — a missing/non-numeric field must never
  // propagate NaN into a rendered value or a motion attribute.
  const queueDepth = stats.reduce((sum, q) => sum + (Number(q.pending) || 0), 0);
  const workersOnline = workers.filter((w) => w.status === 'online').length;
  const backpressure = stats.reduce(
    (sum, q) => sum + (Number(q.reserved) || 0) + (Number(q.scheduled) || 0),
    0,
  );
  const throughput = workers.reduce((sum, w) => sum + (Number(w.processed) || 0), 0);

  // TaskStatusResponse carries no start timestamp, so "elapsed" is tracked
  // client-side from the moment we first observed each task in this poll
  // loop — real wall-clock time, just not the true server-side start time.
  const firstSeenRef = useRef<Map<string, number>>(new Map());
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const now = Date.now();
    const activeIds = new Set(tasks.map((t) => t.task_id));
    for (const t of tasks) {
      if (!firstSeenRef.current.has(t.task_id)) {
        firstSeenRef.current.set(t.task_id, now);
      }
    }
    for (const id of Array.from(firstSeenRef.current.keys())) {
      if (!activeIds.has(id)) firstSeenRef.current.delete(id);
    }
  }, [tasks]);

  const elapsedFor = (taskId: string): string => {
    const start = firstSeenRef.current.get(taskId);
    if (!start) return '—';
    return formatDuration(Date.now() - start);
  };

  const refresh = () => {
    statsQuery.refetch();
    workersQuery.refetch();
    tasksQuery.refetch();
  };

  const isRefreshing = statsQuery.isFetching || workersQuery.isFetching || tasksQuery.isFetching;

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Subheader */}
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-body text-text-secondary">
            Live extraction queue — polling every {POLL_MS / 1000}s.
          </p>
          <button onClick={refresh} className="btn-secondary text-small px-3 py-1.5">
            <RefreshCw className={cn('w-4 h-4', isRefreshing && 'animate-spin')} aria-hidden />
            Refresh
          </button>
        </motion.div>

        {/* KPI row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            delay={0.02}
            label="Queue depth"
            icon={Layers}
            value={queueDepth}
            hint="pending across queues"
          />
          <StatCard
            delay={0.06}
            label="Workers active"
            icon={Server}
            value={`${workersOnline}/${workers.length}`}
            hint="online workers"
          />
          <StatCard
            delay={0.1}
            label="Backpressure"
            icon={Gauge}
            value={backpressure}
            hint="reserved + scheduled"
          />
          <StatCard
            delay={0.14}
            label="Throughput"
            icon={Zap}
            value={throughput}
            hint="processed (lifetime)"
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Task table */}
          <motion.div {...fade(0.06)} className="lg:col-span-2 card overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
              <h2 className="font-display text-h3 font-semibold text-text-primary">
                Active tasks ({tasks.length})
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-border-default text-small text-text-muted uppercase tracking-wide">
                    <th className="px-4 py-3 font-medium">Task</th>
                    <th className="px-4 py-3 font-medium">Stage</th>
                    <th className="px-4 py-3 font-medium">Profile</th>
                    <th className="px-4 py-3 font-medium">Elapsed</th>
                    <th className="px-4 py-3 font-medium">Progress</th>
                    <th className="px-4 py-3 font-medium text-right">Cancel</th>
                  </tr>
                </thead>
                <tbody>
                  {tasksQuery.isLoading ? (
                    Array.from({ length: 3 }).map((_, i) => (
                      <tr key={i} className="border-b border-border-default last:border-0">
                        <td className="px-4 py-3" colSpan={6}>
                          <div className="skeleton h-5 w-full" />
                        </td>
                      </tr>
                    ))
                  ) : tasks.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-14">
                        <div className="flex flex-col items-center text-center gap-3">
                          <span
                            className="grid place-items-center w-12 h-12 rounded-xl text-accent-brand"
                            style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                          >
                            <Activity className="w-6 h-6" aria-hidden />
                          </span>
                          <div>
                            <p className="text-body text-text-primary font-medium">
                              Queue is idle — nothing extracting right now.
                            </p>
                            <p className="mt-1 text-small text-text-muted max-w-md">
                              Upload a document to see it move through the pipeline here.
                            </p>
                          </div>
                          <Link href="/documents/upload" className="btn-secondary text-small px-3 py-1.5 mt-1">
                            <Upload className="w-4 h-4" aria-hidden />
                            Upload a document
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    tasks.map((t) => {
                      const pct = t.progress
                        ? Math.round((t.progress.current / Math.max(t.progress.total, 1)) * 100)
                        : undefined;
                      return (
                        <tr
                          key={t.task_id}
                          className="border-b border-border-default last:border-0 hover:bg-white/5 transition-colors"
                        >
                          <td className="px-4 py-3 font-mono text-small text-text-secondary">
                            #{t.task_id.slice(0, 8)}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <span className={statusTone(t.status)} />
                              <span className="text-body text-text-primary truncate">
                                {t.progress?.stage ?? t.status}
                              </span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-small text-text-muted">—</td>
                          <td className="px-4 py-3 font-mono text-small text-text-secondary tabular-nums">
                            {elapsedFor(t.task_id)}
                          </td>
                          <td className="px-4 py-3 w-44">
                            {pct !== undefined ? (
                              <div className="flex items-center gap-2">
                                <div
                                  className="flex-1 h-1.5 rounded-full overflow-hidden"
                                  style={{ background: 'rgb(var(--text-primary-rgb) / 0.08)' }}
                                >
                                  <div
                                    className="h-full rounded-full bg-accent-brand"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                                <span className="text-small text-text-muted tabular-nums w-9 text-right">
                                  {pct}%
                                </span>
                              </div>
                            ) : (
                              <span className="text-small text-text-muted">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => cancelMutation.mutate(t.task_id)}
                              disabled={cancelMutation.isPending}
                              className="btn-ghost p-1.5"
                              aria-label={`Cancel task ${t.task_id}`}
                            >
                              <X className="w-4 h-4" aria-hidden />
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </motion.div>

          {/* Workers */}
          <motion.div {...fade(0.1)} className="card p-5">
            <h2 className="font-display text-h3 font-semibold text-text-primary mb-4">Workers</h2>
            {workersQuery.isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="skeleton h-14 w-full" />
                ))}
              </div>
            ) : workers.length === 0 ? (
              <div className="py-10 text-center text-body text-text-muted">No workers online.</div>
            ) : (
              <div className="space-y-3">
                {workers.map((w) => (
                  <div key={w.name} className="rounded-xl p-3 glass-hairline">
                    <div className="flex items-center justify-between mb-2">
                      <span className="inline-flex items-center gap-1.5 text-body text-text-primary truncate">
                        <span className={w.status === 'online' ? 'status-dot-success' : 'status-dot-error'} />
                        {w.name}
                      </span>
                      <span className={w.status === 'online' ? 'badge-success' : 'badge-error'}>
                        {w.status}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-small">
                      <div>
                        <p className="font-mono text-text-primary tabular-nums">{w.active_tasks}</p>
                        <p className="text-text-muted">active</p>
                      </div>
                      <div>
                        <p className="font-mono conf-high tabular-nums">{w.processed}</p>
                        <p className="text-text-muted">done</p>
                      </div>
                      <div>
                        <p className="font-mono conf-low tabular-nums">{w.failed}</p>
                        <p className="text-text-muted">failed</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </AppLayout>
  );
}
