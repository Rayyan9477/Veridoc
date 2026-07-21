'use client';

/**
 * Audit log — the tamper-evident event trail.
 *
 * Veridoc writes every security-relevant action (auth, extraction,
 * export, PHI access) to a hash-chained JSONL log (`src/security/audit.py`)
 * — each entry's hash covers the previous entry's hash, so any edit or
 * deletion breaks the chain and is detectable (see `verify_audit_chain`).
 *
 * This page reads that log live via `GET /api/v1/audit` (with
 * date/actor/event/tenant/text filters) and exports filtered slices via
 * `GET /api/v1/audit/export`. When no entries match — or the log is
 * empty — it shows an honest empty state rather than invented rows.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  CalendarDays,
  FileJson,
  FileSpreadsheet,
  Loader2,
  Search,
  ShieldAlert,
  Tag,
  User,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { auditApi, ApiError, type AuditEntry, type AuditFilters as ApiAuditFilters } from '@/lib/api/admin';

const TABLE_COLUMNS = ['Time', 'Actor', 'Event', 'Target', 'Result', 'Detail'] as const;

const EXAMPLE_EVENTS = [
  'auth.login.success',
  'auth.login.failure',
  'doc.process',
  'doc.export',
  'phi.view',
  'api.request',
  'api.error',
  'authz.access.denied',
];

interface AuditFilters {
  dateFrom: string;
  dateTo: string;
  actor: string;
  event: string;
  tenant: string;
  q: string;
}

const EMPTY_FILTERS: AuditFilters = {
  dateFrom: '',
  dateTo: '',
  actor: '',
  event: '',
  tenant: '',
  q: '',
};

/** Map the UI filter model onto the API client's filter shape. */
function toApiFilters(f: AuditFilters): ApiAuditFilters {
  return {
    dateFrom: f.dateFrom || undefined,
    dateTo: f.dateTo || undefined,
    actor: f.actor || undefined,
    event: f.event || undefined,
    tenant: f.tenant || undefined,
    q: f.q || undefined,
    limit: 200,
  };
}

