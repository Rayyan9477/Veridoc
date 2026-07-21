'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Database,
  FileSignature,
  Filter,
  GitCompare,
  Package,
  RefreshCw,
  RotateCcw,
  ShieldOff,
  Upload,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { documentsApi } from '@/lib/api';
import { cn, formatConfidence, formatDuration } from '@/lib/utils';
import { MODE_LABELS, type ModeKey } from '@/lib/branding';
import type { ConfidenceLevel, ProcessResponse, TaskStatus } from '@/types/api';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const STATUS_OPTIONS: TaskStatus[] = [
  'pending',
  'started',
  'processing',
  'validating',
  'exporting',
  'completed',
  'failed',
  'retrying',
  'cancelled',
];

const CONFIDENCE_OPTIONS: ConfidenceLevel[] = ['high', 'medium', 'low'];

function confChipClass(confidence: number) {
  if (confidence >= 0.85) return 'conf-chip-high';
  if (confidence >= 0.5) return 'conf-chip-med';
  return 'conf-chip-low';
}

function statusBadgeClass(status: string) {
  const s = status.toLowerCase();
  if (s === 'completed') return 'badge-success';
  if (s === 'failed' || s === 'cancelled') return 'badge-error';
  if (s === 'retrying') return 'badge-warning';
  if (s === 'pending') return 'badge-info';
  return 'badge-primary';
}

function getStringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = obj ? obj[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function docFilename(doc: ProcessResponse): string {
  return (
    getStringField(doc.data, 'filename') ??
    getStringField(doc.data, 'file_name') ??
    doc.output_path?.split(/[\\/]/).pop() ??
    doc.processing_id
  );
}

function docProfile(doc: ProcessResponse): string {
  return getStringField(doc.data, 'profile') ?? getStringField(doc.data, 'schema_name') ?? '—';
}

function docType(doc: ProcessResponse): string {
  return getStringField(doc.data, 'document_type') ?? '—';
}

export default function DocumentsPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profileFilter, setProfileFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [confidenceFilter, setConfidenceFilter] = useState('');

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['documents', 'recent'],
    queryFn: () => documentsApi.listRecent(),
  });

  const documents = data ?? [];
  const filtered = documents.filter((doc) => {
    if (statusFilter && doc.status !== statusFilter) return false;
    if (confidenceFilter && doc.confidence_level !== confidenceFilter) return false;
    if (profileFilter && docProfile(doc) !== profileFilter) return false;
    return true;
  });

  const reextractMutation = useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => documentsApi.reprocess(id))),
    onSuccess: () => {
      toast.success('Re-extraction queued');
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: () => toast.error('Failed to queue re-extraction'),
  });

  const allSelected = filtered.length > 0 && filtered.every((d) => selected.has(d.processing_id));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(filtered.map((d) => d.processing_id)));
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const comingSoon = (label: string) => toast(`${label} isn't wired up yet — coming soon.`, { icon: '🚧' });

  return (
    <AppLayout>
      <div className="space-y-6">
        {/* Subheader */}
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <p className="text-body text-text-secondary">
            Extracted documents, their confidence, and where they stand.
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5">
              <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} aria-hidden />
              Refresh
            </button>
            <Link href="/documents/upload" className="btn-primary text-small px-3 py-1.5">
              <Upload className="w-4 h-4" aria-hidden />
              Upload
            </Link>
          </div>
        </motion.div>

        {/* Filters row */}
        <motion.div {...fade(0.03)} className="card p-4 flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-small text-text-muted">
            <Filter className="w-3.5 h-3.5" aria-hidden />
            Filters
          </span>
          <select
            aria-label="Filter by profile"
            className="input w-auto py-1.5 text-small"
            value={profileFilter}
            onChange={(e) => setProfileFilter(e.target.value)}
          >
            <option value="">All profiles</option>
            {(Object.keys(MODE_LABELS) as ModeKey[]).map((key) => (
              <option key={key} value={MODE_LABELS[key].label}>
                {MODE_LABELS[key].label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            className="input w-auto py-1.5 text-small"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by confidence"
            className="input w-auto py-1.5 text-small"
            value={confidenceFilter}
            onChange={(e) => setConfidenceFilter(e.target.value)}
          >
            <option value="">All confidence</option>
            {CONFIDENCE_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <span className="ml-auto text-small text-text-muted">
            {filtered.length} document{filtered.length === 1 ? '' : 's'}
          </span>
        </motion.div>

        {/* Bulk action toolbar */}
        <AnimatePresence>
          {selected.size > 0 && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="card p-3 flex flex-wrap items-center gap-2 overflow-hidden"
              style={{ borderColor: 'rgb(var(--accent-brand-rgb) / 0.35)' }}
            >
              <span className="text-small text-text-secondary px-1">
                {selected.size} selected
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <button
                  onClick={() => reextractMutation.mutate(Array.from(selected))}
                  disabled={reextractMutation.isPending}
                  className="btn-secondary text-small px-3 py-1.5"
                >
                  <RotateCcw
                    className={cn('w-4 h-4', reextractMutation.isPending && 'animate-spin')}
                    aria-hidden
                  />
                  Re-extract
                </button>
                <button
                  onClick={() => comingSoon('Mask PHI')}
                  className="btn-secondary text-small px-3 py-1.5"
                >
                  <ShieldOff className="w-4 h-4" aria-hidden />
                  Mask PHI
                </button>
                <button
                  onClick={() => comingSoon('Bundle')}
                  className="btn-secondary text-small px-3 py-1.5"
                >
                  <Package className="w-4 h-4" aria-hidden />
                  Bundle
                </button>
                <button
                  onClick={() => comingSoon('Sign receipt')}
                  className="btn-secondary text-small px-3 py-1.5"
                >
                  <FileSignature className="w-4 h-4" aria-hidden />
                  Sign receipt
                </button>
                <button
                  onClick={() => comingSoon('Compare')}
                  className="btn-secondary text-small px-3 py-1.5"
                >
                  <GitCompare className="w-4 h-4" aria-hidden />
                  Compare
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <motion.div {...fade(0.06)} className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-border-default text-small text-text-muted uppercase tracking-wide">
                  <th className="w-10 px-4 py-3">
                    <input
                      type="checkbox"
                      aria-label="Select all documents"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={filtered.length === 0}
                      className="rounded"
                    />
                  </th>
                  <th className="px-4 py-3 font-medium">Filename</th>
                  <th className="px-4 py-3 font-medium">Profile</th>
                  <th className="px-4 py-3 font-medium">Doc type</th>
                  <th className="px-4 py-3 font-medium">Confidence</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i} className="border-b border-border-default last:border-0">
                      <td className="px-4 py-3" colSpan={7}>
                        <div className="skeleton h-5 w-full" />
                      </td>
                    </tr>
                  ))
                ) : filtered.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-14">
                      <div className="flex flex-col items-center text-center gap-3">
                        <span
                          className="grid place-items-center w-12 h-12 rounded-xl text-accent-brand"
                          style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                        >
                          <Database className="w-6 h-6" aria-hidden />
                        </span>
                        <div>
                          <p className="text-body text-text-primary font-medium">
                            No documents endpoint wired yet — GET /documents (coming soon)
                          </p>
                          <p className="mt-1 text-small text-text-muted max-w-md">
                            Upload a document to kick off an extraction, then track its progress from
                            Tasks. Once it lands here, this table will list every processed document.
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
                  filtered.map((doc) => (
                    <tr
                      key={doc.processing_id}
                      className="border-b border-border-default last:border-0 hover:bg-white/5 transition-colors"
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          aria-label={`Select ${docFilename(doc)}`}
                          checked={selected.has(doc.processing_id)}
                          onChange={() => toggleOne(doc.processing_id)}
                          className="rounded"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/documents/${doc.processing_id}`}
                          className="text-body text-text-primary hover:text-accent-brand transition-colors truncate"
                        >
                          {docFilename(doc)}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-body text-text-secondary">{docProfile(doc)}</td>
                      <td className="px-4 py-3 text-body text-text-secondary">{docType(doc)}</td>
                      <td className="px-4 py-3">
                        <span className={confChipClass(doc.overall_confidence)}>
                          {formatConfidence(doc.overall_confidence)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={statusBadgeClass(doc.status)}>{doc.status}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-small text-text-secondary tabular-nums">
                        {doc.metadata?.processing_time_ms
                          ? formatDuration(doc.metadata.processing_time_ms)
                          : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      </div>
    </AppLayout>
  );
}
