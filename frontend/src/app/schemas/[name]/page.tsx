'use client';

/**
 * Schema designer — three-pane editor for a single extraction schema.
 *
 * Loads the real schema via `GET /schemas/{name}` and seeds an editable
 * local model from it (sections/fields tree, field editor, prompt-fragment
 * preview + linter). Save persists the edited schema as a file-backed
 * draft (`POST /schemas`); Publish persists then flips it to published
 * (`POST /schemas/{name}/publish`). An authored schema shadows the
 * same-named code schema in listings.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Rocket,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { schemaApi, ApiError } from '@/lib/api';
import { saveSchema, publishSchema, type SchemaFieldPayload } from '@/lib/api/build';
import { cn } from '@/lib/utils';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

/** Canonical editor type union, per the designer spec. */
type EditorFieldType = 'string' | 'number' | 'date' | 'currency' | 'enum' | 'list' | 'object';

const TYPE_OPTIONS: { value: EditorFieldType; label: string }[] = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'currency', label: 'Currency' },
  { value: 'enum', label: 'Enum' },
  { value: 'list', label: 'List' },
  { value: 'object', label: 'Object' },
];

/**
 * Shape actually returned by `GET /schemas/{name}` for each field. The
 * shared `SchemaField` type in `types/api.ts` only declares the subset
 * every caller can rely on; the raw backend field definition
 * (`FieldBuilder`) can carry more — `examples`, `allowed_values`,
 * `pattern` — which we read defensively without fabricating anything
 * that isn't actually there.
 */
interface RawSchemaField {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  validation_rules?: string[];
  examples?: string[];
  allowed_values?: string[];
  pattern?: string;
}

interface DesignerField {
  id: string;
  name: string;
  type: EditorFieldType;
  originalType: string;
  required: boolean;
  description: string;
  examples: string[];
  validators: string[];
  allowedValues: string[];
}

interface DesignerSection {
  id: string;
  name: string;
  fields: DesignerField[];
}

function normalizeType(raw: RawSchemaField): EditorFieldType {
  if (raw.allowed_values && raw.allowed_values.length > 0) return 'enum';
  const t = (raw.type || '').toLowerCase();
  if (['integer', 'float', 'percentage', 'number'].includes(t)) return 'number';
  if (['date', 'datetime', 'time'].includes(t)) return 'date';
  if (t === 'currency') return 'currency';
  if (['list', 'table'].includes(t)) return 'list';
  if (t === 'object') return 'object';
  return 'string';
}

function toDesignerField(raw: RawSchemaField, index: number): DesignerField {
  const validators = Array.from(
    new Set([...(raw.pattern ? [raw.pattern] : []), ...(raw.validation_rules ?? [])]),
  );
  return {
    id: `seed-${index}-${raw.name}`,
    name: raw.name,
    type: normalizeType(raw),
    originalType: raw.type,
    required: Boolean(raw.required),
    description: raw.description ?? '',
    examples: raw.examples ?? [],
    validators,
    allowedValues: raw.allowed_values ?? [],
  };
}

function buildPromptFragment(field: DesignerField): string {
  const lines: string[] = [];
  lines.push(`Extract "${field.name}" — ${field.required ? 'required' : 'optional'}, type: ${field.type}.`);
  lines.push(field.description.trim() ? field.description.trim() : '(no description provided)');
  if (field.type === 'enum' && field.allowedValues.length > 0) {
    lines.push(`Allowed values: ${field.allowedValues.join(', ')}.`);
  }
  if (field.examples.length > 0) {
    lines.push(`Examples: ${field.examples.join(' | ')}`);
  }
  if (field.validators.length > 0) {
    lines.push(`Must match pattern${field.validators.length > 1 ? 's' : ''}: ${field.validators.join(', ')}`);
  }
  return lines.join('\n');
}

