'use client';

/**
 * Help — in-app docs.
 *
 * A searchable reference for the core Veridoc concepts (confidence
 * bands, Source View, profiles, schemas) plus the keyboard-shortcut
 * reference. Content is static by design — this is documentation, not
 * live data.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Boxes,
  Command,
  Compass,
  Keyboard,
  Layers,
  MousePointerClick,
  Rocket,
  Search,
  Workflow,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import type { ComponentType } from 'react';

interface DocSection {
  id: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  summary: string;
  bullets: string[];
  link?: { href: string; label: string };
}

const DOC_SECTIONS: DocSection[] = [
  {
    id: 'getting-started',
    title: 'Getting started',
    icon: Rocket,
    summary: 'Upload a document, let Veridoc extract it, and review the result.',
    bullets: [
      'Upload a PDF (or a batch) from the Upload page — single or async processing.',
      'Auto-detect picks a profile (Healthcare vs. General) and schema, or override both explicitly.',
      'The dual-VLM pipeline extracts every field, cross-checks it, and assigns a calibrated confidence.',
      'Flagged fields route to Human-in-the-loop review; everything else is ready to export.',
      'Export to JSON, Excel, Markdown, or FHIR from the document page.',
    ],
    link: { href: '/documents/upload', label: 'Go to Upload' },
  },
  {
    id: 'workflows',
    title: 'Workflows',
    icon: Workflow,
    summary: 'How extraction, confidence, and the Source View reviewer loop fit together.',
    bullets: [
      'Confidence bands: green (≥ 0.85) is high-confidence and safe to trust, amber (0.5–0.85) deserves a glance, red (< 0.5) needs a correction before export.',
      'Source View is the click-to-source interaction — click a field in the list and the rendered page jumps to and highlights its bounding box; click a highlighted box to select that field.',
      'Every field carries a provenance timeline: Pass 1 (VLM) → Pass 2 (auditor) → Reconciler → Critic — so you can see exactly how a value was derived and where passes disagreed.',
      'Keyboard stepping: n / p move to the next / previous field, ordered low-confidence-first so reviewers fix the riskiest fields before the safe ones.',
      'Tasks that need a human sit in the HITL review queue until approved or corrected.',
    ],
    link: { href: '/review', label: 'Open HITL review' },
  },
  {
    id: 'schemas',
    title: 'Schemas',
    icon: Boxes,
    summary: 'The field definitions that tell the extractor what to look for.',
    bullets: [
      'A schema is a named list of fields (name, type, required, validation rules) targeted for extraction — e.g. CMS-1500, UB-04, Superbill, EOB.',
      'Schemas can be browsed, versioned, and inspected on the Schemas page before you point an upload at one.',
      'Pick a schema explicitly, or let profile auto-detection choose one based on the document.',
    ],
    link: { href: '/schemas', label: 'Browse schemas' },
  },
  {
    id: 'profiles',
    title: 'Profiles',
    icon: Layers,
    summary: 'Top-level modes that tune the whole pipeline for a document class.',
    bullets: [
      'Healthcare profile: CMS-1500 / UB-04 / EOB / Superbill schemas, NPI / CPT / ICD validators, PHI masking, and FHIR R4 emission.',
      'General document profile: any PDF — invoices, contracts, forms, letters — plain JSON / Markdown / Excel output.',
      'Auto-detect lets the analyzer pick the best profile for the document instead of forcing one.',
    ],
    link: { href: '/profiles', label: 'View profiles' },
  },
];

interface Shortcut {
  keys: string[];
  description: string;
}

const SHORTCUTS: Shortcut[] = [
  { keys: ['⌘', 'K'], description: 'Open the command palette — jump to any page or action.' },
  { keys: ['/'], description: 'Focus the search bar.' },
  { keys: ['g', 'd'], description: 'Go to Dashboard.' },
  { keys: ['u'], description: 'Go to Upload.' },
  { keys: ['n'], description: 'Next field in Source View (low-confidence first).' },
  { keys: ['p'], description: 'Previous field in Source View.' },
  { keys: ['↑', '↓'], description: 'Move selection within the command palette.' },
  { keys: ['Esc'], description: 'Close the command palette or any open overlay.' },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.75rem] px-1.5 py-0.5 rounded-md text-small font-mono glass-hairline text-text-secondary">
      {children}
    </kbd>
  );
}

export default function HelpPage() {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DOC_SECTIONS;
    return DOC_SECTIONS.filter((section) =>
      `${section.title} ${section.summary} ${section.bullets.join(' ')}`.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <AppLayout>
      <div className="space-y-6">
        <p className="text-body text-text-secondary max-w-2xl">
          In-app documentation for Veridoc's core concepts, plus the full keyboard-shortcut
          reference.
        </p>

        {/* Search */}
        <div className="relative max-w-xl">
          <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search docs — confidence, source view, schemas, profiles…"
            className="input pl-9"
            aria-label="Search documentation"
          />
        </div>

        {/* Doc sections */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtered.length === 0 ? (
            <div className="lg:col-span-2 card p-10 text-center">
              <Compass className="w-8 h-8 mx-auto text-text-muted mb-2" aria-hidden />
              <p className="text-body text-text-secondary">No sections match “{query}”.</p>
            </div>
          ) : (
            filtered.map((section) => {
              const Icon = section.icon;
              return (
                <div key={section.id} className="card p-5 flex flex-col">
                  <div className="flex items-start gap-3">
                    <span
                      className="grid place-items-center w-9 h-9 rounded-lg text-accent-brand shrink-0"
                      style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                    >
                      <Icon className="w-4 h-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <h2 className="text-h3 font-display font-semibold text-text-primary">{section.title}</h2>
                      <p className="text-small text-text-muted mt-0.5">{section.summary}</p>
                    </div>
                  </div>
                  <ul className="mt-3 space-y-1.5 flex-1">
                    {section.bullets.map((b, i) => (
                      <li key={i} className="text-body text-text-secondary flex gap-2">
                        <span className="text-text-muted shrink-0">•</span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  {section.link && (
                    <Link
                      href={section.link.href}
                      className="text-small text-accent-brand mt-4 inline-flex items-center gap-1 self-start"
                    >
                      {section.link.label} →
                    </Link>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* Keyboard shortcuts */}
        <div className="card p-5">
          <div className="flex items-center gap-2 mb-4">
            <Keyboard className="w-4 h-4 text-text-muted" aria-hidden />
            <h2 className="text-h3 font-display font-semibold text-text-primary">Keyboard shortcuts</h2>
          </div>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3">
            {SHORTCUTS.map((s, i) => (
              <li key={i} className="flex items-center justify-between gap-4 text-body">
                <span className="text-text-secondary">{s.description}</span>
                <span className="inline-flex items-center gap-1 shrink-0">
                  {s.keys.map((k, j) => (
                    <Kbd key={j}>{k}</Kbd>
                  ))}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-small text-text-muted mt-4 inline-flex items-center gap-1.5">
            <Command className="w-3.5 h-3.5" aria-hidden />
            Chords like <Kbd>g</Kbd> <Kbd>d</Kbd> are pressed in sequence, not held together.
          </p>
        </div>

        <div className="card p-4 flex items-start gap-3">
          <MousePointerClick className="w-5 h-5 text-accent-brand shrink-0 mt-0.5" aria-hidden />
          <p className="text-small text-text-secondary">
            Prefer clicking around? Every shortcut above has a visible button or link
            equivalent — nothing in Veridoc is keyboard-only.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
