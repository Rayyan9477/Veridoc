'use client';

/**
 * API explorer — a two-pane interactive REST doc.
 *
 * Left: grouped endpoint catalog. Right: method + path + description for
 * the selected endpoint, with a "Try it" that runs a real fetch against
 * `${NEXT_PUBLIC_API_URL}/api/v1<path>` for GET endpoints (Bearer-token
 * pattern from lib/api.ts, via the shared executor in
 * lib/api/integrate.ts) and renders the live status, latency, and JSON
 * body. POST endpoints are documented but not executable here — they
 * need a request body / file this page doesn't fabricate.
 */

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Search,
  Play,
  Loader2,
  Copy,
  Check,
  FileText,
  Database,
  HeartPulse,
  ListChecks,
  Clock,
  Terminal,
  Ban,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { cn } from '@/lib/utils';
import { tryGetEndpoint, type TryItResult } from '@/lib/api/integrate';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

interface EndpointParam {
  name: string;
  label: string;
  placeholder: string;
}

interface EndpointDef {
  id: string;
  group: 'Documents' | 'Schemas' | 'Health' | 'Tasks';
  method: 'GET' | 'POST';
  path: string;
  description: string;
  params?: EndpointParam[];
  executable: boolean;
}

const GROUP_ICONS: Record<EndpointDef['group'], React.ComponentType<{ className?: string }>> = {
  Documents: FileText,
  Schemas: Database,
  Health: HeartPulse,
  Tasks: ListChecks,
};

const GROUPS: EndpointDef['group'][] = ['Documents', 'Schemas', 'Health', 'Tasks'];