function formatTime(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function outcomeClass(outcome: string): string {
  if (outcome === 'success') return 'badge-success';
  if (outcome === 'failure') return 'badge-danger';
  return 'badge-info';
}

export default function AuditLogPage() {
  const [filters, setFilters] = useState<AuditFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<AuditFilters>(EMPTY_FILTERS);
  const [exporting, setExporting] = useState<'JSONL' | 'CSV' | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['audit', applied],
    queryFn: () => auditApi.query(toApiFilters(applied)),
  });

  const entries = data?.entries ?? [];

  const activeFilterCount = useMemo(
    () => Object.values(applied).filter((v) => v.trim().length > 0).length,
    [applied],
  );

  const set = <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const handleSearch = () => setApplied(filters);

  const handleReset = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };

  const handleExport = async (format: 'JSONL' | 'CSV') => {
    setExporting(format);
    try {
      const blob = await auditApi.exportBlob(
        format === 'JSONL' ? 'jsonl' : 'csv',
        toApiFilters(applied),
      );
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'JSONL' ? 'audit_export.jsonl' : 'audit_export.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
      toast.success(`${format} export downloaded.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : `${format} export failed.`);
    } finally {
      setExporting(null);
    }
  };

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-body text-text-secondary max-w-2xl">
            Search the tamper-evident event trail. Every row is a single hash-chained log
            entry — edits or deletions break the chain and surface on the Security page.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => handleExport('JSONL')}
              disabled={exporting !== null}
              className="btn-secondary text-small px-3 py-1.5 disabled:opacity-60"
            >
              {exporting === 'JSONL' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <FileJson className="w-4 h-4" aria-hidden />}
              Export JSONL
            </button>
            <button
              onClick={() => handleExport('CSV')}
              disabled={exporting !== null}
              className="btn-secondary text-small px-3 py-1.5 disabled:opacity-60"
            >
              {exporting === 'CSV' ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <FileSpreadsheet className="w-4 h-4" aria-hidden />}
              Export CSV
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="card p-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div className="lg:col-span-1">
              <label className="text-small text-text-muted mb-1 block" htmlFor="audit-date-from">
                From
              </label>
              <div className="relative">
                <CalendarDays className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
                <input
                  id="audit-date-from"
                  type="date"
                  value={filters.dateFrom}
                  onChange={(e) => set('dateFrom', e.target.value)}
                  className="input pl-9"
                />
              </div>
            </div>
            <div className="lg:col-span-1">
              <label className="text-small text-text-muted mb-1 block" htmlFor="audit-date-to">
                To
              </label>
              <div className="relative">
                <CalendarDays className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
                <input
                  id="audit-date-to"
                  type="date"
                  value={filters.dateTo}
                  onChange={(e) => set('dateTo', e.target.value)}
                  className="input pl-9"
                />
              </div>
            </div>
            <div className="lg:col-span-1">
              <label className="text-small text-text-muted mb-1 block" htmlFor="audit-actor">
                Actor
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
                <input
                  id="audit-actor"
                  type="text"
                  placeholder="user or service id"
                  value={filters.actor}
                  onChange={(e) => set('actor', e.target.value)}
                  className="input pl-9"
                />
              </div>
            </div>
            <div className="lg:col-span-1">
              <label className="text-small text-text-muted mb-1 block" htmlFor="audit-event">
                Event
              </label>
              <div className="relative">
                <Tag className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
                <input
                  id="audit-event"
                  type="text"
                  list="audit-event-examples"
                  placeholder="e.g. doc.process"
                  value={filters.event}
                  onChange={(e) => set('event', e.target.value)}
                  className="input pl-9 font-mono"
                />
                <datalist id="audit-event-examples">
                  {EXAMPLE_EVENTS.map((e) => (
                    <option key={e} value={e} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="lg:col-span-1">
              <label className="text-small text-text-muted mb-1 block" htmlFor="audit-tenant">
                Tenant
              </label>
              <input
                id="audit-tenant"
                type="text"
                placeholder="tenant id"
                value={filters.tenant}
                onChange={(e) => set('tenant', e.target.value)}
                className="input"
              />
            </div>
            <div className="lg:col-span-1">
              <label className="text-small text-text-muted mb-1 block" htmlFor="audit-payload">
                Payload search
              </label>
              <div className="relative">
                <Search className="w-4 h-4 text-text-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden />
                <input
                  id="audit-payload"
                  type="text"
                  placeholder="free text"
                  value={filters.q}
                  onChange={(e) => set('q', e.target.value)}
                  className="input pl-9"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <button onClick={handleSearch} className="btn-primary text-small px-4 py-2">
              {isFetching ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Search className="w-4 h-4" aria-hidden />}
              Search
            </button>
            <button onClick={handleReset} className="btn-ghost text-small px-3 py-2">
              Clear filters
            </button>
            {activeFilterCount > 0 && (
              <span className="badge-info ml-auto">{activeFilterCount} filter{activeFilterCount === 1 ? '' : 's'} applied</span>
            )}
          </div>
        </div>

        {/* Event table */}
        <div className="card overflow-hidden">
          <div className="hidden md:grid grid-cols-12 gap-4 px-5 py-3 border-b border-border-default text-small uppercase tracking-wide text-text-muted">
            <div className="col-span-2">{TABLE_COLUMNS[0]}</div>
            <div className="col-span-2">{TABLE_COLUMNS[1]}</div>
            <div className="col-span-2">{TABLE_COLUMNS[2]}</div>
            <div className="col-span-2">{TABLE_COLUMNS[3]}</div>
            <div className="col-span-1">{TABLE_COLUMNS[4]}</div>
            <div className="col-span-3">{TABLE_COLUMNS[5]}</div>
          </div>

          {isLoading ? (
            <div className="divide-y divide-border-default">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="px-5 py-3">
                  <div className="skeleton h-5 w-full" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="py-16 text-center space-y-2">
              <ShieldAlert className="w-8 h-8 mx-auto text-accent-danger" aria-hidden />
              <p className="text-body text-text-secondary">Couldn’t reach the audit query endpoint.</p>
              <button onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5 mt-2">
                Try again
              </button>
            </div>
          ) : entries.length === 0 ? (
            <div className="py-16 text-center space-y-2">
              <ShieldAlert className="w-8 h-8 mx-auto text-text-muted" aria-hidden />
              <p className="text-body text-text-secondary">
                {activeFilterCount > 0 ? 'No audit entries match these filters.' : 'No audit entries recorded yet.'}
              </p>
              <p className="text-small text-text-muted max-w-lg mx-auto">
                Entries appear here as security-relevant actions are recorded to the hash-chained
                audit log. Nothing shown is sample data.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border-default">
              {entries.map((entry) => (
                <AuditRow key={entry.event_id || `${entry.timestamp}-${entry.event_type}`} entry={entry} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </AppLayout>
  );
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const target =
    [entry.resource_type, entry.resource_id].filter(Boolean).join(' ') || entry.http_path || '—';
  return (
    <li className="grid grid-cols-1 md:grid-cols-12 gap-2 md:gap-4 px-5 py-3 text-body hover:bg-white/5 transition-colors">
      <div className="md:col-span-2 text-small text-text-secondary">{formatTime(entry.timestamp)}</div>
      <div className="md:col-span-2 truncate text-text-primary">{entry.actor || entry.client_ip || '—'}</div>
      <div className="md:col-span-2 font-mono text-small text-text-secondary truncate" title={entry.event_type}>
        {entry.event_type}
      </div>
      <div className="md:col-span-2 truncate text-text-secondary" title={target}>{target}</div>
      <div className="md:col-span-1">
        <span className={outcomeClass(entry.outcome)}>{entry.outcome || '—'}</span>
      </div>
      <div className="md:col-span-3 truncate text-text-muted" title={entry.message}>{entry.message}</div>
    </li>
  );
}
