'use client';

/**
 * HITL review — the human-in-the-loop queue.
 *
 * The queue is real: `GET /api/v1/review/queue` derives it live from the
 * result store (documents whose stored result has
 * `requires_human_review == true`), worst confidence first.
 *
 * Approve/reject are deliberately local-only. Resolving a review means
 * resuming the orchestrator from a paused LangGraph checkpoint with human
 * corrections — state that isn't guaranteed to exist in every deployment
 * — so rather than POST to an endpoint that would silently no-op, the
 * decision is recorded in local state and the UI says exactly that.
 */

import { useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Check, ClipboardCheck, ExternalLink, Inbox, X } from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { fetchReviewQueue, type FlaggedField, type ReviewQueueDoc } from '@/lib/api/workspace';
import { cn } from '@/lib/utils';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ['j', 'k'], label: 'Next / previous document' },
  { keys: ['a'], label: 'Approve flagged fields' },
  { keys: ['e'], label: 'Edit a field value' },
  { keys: ['r'], label: 'Reject document' },
  { keys: ['g'], label: 'Jump to next flagged doc' },
];

function confClass(c: number) {
  if (c >= 0.85) return 'conf-chip-high';
  if (c >= 0.5) return 'conf-chip-med';
  return 'conf-chip-low';
}

export default function ReviewPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['review-queue'],
    queryFn: fetchReviewQueue,
  });

  // Approve/reject are recorded locally only (see file header). Decided
  // docs drop out of the visible queue.
  const [decisions, setDecisions] = useState<Record<string, 'approved' | 'rejected'>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const queue = (data ?? []).filter((d) => !decisions[d.id]);
  const selectedDoc = queue.find((d) => d.id === selectedId) ?? null;

  const decide = (doc: ReviewQueueDoc, decision: 'approved' | 'rejected') => {
    setDecisions((prev) => ({ ...prev, [doc.id]: decision }));
    if (selectedId === doc.id) setSelectedId(null);
    toast(
      `${decision === 'approved' ? 'Approved' : 'Rejected'} “${doc.filename}” locally — not yet sent to the extraction pipeline.`,
      { icon: decision === 'approved' ? '✅' : '🚫' },
    );
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div {...fade(0)} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-body text-text-secondary">
            Documents with low-confidence or contested fields, queued for a human decision.
          </p>
          <span className="badge-info">{queue.length} pending</span>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Queue (left pane) */}
          <motion.div {...fade(0.04)} className="lg:col-span-2">
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-border-default">
                <h2 className="font-display text-h3 font-semibold text-text-primary">Review queue</h2>
                <span className="text-small text-text-muted">worst confidence first</span>
              </div>

              {isLoading ? (
                <div className="p-2 space-y-1.5">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="skeleton h-14 w-full" />
                  ))}
                </div>
              ) : error ? (
                <div className="p-10 text-center">
                  <p className="text-body text-text-secondary">Couldn’t load the review queue.</p>
                  <button onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5 mt-3">
                    Try again
                  </button>
                </div>
              ) : queue.length === 0 ? (
                <div className="p-10 text-center">
                  <span
                    className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
                    style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                  >
                    <Inbox className="w-6 h-6" aria-hidden />
                  </span>
                  <h3 className="font-display text-h3 font-semibold text-text-primary">
                    No documents in review
                  </h3>
                  <p className="mt-2 text-body text-text-secondary">
                    Nothing is flagged for human review right now.
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border-default max-h-[640px] overflow-y-auto no-scrollbar">
                  {queue.map((doc) => (
                    <QueueRow
                      key={doc.id}
                      doc={doc}
                      active={doc.id === selectedId}
                      onClick={() => setSelectedId(doc.id)}
                    />
                  ))}
                </ul>
              )}
            </div>
          </motion.div>

          {/* Detail + legend (right pane) */}
          <motion.div {...fade(0.08)} className="lg:col-span-3 space-y-4">
            <div className="card p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display text-h3 font-semibold text-text-primary">Flagged fields</h2>
                {selectedDoc && (
                  <span className="badge-warning">{selectedDoc.flaggedFields.length} flagged</span>
                )}
              </div>

              {selectedDoc ? (
                <>
                  {selectedDoc.reason && (
                    <p className="mb-3 text-small text-text-muted">{selectedDoc.reason}</p>
                  )}
                  {selectedDoc.flaggedFields.length > 0 ? (
                    <ul className="divide-y divide-border-default">
                      {selectedDoc.flaggedFields.map((field) => (
                        <FlaggedFieldRow key={field.name} field={field} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-body text-text-secondary">
                      No individual fields were flagged — the whole document is queued for review.
                    </p>
                  )}
                </>
              ) : (
                <div className="py-10 text-center">
                  <span
                    className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
                    style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                  >
                    <ClipboardCheck className="w-6 h-6" aria-hidden />
                  </span>
                  <h3 className="font-display text-h3 font-semibold text-text-primary">
                    Nothing selected
                  </h3>
                  <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
                    Pick a document on the left to see its flagged fields, confidence, and a direct
                    jump into Source View for provenance.
                  </p>
                </div>
              )}

              <div className="mt-6 pt-4 border-t border-border-default flex flex-wrap items-center justify-end gap-2">
                {selectedDoc && (
                  <>
                    <button
                      type="button"
                      onClick={() => decide(selectedDoc, 'rejected')}
                      className="btn-secondary text-small px-4 py-2"
                    >
                      <X className="w-4 h-4" aria-hidden />
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(selectedDoc, 'approved')}
                      className="btn-secondary text-small px-4 py-2"
                    >
                      <Check className="w-4 h-4" aria-hidden />
                      Approve
                    </button>
                  </>
                )}
                {selectedDoc ? (
                  <Link
                    href={`/documents/${selectedDoc.id}`}
                    className="btn-primary text-small px-4 py-2"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden />
                    Open in Source View
                  </Link>
                ) : (
                  <button
                    type="button"
                    disabled
                    className="btn-primary text-small px-4 py-2 opacity-50 cursor-not-allowed"
                    title="Select a document from the queue first"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden />
                    Open in Source View
                  </button>
                )}
              </div>
              {selectedDoc && (
                <p className="mt-3 text-small text-text-muted text-right">
                  Approve / reject is recorded locally — resolving a review resumes the extraction
                  pipeline, which isn’t wired to this screen yet.
                </p>
              )}
            </div>

            <div className="card p-5">
              <h2 className="font-display text-h3 font-semibold text-text-primary mb-3">
                Keyboard shortcuts
              </h2>
              <ul className="space-y-2">
                {SHORTCUTS.map((s) => (
                  <li key={s.label} className="flex items-center gap-3 text-body text-text-secondary">
                    <span className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, i) => (
                        <span key={k}>
                          <kbd className="text-small font-mono px-1.5 py-0.5 rounded glass-hairline text-text-primary">
                            {k}
                          </kbd>
                          {i < s.keys.length - 1 && (
                            <span className="text-text-muted mx-0.5" aria-hidden>
                              /
                            </span>
                          )}
                        </span>
                      ))}
                    </span>
                    <span>{s.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        </div>
      </div>
    </AppLayout>
  );
}

function QueueRow({
  doc,
  active,
  onClick,
}: {
  doc: ReviewQueueDoc;
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
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-8 rounded-r-full bg-accent-brand"
            aria-hidden
          />
        )}
        <div className="flex items-center justify-between gap-3">
          <span className="text-body font-medium text-text-primary truncate">{doc.filename}</span>
          <span className={confClass(doc.confidence)}>{(doc.confidence * 100).toFixed(0)}%</span>
        </div>
        <div className="mt-1 flex items-center gap-2 text-small text-text-muted">
          <span className="badge-info">{doc.profile}</span>
          <span aria-hidden>·</span>
          <span>{doc.flaggedFields.length} flagged</span>
        </div>
      </button>
    </li>
  );
}

function FlaggedFieldRow({ field }: { field: FlaggedField }) {
  return (
    <li className="py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-body text-text-primary truncate">{field.name}</span>
        <span className={confClass(field.confidence)}>{(field.confidence * 100).toFixed(0)}%</span>
      </div>
      <p className="mt-1 text-body text-text-secondary truncate">{field.value}</p>
      <p className="mt-0.5 text-small text-text-muted">{field.reason}</p>
    </li>
  );
}