const ENDPOINTS: EndpointDef[] = [
  {
    id: 'documents-list',
    group: 'Documents',
    method: 'GET',
    path: '/documents',
    description: 'List recently processed documents on this instance.',
    executable: true,
  },
  {
    id: 'documents-upload',
    group: 'Documents',
    method: 'POST',
    path: '/documents/upload',
    description:
      'Upload a PDF or image for dual-VLM extraction (multipart/form-data). Requires a file, so it isn’t executable from this explorer — see the Upload screen instead.',
    executable: false,
  },
  {
    id: 'documents-get',
    group: 'Documents',
    method: 'GET',
    path: '/documents/{id}',
    description: 'Get the full processing result for a document by its processing ID.',
    params: [{ name: 'id', label: 'processing_id', placeholder: 'e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6' }],
    executable: true,
  },
  {
    id: 'documents-provenance',
    group: 'Documents',
    method: 'GET',
    path: '/documents/{id}/provenance',
    description: 'Get per-field source provenance — page, bbox, and extraction lineage — for a document.',
    params: [{ name: 'id', label: 'processing_id', placeholder: 'e.g. 3fa85f64-5717-4562-b3fc-2c963f66afa6' }],
    executable: true,
  },
  {
    id: 'schemas-list',
    group: 'Schemas',
    method: 'GET',
    path: '/schemas',
    description: 'List all available extraction schemas.',
    executable: true,
  },
  {
    id: 'health-basic',
    group: 'Health',
    method: 'GET',
    path: '/health',
    description: 'Basic liveness probe — returns quickly with no auth requirement.',
    executable: true,
  },
  {
    id: 'health-detailed',
    group: 'Health',
    method: 'GET',
    path: '/health/detailed',
    description: 'Per-component health — API, database, cache, VLM, and worker status.',
    executable: true,
  },
  {
    id: 'tasks-active',
    group: 'Tasks',
    method: 'GET',
    path: '/tasks/active',
    description: 'List currently active or queued extraction tasks.',
    executable: true,
  },
];

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function ApiExplorerPage() {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string>(ENDPOINTS[0].id);
  const [paramValue, setParamValue] = useState('');
  const [result, setResult] = useState<TryItResult | null>(null);
  const [loading, setLoading] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ENDPOINTS;
    return ENDPOINTS.filter(
      (e) => e.path.toLowerCase().includes(q) || e.description.toLowerCase().includes(q),
    );
  }, [search]);

  const selected = ENDPOINTS.find((e) => e.id === selectedId) ?? ENDPOINTS[0];
  const param = selected.params?.[0];
  const resolvedPath = param ? selected.path.replace(`{${param.name}}`, encodeURIComponent(paramValue)) : selected.path;
  const canRun = selected.executable && (!param || paramValue.trim().length > 0);

  const selectEndpoint = (id: string) => {
    setSelectedId(id);
    setParamValue('');
    setResult(null);
  };

  const handleTryIt = async () => {
    if (!canRun) return;
    setLoading(true);
    setResult(null);
    const res = await tryGetEndpoint(resolvedPath);
    setResult(res);
    setLoading(false);
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div {...fade(0)}>
          <h1 className="font-display text-h2 font-semibold text-text-primary flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-accent-brand" aria-hidden />
            API explorer
          </h1>
          <p className="mt-1 text-body text-text-secondary">
            Browse the Veridoc REST surface and run live GET requests against it.
          </p>
        </motion.div>

        <motion.div {...fade(0.05)} className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left pane — endpoint catalog */}
          <div className="lg:col-span-2 space-y-3">
            <div className="relative">
              <Search className="w-4 h-4 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden />
              <input
                type="text"
                placeholder="Filter endpoints…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="input pl-9"
                aria-label="Filter endpoints"
              />
            </div>

            <div className="card overflow-hidden">
              <nav className="max-h-[640px] overflow-y-auto no-scrollbar">
                {GROUPS.map((group) => {
                  const items = filtered.filter((e) => e.group === group);
                  if (items.length === 0) return null;
                  const GroupIcon = GROUP_ICONS[group];
                  return (
                    <div key={group}>
                      <div className="nav-group-label flex items-center gap-1.5">
                        <GroupIcon className="w-3 h-3" aria-hidden />
                        {group}
                      </div>
                      <ul>
                        {items.map((ep) => (
                          <li key={ep.id}>
                            <button
                              type="button"
                              onClick={() => selectEndpoint(ep.id)}
                              className={cn(
                                'w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors duration-fast hover:bg-white/5',
                              )}
                              style={
                                ep.id === selectedId
                                  ? { background: 'rgb(var(--accent-brand-rgb) / 0.1)' }
                                  : undefined
                              }
                            >
                              <MethodChip method={ep.method} />
                              <span className="font-mono text-small text-text-primary truncate">{ep.path}</span>
                              {!ep.executable && (
                                <Ban className="w-3 h-3 text-text-muted flex-shrink-0 ml-auto" aria-hidden />
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
                {filtered.length === 0 && (
                  <div className="py-10 text-center text-body text-text-muted">No endpoints match.</div>
                )}
              </nav>
            </div>
          </div>

          {/* Right pane — endpoint detail + Try it */}
          <div className="lg:col-span-3">
            <div className="card p-5 space-y-5">
              <div className="flex items-center gap-3 flex-wrap">
                <MethodChip method={selected.method} large />
                <span className="font-mono text-body text-text-primary break-all">{selected.path}</span>
              </div>
              <p className="text-body text-text-secondary">{selected.description}</p>

              {param && (
                <div>
                  <label htmlFor="param-input" className="block text-small font-medium text-text-secondary mb-1.5">
                    {param.label}
                  </label>
                  <input
                    id="param-input"
                    type="text"
                    value={paramValue}
                    onChange={(e) => setParamValue(e.target.value)}
                    placeholder={param.placeholder}
                    className="input font-mono"
                  />
                </div>
              )}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleTryIt}
                  disabled={!canRun || loading}
                  className="btn-primary text-small px-3.5 py-2"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                  ) : (
                    <Play className="w-4 h-4" aria-hidden />
                  )}
                  Try it
                </button>
                {!selected.executable && (
                  <span className="text-small text-text-muted inline-flex items-center gap-1.5">
                    <Ban className="w-3.5 h-3.5" aria-hidden />
                    Not executable — POST requires a request body this explorer doesn&apos;t send.
                  </span>
                )}
              </div>

              <div className="divider" />

              <div>
                <span className="text-small font-medium text-text-secondary">Request</span>
                <div
                  className="mt-1.5 rounded-xl px-3.5 py-2.5 font-mono text-small text-text-secondary overflow-x-auto"
                  style={{ background: 'rgb(var(--text-primary-rgb) / 0.04)' }}
                >
                  GET {API_BASE_URL}/api/v1{resolvedPath}
                </div>
              </div>

              {result && <ResultPanel result={result} />}
            </div>
          </div>
        </motion.div>
      </div>
    </AppLayout>
  );
}

function MethodChip({ method, large }: { method: 'GET' | 'POST'; large?: boolean }) {
  return (
    <span
      className={cn(
        method === 'GET' ? 'badge-success' : 'badge-warning',
        'font-mono flex-shrink-0',
        large && 'text-body px-3 py-1',
      )}
    >
      {method}
    </span>
  );
}

function ResultPanel({ result }: { result: TryItResult }) {
  const [copied, setCopied] = useState(false);
  const bodyText = useMemo(() => {
    if (result.body === null || result.body === undefined) return '(empty body)';
    if (typeof result.body === 'string') return result.body;
    try {
      return JSON.stringify(result.body, null, 2);
    } catch {
      return String(result.body);
    }
  }, [result.body]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(bodyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — silently ignore.
    }
  };

  const statusBadge = result.status === null
    ? 'badge-error'
    : result.status >= 200 && result.status < 300
      ? 'badge-success'
      : result.status >= 400
        ? 'badge-error'
        : 'badge-warning';

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-small font-medium text-text-secondary">Response</span>
        <span className={cn(statusBadge, 'font-mono')}>{result.status ?? 'ERR'}</span>
        <span className="text-small text-text-muted inline-flex items-center gap-1">
          <Clock className="w-3 h-3" aria-hidden />
          {result.latencyMs} ms
        </span>
        {result.error && <span className="text-small text-accent-danger">{result.error}</span>}
      </div>
      <div className="relative">
        <button
          type="button"
          onClick={handleCopy}
          className="btn-ghost text-small px-2 py-1 absolute top-2 right-2"
          aria-label="Copy response body"
        >
          {copied ? <Check className="w-3.5 h-3.5" aria-hidden /> : <Copy className="w-3.5 h-3.5" aria-hidden />}
        </button>
        <pre
          className="rounded-xl p-4 pt-2 font-mono text-small text-text-primary overflow-auto max-h-[420px] whitespace-pre-wrap break-words"
          style={{ background: 'rgb(var(--text-primary-rgb) / 0.04)' }}
        >
          {bodyText}
        </pre>
      </div>
    </div>
  );
}
