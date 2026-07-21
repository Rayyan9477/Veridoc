'use client';

import React, { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  FileJson,
  Layers,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { documentsApi } from '@/lib/api';
import { SourceViewTab } from '@/components/document/SourceViewTab';
import { cn, formatConfidence } from '@/lib/utils';
import type { FieldResult, ProcessResponse } from '@/types/api';

function confChip(c: number) {
  if (c >= 0.85) return 'conf-chip-high';
  if (c >= 0.5) return 'conf-chip-med';
  return 'conf-chip-low';
}

type TabKey = 'overview' | 'source' | 'fields' | 'json';

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'overview', label: 'Overview', icon: ShieldCheck },
  { key: 'source', label: 'Source view', icon: ScanSearch },
  { key: 'fields', label: 'Fields', icon: Layers },
  { key: 'json', label: 'Raw JSON', icon: FileJson },
];

export default function DocumentDetailPage() {
  const params = useParams();
  const qc = useQueryClient();
  const id = String(params?.id ?? '');
  const [tab, setTab] = useState<TabKey>('source');
  const [maskPhi, setMaskPhi] = useState(false);

  const { data, isLoading, error } = useQuery<ProcessResponse>({
    queryKey: ['document', id],
    queryFn: () => documentsApi.get(id),
    enabled: !!id,
  });

  const reextract = useMutation({
    mutationFn: () => documentsApi.reprocess(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['document', id] }),
  });

  const fields = data?.field_metadata ?? {};
  const fieldEntries = Object.entries(fields).sort(([, a], [, b]) => a.confidence - b.confidence);

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-3">
          <Link
            href="/documents"
            className="inline-flex items-center gap-1.5 text-small text-text-muted hover:text-text-secondary w-fit"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden /> Documents
          </Link>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <h1 className="font-display text-h1 font-semibold text-text-primary font-mono">
                {id.slice(0, 12)}…
              </h1>
              {data && (
                <>
                  <span className="badge-info">{data.status}</span>
                  <span className={confChip(data.overall_confidence)}>
                    {formatConfidence(data.overall_confidence)}
                  </span>
                  {data.requires_human_review && <span className="badge-warning">needs review</span>}
                </>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => setMaskPhi((v) => !v)} className="btn-secondary text-small px-3 py-1.5">
                {maskPhi ? <EyeOff className="w-4 h-4" aria-hidden /> : <Eye className="w-4 h-4" aria-hidden />}
                {maskPhi ? 'PHI masked' : 'Mask PHI'}
              </button>
              <button
                onClick={() => reextract.mutate()}
                disabled={reextract.isPending}
                className="btn-primary text-small px-3 py-1.5"
              >
                <RefreshCw className={cn('w-4 h-4', reextract.isPending && 'animate-spin')} aria-hidden />
                Re-extract
              </button>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="flex items-center gap-1 border-b border-border-default overflow-x-auto no-scrollbar">
          {TABS.map((t) => {
            const Icon = t.icon;
            const activeTab = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-current={activeTab ? 'page' : undefined}
                className={cn(
                  'relative inline-flex items-center gap-2 px-4 py-2.5 text-body whitespace-nowrap transition-colors duration-fast',
                  activeTab ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
                )}
              >
                <Icon className="w-4 h-4" aria-hidden /> {t.label}
                {activeTab && (
                  <span className="absolute left-2 right-2 -bottom-px h-0.5 rounded-full bg-accent-brand" aria-hidden />
                )}
              </button>
            );
          })}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className="skeleton w-full h-96" />
        ) : error ? (
          <div className="card p-10 text-center text-text-muted">Couldn&apos;t load this document.</div>
        ) : !data ? null : (
          <>
            {tab === 'overview' && <OverviewTab data={data} />}
            {tab === 'source' && <SourceViewTab processingId={id} />}
            {tab === 'fields' && <FieldsTab entries={fieldEntries} maskPhi={maskPhi} />}
            {tab === 'json' && <JsonTab data={data.data} />}
          </>
        )}
      </div>
    </AppLayout>
  );
}

