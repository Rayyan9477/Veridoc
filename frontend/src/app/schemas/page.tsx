'use client';

/**
 * Schemas gallery — every extraction schema the engine currently knows
 * about, sourced live from `GET /schemas`. Every card reflects a schema
 * that is genuinely registered and usable today, so it's labeled
 * "Published" — there is no draft-storage concept on the backend yet.
 * Drafting happens locally in the schema designer (`/schemas/[name]`)
 * until a save/publish endpoint exists.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  Boxes,
  Grid3x3,
  Layers,
  Plus,
  Search,
  SlidersHorizontal,
  Upload,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { schemaApi, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { SchemaInfo } from '@/types/api';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

export default function SchemasGalleryPage() {
  const [query, setQuery] = useState('');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['schemas'],
    queryFn: () => schemaApi.list(),
  });

  const schemas = useMemo(() => data ?? [], [data]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return schemas;
    return schemas.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.document_type.toLowerCase().includes(q),
    );
  }, [schemas, query]);

  const totalFields = schemas.reduce((sum, s) => sum + s.field_count, 0);
  const distinctTypes = new Set(schemas.map((s) => s.document_type)).size;

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div {...fade(0)} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-body text-text-secondary">
            Extraction schemas registered on the engine — pick one to extract with, or open it in the designer.
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled
              title="Schema creation isn't wired up yet"
              className="btn-secondary text-small px-3 py-1.5 opacity-60 cursor-not-allowed"
            >
              <Plus className="w-4 h-4" aria-hidden />
              New schema
              <span className="text-small text-text-muted">(soon)</span>
            </button>
            <button
              type="button"
              disabled
              title="Schema import isn't wired up yet"
              className="btn-ghost text-small px-3 py-1.5 opacity-60 cursor-not-allowed"
            >
              <Upload className="w-4 h-4" aria-hidden />
              Import
              <span className="text-small text-text-muted">(soon)</span>
            </button>
          </div>
        </motion.div>

        {/* Stat row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <motion.div {...fade(0.02)} className="stat-card">
            <div className="flex items-center justify-between">
              <span className="stat-label">Schemas</span>
              <span
                className="grid place-items-center w-8 h-8 rounded-lg text-accent-brand"
                style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
              >
                <Boxes className="w-4 h-4" />
              </span>
            </div>
            <div className="stat-value">{schemas.length}</div>
          </motion.div>
          <motion.div {...fade(0.05)} className="stat-card">
            <div className="flex items-center justify-between">
              <span className="stat-label">Total fields</span>
              <span
                className="grid place-items-center w-8 h-8 rounded-lg text-accent-brand"
                style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
              >
                <Grid3x3 className="w-4 h-4" />
              </span>
            </div>
            <div className="stat-value">{totalFields}</div>
          </motion.div>
          <motion.div {...fade(0.08)} className="stat-card">
            <div className="flex items-center justify-between">
              <span className="stat-label">Document types</span>
              <span
                className="grid place-items-center w-8 h-8 rounded-lg text-accent-brand"
                style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
              >
                <Layers className="w-4 h-4" />
              </span>
            </div>
            <div className="stat-value">{distinctTypes}</div>
          </motion.div>
        </div>

        {/* Search */}
        <motion.div {...fade(0.1)} className="flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search
              className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted"
              aria-hidden
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search schemas by name, type, or description…"
              className="input pl-10"
            />
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="btn-ghost text-small px-3 py-1.5"
            disabled={isFetching}
          >
            <SlidersHorizontal className={cn('w-4 h-4', isFetching && 'animate-pulse')} aria-hidden />
            Refresh
          </button>
        </motion.div>

        {/* Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="card p-6 space-y-4">
                <div className="skeleton h-10 w-10 rounded-xl" />
                <div className="skeleton h-4 w-2/3" />
                <div className="skeleton h-3 w-full" />
                <div className="skeleton h-3 w-5/6" />
                <div className="skeleton h-8 w-full" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="card p-10 text-center">
            <span
              className="mx-auto grid place-items-center w-12 h-12 rounded-xl mb-4"
              style={{ background: 'rgb(var(--accent-danger-rgb) / 0.14)', color: 'rgb(var(--accent-danger-rgb))' }}
            >
              <AlertCircle className="w-6 h-6" aria-hidden />
            </span>
            <h3 className="font-display text-h3 font-semibold text-text-primary">Failed to load schemas</h3>
            <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
              {error instanceof ApiError ? error.message : 'The schema registry could not be reached.'}
            </p>
            <button type="button" onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5 mt-5">
              Try again
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="card p-10 text-center">
            <span
              className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
              style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
            >
              <Boxes className="w-6 h-6" aria-hidden />
            </span>
            <h3 className="font-display text-h3 font-semibold text-text-primary">
              {query ? 'No schemas match your search' : 'No schemas registered yet'}
            </h3>
            <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
              {query
                ? 'Try a different name, document type, or description keyword.'
                : 'Once schemas are registered on the engine, they will appear here.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filtered.map((schema, i) => (
              <SchemaCard key={schema.name} schema={schema} delay={0.02 * i} />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function SchemaCard({ schema, delay }: { schema: SchemaInfo; delay: number }) {
  return (
    <motion.div {...fade(delay)}>
      <div className="card-hover p-6 h-full flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <span
            className="grid place-items-center w-10 h-10 rounded-xl text-accent-brand shrink-0"
            style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
          >
            <Boxes className="w-5 h-5" aria-hidden />
          </span>
          <span className="badge-success">Published</span>
        </div>

        <h3 className="mt-4 font-display text-h3 font-semibold text-text-primary truncate">
          {schema.name}
        </h3>
        <div className="mt-1.5 flex items-center gap-2">
          <span className="badge-info">{schema.document_type}</span>
          <span className="text-small font-mono text-text-muted">v{schema.version}</span>
        </div>

        <p className="mt-3 text-body text-text-secondary line-clamp-3 flex-1">
          {schema.description || 'No description available.'}
        </p>

        <div className="mt-4 flex items-center gap-1.5 text-small text-text-muted">
          <Grid3x3 className="w-3.5 h-3.5" aria-hidden />
          <span>{schema.field_count} field{schema.field_count === 1 ? '' : 's'}</span>
        </div>

        <div className="mt-4 pt-4 border-t border-border-default flex items-center gap-2">
          <Link
            href={`/documents/upload?schema=${encodeURIComponent(schema.name)}`}
            className="btn-primary text-small px-3 py-1.5 flex-1 justify-center"
          >
            Use this schema
          </Link>
          <Link
            href={`/schemas/${encodeURIComponent(schema.name)}`}
            className="btn-secondary text-small px-3 py-1.5"
          >
            Designer
          </Link>
        </div>
      </div>
    </motion.div>
  );
}
