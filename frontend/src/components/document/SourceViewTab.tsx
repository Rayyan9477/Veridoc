'use client';

/**
 * Source View — the headline "click-to-source" interaction.
 *
 * A rendered document page (server PNG) with an SVG bbox overlay, side-by-side
 * with the extracted-field list. Two-way highlighting: click a field → the
 * canvas pages to it and lights its bbox; click a bbox → the field expands
 * with its provenance timeline (Pass 1 → Pass 2 → Reconciler → Critic).
 *
 * Confidence uses the product's calibrated-confidence color language
 * (emerald ≥ 0.85, amber 0.5–0.85, rose < 0.5).
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  ApiError,
  fetchProvenance,
  isProvenanceEmpty,
  type FieldProvenance,
} from '@/lib/api/provenance';
import { BRANDING } from '@/lib/branding';
import { PdfPageCanvas } from './PdfPageCanvas';
import { ProvenanceTimeline } from './ProvenanceTimeline';
import { ProvenanceProvider, useProvenance } from './ProvenanceContext';

interface SourceViewTabProps {
  processingId: string;
}

function confClass(c: number) {
  if (c >= 0.85) return 'conf-chip-high';
  if (c >= 0.5) return 'conf-chip-med';
  return 'conf-chip-low';
}

export function SourceViewTab({ processingId }: SourceViewTabProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['provenance', processingId],
    queryFn: () => fetchProvenance(processingId),
    retry: (count, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return count < 2;
    },
  });

  if (isLoading) {
    return <div className="skeleton w-full h-[800px]" />;
  }

  if ((error instanceof ApiError && error.status === 404) || error || isProvenanceEmpty(data)) {
    return <SourceViewEmptyState />;
  }

  return (
    <ProvenanceProvider provenance={data!}>
      <SourceViewLayout processingId={processingId} />
    </ProvenanceProvider>
  );
}

function SourceViewEmptyState() {
  return (
    <div className="card p-10 text-center">
      <span className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
        style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}>
        <Info className="w-6 h-6" aria-hidden />
      </span>
      <h3 className="font-display text-h3 font-semibold text-text-primary">Source view unavailable</h3>
      <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
        Source view needs the dual-VLM extraction engine with provenance enabled
        (<span className="font-mono text-small">EXTRACTION_ENGINE=dual_vlm</span> + checkpointing).
        Documents extracted under the legacy single-VLM mode don&apos;t carry per-field source links.
      </p>
      <a
        href={BRANDING.docsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-secondary text-small px-3 py-1.5 mt-5 inline-flex"
      >
        Learn more
      </a>
    </div>
  );
}

function SourceViewLayout({ processingId }: { processingId: string }) {
  const { provenance, currentPage, setCurrentPage } = useProvenance();

  const totalPages = useMemo(() => {
    if (!provenance) return 1;
    let max = 1;
    for (const p of Object.values(provenance.fields)) {
      if (p.page && p.page > max) max = p.page;
      if (p.bbox?.page && p.bbox.page > max) max = p.bbox.page;
    }
    return max;
  }, [provenance]);

  if (!provenance) return null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
      {/* Canvas + page navigator (60%) */}
      <div className="lg:col-span-3 space-y-3">
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost p-1.5 disabled:opacity-40"
            aria-label="Previous page"
            disabled={currentPage <= 1}
            onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
          >
            <ChevronLeft className="w-4 h-4" aria-hidden />
          </button>
          <span className="text-body text-text-secondary tabular-nums">
            Page {currentPage} of {totalPages}
          </span>
          <button
            className="btn-ghost p-1.5 disabled:opacity-40"
            aria-label="Next page"
            disabled={currentPage >= totalPages}
            onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
          >
            <ChevronRight className="w-4 h-4" aria-hidden />
          </button>
        </div>
        <div className="card p-4 flex justify-center overflow-auto">
          <SourceViewCanvas processingId={processingId} pageNumber={currentPage} />
        </div>
      </div>

      {/* Field list + active provenance timeline (40%) */}
      <div className="lg:col-span-2">
        <SourceViewFieldList />
      </div>
    </div>
  );
}

function SourceViewCanvas({ processingId, pageNumber }: { processingId: string; pageNumber: number }) {
  const { provenance, activeFieldName, setActiveFieldName } = useProvenance();
  if (!provenance) return null;
  return (
    <PdfPageCanvas
      processingId={processingId}
      pageNumber={pageNumber}
      fields={provenance.fields}
      activeFieldName={activeFieldName}
      onSelectField={setActiveFieldName}
    />
  );
}

function SourceViewFieldList() {
  const { provenance, activeFieldName, setActiveFieldName, activeField } = useProvenance();
  if (!provenance) return null;

  // Lowest-confidence first — where the reviewer's attention matters most.
  const fieldEntries = Object.entries(provenance.fields).sort(
    ([, a], [, b]) => a.confidence - b.confidence,
  );

  return (
    <div className="space-y-3">
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-border-default">
          <h2 className="font-display text-h3 font-semibold text-text-primary">
            Fields ({fieldEntries.length})
          </h2>
          <span className="text-small text-text-muted">low confidence first</span>
        </div>
        <ul className="divide-y divide-border-default max-h-[640px] overflow-y-auto no-scrollbar">
          {fieldEntries.map(([name, field]) => (
            <FieldRow
              key={name}
              name={name}
              field={field}
              active={name === activeFieldName}
              onClick={() => setActiveFieldName(name)}
            />
          ))}
        </ul>
      </div>

      {activeField && (
        <div className="card p-4">
          <h2 className="font-display text-h3 font-semibold text-text-primary">Provenance timeline</h2>
          <p className="text-small text-text-secondary font-mono mt-0.5">{activeField.field_name}</p>
          <div className="mt-3">
            <ProvenanceTimeline field={activeField} />
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  name,
  field,
  active,
  onClick,
}: {
  name: string;
  field: FieldProvenance;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'relative w-full text-left px-4 py-3 transition-colors duration-fast hover:bg-white/5',
        )}
        style={active ? { background: 'rgb(var(--accent-brand-rgb) / 0.1)' } : undefined}
      >
        {active && (
          <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-r-full bg-accent-brand" aria-hidden />
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="font-mono text-body text-text-primary truncate">{name}</span>
          <span className={confClass(field.confidence)}>{(field.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-small text-text-muted">
          <span>Page {field.page}</span>
          {field.vlm_model_id && (
            <>
              <span aria-hidden>·</span>
              <span className="truncate font-mono">{field.vlm_model_id}</span>
            </>
          )}
        </div>
      </button>
    </li>
  );
}