function OverviewTab({ data }: { data: ProcessResponse }) {
  const m = data.metadata;
  const v = data.validation;
  const stats: { label: string; value: React.ReactNode }[] = [
    { label: 'Fields extracted', value: m?.fields_extracted ?? Object.keys(data.field_metadata ?? {}).length },
    { label: 'Overall confidence', value: formatConfidence(data.overall_confidence) },
    { label: 'Pages', value: m?.pages_processed ?? '—' },
    { label: 'VLM calls', value: m?.vlm_calls ?? '—' },
  ];
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="stat-card">
            <span className="stat-label">{s.label}</span>
            <span className="stat-value">{s.value}</span>
          </div>
        ))}
      </div>

      <div className="card p-5">
        <h2 className="font-display text-h3 font-semibold text-text-primary mb-4">Validation</h2>
        {v ? (
          <div className="grid sm:grid-cols-3 gap-4">
            <ValStat label="Hallucination flags" count={v.hallucination_flags?.length ?? 0} tone="danger" />
            <ValStat label="Warnings" count={v.warnings?.length ?? 0} tone="warning" />
            <ValStat label="Errors" count={v.errors?.length ?? 0} tone="danger" />
          </div>
        ) : (
          <p className="text-body text-text-muted">No validation report on this document.</p>
        )}
        {data.human_review_reason && (
          <p className="mt-4 text-small text-text-secondary">
            <span className="conf-low font-medium">Review reason:</span> {data.human_review_reason}
          </p>
        )}
      </div>
    </div>
  );
}

function ValStat({ label, count, tone }: { label: string; count: number; tone: 'danger' | 'warning' }) {
  const color = tone === 'danger' ? 'var(--accent-danger-rgb)' : 'var(--accent-warning-rgb)';
  return (
    <div className="glass-hairline rounded-xl p-4">
      <div
        className="text-2xl font-display font-semibold"
        style={{ color: count > 0 ? `rgb(${color})` : 'rgb(var(--accent-success-rgb))' }}
      >
        {count}
      </div>
      <div className="text-small text-text-muted mt-0.5">{label}</div>
    </div>
  );
}

function FieldsTab({ entries, maskPhi }: { entries: [string, FieldResult][]; maskPhi: boolean }) {
  if (entries.length === 0) {
    return <div className="card p-10 text-center text-text-muted">No fields extracted.</div>;
  }
  return (
    <div className="card overflow-hidden">
      <ul className="divide-y divide-border-default">
        {entries.map(([name, field]) => (
          <FieldRow key={name} name={name} field={field} maskPhi={maskPhi} />
        ))}
      </ul>
    </div>
  );
}

function FieldRow({ name, field, maskPhi }: { name: string; field: FieldResult; maskPhi: boolean }) {
  const [open, setOpen] = useState(false);
  const cls = field.confidence >= 0.85 ? 'conf-chip-high' : field.confidence >= 0.5 ? 'conf-chip-med' : 'conf-chip-low';
  const value = maskPhi
    ? '••••••••'
    : typeof field.value === 'object'
      ? JSON.stringify(field.value)
      : String(field.value ?? 'N/A');
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full text-left px-4 py-3 hover:bg-white/5 transition-colors duration-fast"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown className="w-4 h-4 text-text-muted shrink-0" aria-hidden />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted shrink-0" aria-hidden />
          )}
          <span className="font-mono text-body text-text-primary truncate flex-1">{name}</span>
          {!field.passes_agree && <span className="badge-warning">passes disagree</span>}
          <span className={cls}>{(field.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="pl-7 mt-1 font-mono text-small text-text-secondary truncate">{value}</div>
        {open && (
          <div className="pl-7 mt-3 grid sm:grid-cols-3 gap-2 text-small">
            <Meta label="Location" value={field.location || '—'} />
            <Meta label="Passes agree" value={field.passes_agree ? 'yes' : 'no'} />
            <Meta label="Validation" value={field.validation_passed ? 'passed' : 'review'} />
          </div>
        )}
      </button>
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-text-muted">{label}</span>
      <span className="text-text-secondary font-mono">{value}</span>
    </div>
  );
}

function JsonTab({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data ?? {}, null, 2);
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
        <span className="text-small text-text-muted font-mono">extraction.json</span>
        <button
          onClick={() => navigator.clipboard?.writeText(json)}
          className="btn-ghost text-small px-2.5 py-1"
        >
          <Copy className="w-3.5 h-3.5" aria-hidden /> Copy
        </button>
      </div>
      <pre className="p-4 overflow-auto text-small font-mono text-text-secondary max-h-[640px]">{json}</pre>
    </div>
  );
}