function lintField(field: DesignerField): string[] {
  const warnings: string[] = [];
  if (field.description.includes('`')) {
    warnings.push('Description contains backticks — prompt-injection risk.');
  }
  if (/ignore (all )?(previous|prior) instructions/i.test(field.description)) {
    warnings.push('Description resembles a prompt-injection payload ("ignore previous instructions").');
  }
  if (field.required && !field.description.trim()) {
    warnings.push('Required field has no description — extraction accuracy may suffer.');
  }
  if (!field.name.trim()) {
    warnings.push('Field name is empty.');
  } else if (!/^[a-z][a-z0-9_]*$/.test(field.name)) {
    warnings.push('Field name should be snake_case (e.g. "patient_name").');
  }
  for (const v of field.validators) {
    try {
      new RegExp(v);
    } catch {
      warnings.push(`Validator "${v}" is not a valid regular expression.`);
    }
  }
  if (field.type === 'enum' && field.allowedValues.length === 0) {
    warnings.push('Enum field has no allowed values defined.');
  }
  return warnings;
}

export default function SchemaDesignerPage() {
  const params = useParams();
  const rawName = params?.name;
  const schemaName = Array.isArray(rawName) ? rawName[0] : (rawName as string | undefined) ?? '';

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['schema', schemaName],
    queryFn: () => schemaApi.get(schemaName),
    enabled: Boolean(schemaName),
    retry: (count, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return count < 2;
    },
  });

  const [sections, setSections] = useState<DesignerSection[]>([]);
  const [seeded, setSeeded] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<'draft' | 'published' | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!seeded && data) {
      const raw = (data.fields ?? []) as unknown as RawSchemaField[];
      const initial: DesignerSection = {
        id: 'general',
        name: 'General',
        fields: raw.map(toDesignerField),
      };
      setSections([initial]);
      setExpanded(new Set([initial.id]));
      // If we loaded an already-authored schema, carry its status.
      const loadedStatus = (data as { status?: string }).status;
      if (loadedStatus === 'draft' || loadedStatus === 'published') {
        setStatus(loadedStatus);
      }
      setSeeded(true);
    }
  }, [data, seeded]);

  /** Map the local designer model onto the persistence payload. */
  const buildFieldsPayload = (): SchemaFieldPayload[] =>
    sections.flatMap((s) => s.fields).map((f) => ({
      name: f.name,
      type: f.type,
      required: f.required,
      description: f.description,
      examples: f.examples,
      allowed_values: f.allowedValues,
      validation_rules: f.validators,
    }));

  const saveMutation = useMutation({
    mutationFn: () =>
      saveSchema({
        name: data?.name ?? schemaName,
        description: data?.description ?? '',
        document_type: data?.document_type ?? '',
        version: data?.version ?? '1.0.0',
        fields: buildFieldsPayload(),
      }),
    onSuccess: (saved) => {
      setDirty(false);
      setStatus(saved.status);
      toast.success('Draft saved.');
      qc.invalidateQueries({ queryKey: ['schemas'] });
      qc.invalidateQueries({ queryKey: ['schema', schemaName] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    },
  });

  const publishMutation = useMutation({
    // Publish persists the current edits first, then flips to published,
    // so the published schema always reflects what's on screen.
    mutationFn: async () => {
      await saveSchema({
        name: data?.name ?? schemaName,
        description: data?.description ?? '',
        document_type: data?.document_type ?? '',
        version: data?.version ?? '1.0.0',
        fields: buildFieldsPayload(),
      });
      return publishSchema(data?.name ?? schemaName);
    },
    onSuccess: (published) => {
      setDirty(false);
      setStatus(published.status);
      toast.success('Schema published.');
      qc.invalidateQueries({ queryKey: ['schemas'] });
      qc.invalidateQueries({ queryKey: ['schema', schemaName] });
    },
    onError: (err) => {
      toast.error(err instanceof ApiError ? err.message : 'Publish failed.');
    },
  });

  const busy = saveMutation.isPending || publishMutation.isPending;

  const selectedField =
    sections.flatMap((s) => s.fields).find((f) => f.id === selectedFieldId) ?? null;
  const totalFieldCount = sections.reduce((sum, s) => sum + s.fields.length, 0);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addSection = () => {
    const id = crypto.randomUUID();
    setSections((prev) => [...prev, { id, name: `New section ${prev.length + 1}`, fields: [] }]);
    setExpanded((prev) => new Set(prev).add(id));
    setDirty(true);
  };

  const renameSection = (sectionId: string, name: string) => {
    setSections((prev) => prev.map((s) => (s.id === sectionId ? { ...s, name } : s)));
    setDirty(true);
  };

  const removeSection = (sectionId: string) => {
    const section = sections.find((s) => s.id === sectionId);
    setSections((prev) => prev.filter((s) => s.id !== sectionId));
    if (section?.fields.some((f) => f.id === selectedFieldId)) setSelectedFieldId(null);
    setDirty(true);
  };

  const addField = (sectionId: string) => {
    const id = crypto.randomUUID();
    const newField: DesignerField = {
      id,
      name: 'new_field',
      type: 'string',
      originalType: 'string',
      required: false,
      description: '',
      examples: [],
      validators: [],
      allowedValues: [],
    };
    setSections((prev) =>
      prev.map((s) => (s.id === sectionId ? { ...s, fields: [...s.fields, newField] } : s)),
    );
    setSelectedFieldId(id);
    setDirty(true);
  };

  const updateField = (id: string, patch: Partial<DesignerField>) => {
    setSections((prev) =>
      prev.map((section) => ({
        ...section,
        fields: section.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
      })),
    );
    setDirty(true);
  };

  const removeField = (id: string) => {
    setSections((prev) =>
      prev.map((section) => ({ ...section, fields: section.fields.filter((f) => f.id !== id) })),
    );
    setSelectedFieldId((cur) => (cur === id ? null : cur));
    setDirty(true);
  };

  if (isLoading) {
    return (
      <AppLayout>
        <div className="space-y-6">
          <div className="skeleton h-8 w-48" />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            <div className="lg:col-span-3 skeleton h-[420px]" />
            <div className="lg:col-span-5 skeleton h-[420px]" />
            <div className="lg:col-span-4 skeleton h-[420px]" />
          </div>
        </div>
      </AppLayout>
    );
  }

  if (error || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <AppLayout>
        <div className="card p-10 text-center">
          <span
            className="mx-auto grid place-items-center w-12 h-12 rounded-xl mb-4"
            style={
              notFound
                ? { background: 'rgb(var(--accent-brand-rgb) / 0.12)', color: 'rgb(var(--accent-brand-rgb))' }
                : { background: 'rgb(var(--accent-danger-rgb) / 0.14)', color: 'rgb(var(--accent-danger-rgb))' }
            }
          >
            {notFound ? <Boxes className="w-6 h-6" aria-hidden /> : <AlertCircle className="w-6 h-6" aria-hidden />}
          </span>
          <h3 className="font-display text-h3 font-semibold text-text-primary">
            {notFound ? `Schema "${schemaName}" not found` : 'Failed to load schema'}
          </h3>
          <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
            {notFound
              ? 'It may have been renamed or removed from the registry.'
              : error instanceof ApiError
                ? error.message
                : 'The schema registry could not be reached.'}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2">
            {!notFound && (
              <button type="button" onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5">
                Try again
              </button>
            )}
            <Link href="/schemas" className="btn-primary text-small px-3 py-1.5">
              Back to schemas
            </Link>
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div {...fade(0)} className="flex flex-col gap-3">
          <Link
            href="/schemas"
            className="inline-flex items-center gap-1.5 text-small text-text-secondary hover:text-text-primary transition-colors w-fit"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
            Schemas
          </Link>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h1 className="font-display text-h2 font-semibold text-text-primary">{data.name}</h1>
              <div className="mt-1.5 flex items-center gap-2 flex-wrap">
                <span className="badge-info">{data.document_type}</span>
                <span className="text-small font-mono text-text-muted">v{data.version}</span>
                <span className="text-small text-text-muted">
                  {totalFieldCount} field{totalFieldCount === 1 ? '' : 's'}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {status === 'published' && !dirty && <span className="badge-success">Published</span>}
              {status === 'draft' && !dirty && <span className="badge-info">Draft saved</span>}
              {dirty && <span className="badge-warning">Unsaved changes</span>}
              <button
                type="button"
                onClick={() => saveMutation.mutate()}
                disabled={busy}
                title="Save this schema as a draft override"
                className={cn(
                  'btn-secondary text-small px-3 py-1.5',
                  busy && 'opacity-60 cursor-not-allowed',
                )}
              >
                {saveMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                ) : (
                  <Save className="w-4 h-4" aria-hidden />
                )}
                Save draft
              </button>
              <button
                type="button"
                onClick={() => publishMutation.mutate()}
                disabled={busy}
                title="Persist current edits and mark the schema published"
                className={cn(
                  'btn-primary text-small px-3 py-1.5',
                  busy && 'opacity-60 cursor-not-allowed',
                )}
              >
                {publishMutation.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                ) : (
                  <Rocket className="w-4 h-4" aria-hidden />
                )}
                Publish
              </button>
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Left — sections / fields tree */}
          <motion.div {...fade(0.04)} className="lg:col-span-3">
            <div className="card overflow-hidden">
              <div className="flex items-center justify-between p-4 border-b border-border-default">
                <h2 className="font-display text-h3 font-semibold text-text-primary">Fields</h2>
                <button
                  type="button"
                  onClick={addSection}
                  className="btn-ghost p-1.5"
                  aria-label="Add section"
                  title="Add section"
                >
                  <Plus className="w-4 h-4" aria-hidden />
                </button>
              </div>
              <div className="p-2 max-h-[600px] overflow-y-auto no-scrollbar">
                {sections.map((section) => (
                  <div key={section.id} className="mb-1.5">
                    <div className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-white/5">
                      <button
                        type="button"
                        onClick={() => toggleExpand(section.id)}
                        className="btn-ghost p-1"
                        aria-label={expanded.has(section.id) ? 'Collapse section' : 'Expand section'}
                      >
                        {expanded.has(section.id) ? (
                          <ChevronDown className="w-3.5 h-3.5" aria-hidden />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" aria-hidden />
                        )}
                      </button>
                      <input
                        value={section.name}
                        onChange={(e) => renameSection(section.id, e.target.value)}
                        className="flex-1 min-w-0 bg-transparent text-small font-semibold uppercase tracking-wide text-text-muted outline-none focus:text-text-primary"
                      />
                      <span className="text-small text-text-muted shrink-0">{section.fields.length}</span>
                      <button
                        type="button"
                        onClick={() => addField(section.id)}
                        className="btn-ghost p-1 shrink-0"
                        aria-label={`Add field to ${section.name}`}
                        title="Add field"
                      >
                        <Plus className="w-3.5 h-3.5" aria-hidden />
                      </button>
                      {sections.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeSection(section.id)}
                          className="btn-ghost p-1 shrink-0"
                          aria-label={`Remove ${section.name}`}
                          title="Remove section"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden />
                        </button>
                      )}
                    </div>

                    {expanded.has(section.id) && (
                      <ul className="mt-0.5 space-y-0.5">
                        {section.fields.length === 0 ? (
                          <li className="px-3 py-2 text-small text-text-muted">No fields yet.</li>
                        ) : (
                          section.fields.map((field) => (
                            <FieldTreeRow
                              key={field.id}
                              field={field}
                              active={field.id === selectedFieldId}
                              onClick={() => setSelectedFieldId(field.id)}
                              onRemove={() => removeField(field.id)}
                            />
                          ))
                        )}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </motion.div>

          {/* Center — field editor */}
          <motion.div {...fade(0.08)} className="lg:col-span-5">
            <div className="card p-6">
              {selectedField ? (
                <div className="space-y-5">
                  <div>
                    <label className="text-small text-text-muted">Field name</label>
                    <input
                      className="input mt-1 font-mono"
                      value={selectedField.name}
                      onChange={(e) => updateField(selectedField.id, { name: e.target.value })}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-small text-text-muted">Type</label>
                      <select
                        className="input mt-1"
                        value={selectedField.type}
                        onChange={(e) =>
                          updateField(selectedField.id, { type: e.target.value as EditorFieldType })
                        }
                      >
                        {TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-small text-text-muted block mb-2">Required</label>
                      <Toggle
                        checked={selectedField.required}
                        onChange={(v) => updateField(selectedField.id, { required: v })}
                      />
                    </div>
                  </div>

                  {selectedField.originalType.toLowerCase() !== selectedField.type && (
                    <p className="text-small text-text-muted -mt-2">
                      Backend type: <span className="font-mono">{selectedField.originalType}</span>
                    </p>
                  )}

                  <div>
                    <label className="text-small text-text-muted">Description</label>
                    <textarea
                      className="input mt-1"
                      rows={3}
                      value={selectedField.description}
                      onChange={(e) => updateField(selectedField.id, { description: e.target.value })}
                    />
                  </div>

                  {selectedField.type === 'enum' && (
                    <ChipEditor
                      label="Allowed values"
                      values={selectedField.allowedValues}
                      onChange={(v) => updateField(selectedField.id, { allowedValues: v })}
                      placeholder="Add an allowed value…"
                    />
                  )}

                  <ChipEditor
                    label="Examples"
                    values={selectedField.examples}
                    onChange={(v) => updateField(selectedField.id, { examples: v })}
                    placeholder="Add an example value…"
                  />

                  <RegexEditor
                    label="Validators (regex)"
                    values={selectedField.validators}
                    onChange={(v) => updateField(selectedField.id, { validators: v })}
                  />

                  {(selectedField.type === 'list' || selectedField.type === 'object') && (
                    <p className="text-small text-text-muted italic">
                      Nested {selectedField.type} field editing isn&apos;t supported in this preview —
                      this field is tracked as a single leaf value.
                    </p>
                  )}
                </div>
              ) : (
                <div className="py-16 text-center">
                  <span
                    className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
                    style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                  >
                    <Boxes className="w-6 h-6" aria-hidden />
                  </span>
                  <h3 className="font-display text-h3 font-semibold text-text-primary">
                    Select a field to edit
                  </h3>
                  <p className="mt-2 text-body text-text-secondary">
                    Pick a field from the tree, or add a new one to a section.
                  </p>
                </div>
              )}
            </div>
          </motion.div>

          {/* Right — prompt fragment preview + linter */}
          <motion.div {...fade(0.12)} className="lg:col-span-4 space-y-4">
            <div className="card p-5">
              <h2 className="font-display text-h3 font-semibold text-text-primary mb-3">Prompt fragment</h2>
              {selectedField ? (
                <pre
                  className="text-small font-mono text-text-secondary whitespace-pre-wrap leading-relaxed p-3 rounded-xl glass-hairline"
                  style={{ background: 'rgb(var(--bg-surface-rgb) / 0.4)' }}
                >
                  {buildPromptFragment(selectedField)}
                </pre>
              ) : (
                <p className="text-body text-text-muted">
                  Select a field to preview its generated prompt fragment.
                </p>
              )}
            </div>

            <div className="card p-5">
              <h2 className="font-display text-h3 font-semibold text-text-primary mb-3">Linter</h2>
              {selectedField ? (
                (() => {
                  const warnings = lintField(selectedField);
                  return warnings.length === 0 ? (
                    <p className="text-body text-text-secondary flex items-center gap-2">
                      <CheckCircle2
                        className="w-4 h-4 shrink-0"
                        style={{ color: 'rgb(var(--accent-success-rgb))' }}
                        aria-hidden
                      />
                      No issues found.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {warnings.map((w) => (
                        <li key={w} className="flex items-start gap-2 text-body text-text-secondary">
                          <AlertTriangle
                            className="w-4 h-4 mt-0.5 shrink-0"
                            style={{ color: 'rgb(var(--accent-warning-rgb))' }}
                            aria-hidden
                          />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  );
                })()
              ) : (
                <p className="text-body text-text-muted">Select a field to run the linter.</p>
              )}
            </div>
          </motion.div>
        </div>
      </div>
    </AppLayout>
  );
}

function FieldTreeRow({
  field,
  active,
  onClick,
  onRemove,
}: {
  field: DesignerField;
  active: boolean;
  onClick: () => void;
  onRemove: () => void;
}) {
  return (
    <li>
      <div
        className={cn(
          'group relative flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors duration-fast hover:bg-white/5',
        )}
        style={active ? { background: 'rgb(var(--accent-brand-rgb) / 0.1)' } : undefined}
        onClick={onClick}
      >
        {active && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-accent-brand"
            aria-hidden
          />
        )}
        <span className="font-mono text-body text-text-primary truncate flex-1">
          {field.name || '(unnamed)'}
        </span>
        {field.required && (
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: 'rgb(var(--accent-warning-rgb))' }}
            title="Required"
          />
        )}
        <span className="badge-info shrink-0">{field.type}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="btn-ghost p-1 opacity-0 group-hover:opacity-100 shrink-0"
          aria-label={`Remove ${field.name}`}
        >
          <Trash2 className="w-3 h-3" aria-hidden />
        </button>
      </div>
    </li>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors duration-fast glass-hairline"
      style={{ background: checked ? 'rgb(var(--accent-brand-rgb) / 0.9)' : 'rgb(var(--text-primary-rgb) / 0.08)' }}
    >
      <span
        className="inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-fast"
        style={{ transform: checked ? 'translateX(22px)' : 'translateX(4px)' }}
      />
    </button>
  );
}

function ChipEditor({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (!v || values.includes(v)) {
      setDraft('');
      return;
    }
    onChange([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <label className="text-small text-text-muted">{label}</label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {values.length === 0 && <span className="text-small text-text-muted">None yet.</span>}
        {values.map((v) => (
          <span key={v} className="badge-info">
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              className="ml-0.5"
            >
              <X className="w-3 h-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          className="input flex-1"
          value={draft}
          placeholder={placeholder ?? 'Add a value…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add} className="btn-secondary text-small px-3">
          Add
        </button>
      </div>
    </div>
  );
}

function RegexEditor({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    try {
      new RegExp(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Invalid regular expression');
      return;
    }
    if (!values.includes(v)) onChange([...values, v]);
    setDraft('');
    setErr(null);
  };

  return (
    <div>
      <label className="text-small text-text-muted">{label}</label>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {values.length === 0 && <span className="text-small text-text-muted">None yet.</span>}
        {values.map((v) => (
          <span
            key={v}
            className="badge font-mono"
            style={{ background: 'rgb(var(--text-primary-rgb) / 0.06)', color: 'rgb(var(--text-secondary-rgb))' }}
          >
            {v}
            <button
              type="button"
              onClick={() => onChange(values.filter((x) => x !== v))}
              aria-label={`Remove ${v}`}
              className="ml-0.5"
            >
              <X className="w-3 h-3" aria-hidden />
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          className="input flex-1 font-mono"
          value={draft}
          placeholder="^[A-Z0-9]+$"
          onChange={(e) => {
            setDraft(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add} className="btn-secondary text-small px-3">
          Add
        </button>
      </div>
      {err && (
        <p className="mt-1 text-small" style={{ color: 'rgb(var(--accent-danger-rgb))' }}>
          {err}
        </p>
      )}
    </div>
  );
}
