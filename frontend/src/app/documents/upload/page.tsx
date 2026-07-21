'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { useDropzone, type FileRejection } from 'react-dropzone';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Info,
  Loader2,
  Upload as UploadIcon,
  X,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { ApiError, documentsApi } from '@/lib/api';
import { cn, formatFileSize, generateId } from '@/lib/utils';
import { MODE_LABELS, modeToProfileOverride, type ModeKey } from '@/lib/branding';
import type { ExtractionMode } from '@/types/api';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

const MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
const MAX_FILES = 12;

const ACCEPTED_TYPES: Record<string, string[]> = {
  'application/pdf': ['.pdf'],
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/tiff': ['.tif', '.tiff'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};

const EXTRACTION_MODES: { value: ExtractionMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Auto', hint: 'Let the analyzer decide single vs. multi-record.' },
  { value: 'single', label: 'Single record', hint: 'One entity per document.' },
  { value: 'multi', label: 'Multi record', hint: 'Separate distinct entities per row.' },
];

type QueuedStatus = 'queued' | 'uploading' | 'success' | 'error';

interface QueuedFile {
  id: string;
  file: File;
  status: QueuedStatus;
  progress: number;
  error?: string;
  taskId?: string;
}

function statusIcon(status: QueuedStatus) {
  switch (status) {
    case 'uploading':
      return <Loader2 className="w-4 h-4 animate-spin text-accent-brand" aria-hidden />;
    case 'success':
      return <CheckCircle2 className="w-4 h-4 conf-high" aria-hidden />;
    case 'error':
      return <AlertTriangle className="w-4 h-4 conf-low" aria-hidden />;
    default:
      return <FileText className="w-4 h-4 text-text-muted" aria-hidden />;
  }
}

export default function DocumentUploadPage() {
  const [files, setFiles] = useState<QueuedFile[]>([]);
  const [mode, setMode] = useState<ModeKey>('auto');
  const [extractionMode, setExtractionMode] = useState<ExtractionMode>('auto');
  const [maskPhi, setMaskPhi] = useState(false);

  const onDrop = useCallback((accepted: File[], rejections: FileRejection[]) => {
    rejections.forEach((r) => {
      const code = r.errors[0]?.code;
      const reason =
        code === 'file-too-large'
          ? `${r.file.name} exceeds ${formatFileSize(MAX_SIZE_BYTES)}`
          : code === 'file-invalid-type'
            ? `${r.file.name} isn't a supported file type`
            : (r.errors[0]?.message ?? `${r.file.name} was rejected`);
      toast.error(reason);
    });

    if (accepted.length === 0) return;

    setFiles((prev) => [
      ...prev,
      ...accepted.map((file) => ({
        id: generateId(),
        file,
        status: 'queued' as const,
        progress: 0,
      })),
    ]);
  }, []);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_SIZE_BYTES,
    maxFiles: MAX_FILES,
    multiple: true,
  });

  const uploadMutation = useMutation({
    mutationFn: async (qf: QueuedFile) => {
      return documentsApi.upload(
        qf.file,
        {
          mask_phi: maskPhi,
          extraction_mode: extractionMode,
          profile_override: modeToProfileOverride(mode) ?? undefined,
        },
        (progress) => {
          setFiles((prev) => prev.map((f) => (f.id === qf.id ? { ...f, progress } : f)));
        },
      );
    },
    onSuccess: (response, qf) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === qf.id ? { ...f, status: 'success', progress: 100, taskId: response.task_id } : f,
        ),
      );
      toast.success(`${qf.file.name} queued for extraction`);
    },
    onError: (error: unknown, qf) => {
      const message = error instanceof ApiError ? error.message : 'Upload failed';
      setFiles((prev) =>
        prev.map((f) => (f.id === qf.id ? { ...f, status: 'error', error: message } : f)),
      );
      toast.error(`${qf.file.name} failed to upload`);
    },
  });

  const removeFile = (id: string) => setFiles((prev) => prev.filter((f) => f.id !== id));

  const handleSubmit = async () => {
    const queued = files.filter((f) => f.status === 'queued' || f.status === 'error');
    for (const qf of queued) {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === qf.id ? { ...f, status: 'uploading', progress: 0, error: undefined } : f,
        ),
      );
      try {
        await uploadMutation.mutateAsync(qf);
      } catch {
        // handled in onError
      }
    }
  };

  const isUploading = files.some((f) => f.status === 'uploading');
  const canSubmit = files.some((f) => f.status === 'queued' || f.status === 'error') && !isUploading;
  const anySucceeded = files.some((f) => f.status === 'success');

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div {...fade(0)}>
          <p className="text-body text-text-secondary">
            Drop in documents for dual-VLM extraction with provenance.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Dropzone + queue */}
          <div className="lg:col-span-2 space-y-4">
            <motion.div {...fade(0.03)}>
              <div
                {...getRootProps()}
                className={cn(
                  'glass-hairline rounded-2xl border-2 border-dashed p-10 flex flex-col items-center justify-center text-center cursor-pointer transition-colors duration-fast',
                  isDragReject
                    ? 'border-accent-danger'
                    : isDragActive
                      ? 'border-accent-brand'
                      : 'border-border-default hover:border-border-strong',
                )}
              >
                <input {...getInputProps()} />
                <span
                  className="grid place-items-center w-14 h-14 rounded-2xl text-accent-brand mb-4"
                  style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
                >
                  <UploadIcon className="w-7 h-7" aria-hidden />
                </span>
                <p className="text-body text-text-primary font-medium">
                  {isDragActive ? 'Drop to queue' : 'Drag & drop files here'}
                </p>
                <p className="mt-1 text-small text-text-muted">or click to browse</p>
                <p className="mt-4 text-small text-text-muted">
                  PDF · PNG · JPEG · TIFF · DOCX · XLSX — max {formatFileSize(MAX_SIZE_BYTES)} each
                </p>
              </div>
            </motion.div>

            {files.length > 0 && (
              <motion.div {...fade(0.06)} className="card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border-default">
                  <h2 className="font-display text-h3 font-semibold text-text-primary">
                    Queue ({files.length})
                  </h2>
                  {anySucceeded && (
                    <Link href="/tasks" className="text-small text-accent-brand">
                      View queue →
                    </Link>
                  )}
                </div>
                <ul className="divide-y divide-border-default max-h-[420px] overflow-y-auto no-scrollbar">
                  <AnimatePresence initial={false}>
                    {files.map((qf) => (
                      <motion.li
                        key={qf.id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 10 }}
                        className="px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          <span
                            className="grid place-items-center w-9 h-9 rounded-xl flex-shrink-0"
                            style={{ background: 'rgb(var(--text-primary-rgb) / 0.06)' }}
                          >
                            {statusIcon(qf.status)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-body text-text-primary truncate">{qf.file.name}</p>
                            <div className="flex items-center gap-2 text-small text-text-muted">
                              <span>{formatFileSize(qf.file.size)}</span>
                              {qf.status === 'error' && qf.error && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span className="conf-low truncate">{qf.error}</span>
                                </>
                              )}
                              {qf.status === 'success' && qf.taskId && (
                                <>
                                  <span aria-hidden>·</span>
                                  <span className="font-mono truncate">
                                    task {qf.taskId.slice(0, 8)}
                                  </span>
                                </>
                              )}
                            </div>
                            {qf.status === 'uploading' && (
                              <div
                                className="mt-2 h-1.5 rounded-full overflow-hidden"
                                style={{ background: 'rgb(var(--text-primary-rgb) / 0.08)' }}
                              >
                                <div
                                  className="h-full rounded-full bg-accent-brand transition-all duration-300"
                                  style={{ width: `${qf.progress}%` }}
                                />
                              </div>
                            )}
                          </div>
                          {(qf.status === 'queued' || qf.status === 'error') && (
                            <button
                              onClick={() => removeFile(qf.id)}
                              className="btn-ghost p-1.5 flex-shrink-0"
                              aria-label={`Remove ${qf.file.name}`}
                            >
                              <X className="w-4 h-4" aria-hidden />
                            </button>
                          )}
                        </div>
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ul>
              </motion.div>
            )}
          </div>

          {/* Options panel */}
          <motion.div {...fade(0.08)} className="space-y-4">
            <div className="card p-5 space-y-3">
              <h2 className="font-display text-h3 font-semibold text-text-primary">Profile</h2>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(MODE_LABELS) as ModeKey[]).map((key) => {
                  const cfg = MODE_LABELS[key];
                  const active = mode === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setMode(key)}
                      aria-pressed={active}
                      className={cn('btn-secondary text-small px-3 py-1.5', active && 'text-accent-brand')}
                      style={
                        active
                          ? {
                              background: 'rgb(var(--accent-brand-rgb) / 0.12)',
                              borderColor: 'rgb(var(--accent-brand-rgb) / 0.4)',
                            }
                          : undefined
                      }
                    >
                      <span aria-hidden>{cfg.icon}</span>
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-small text-text-muted">{MODE_LABELS[mode].description}</p>
            </div>

            <div className="card p-5 space-y-3">
              <h2 className="font-display text-h3 font-semibold text-text-primary">Extraction mode</h2>
              <div className="flex flex-wrap gap-2">
                {EXTRACTION_MODES.map((em) => {
                  const active = extractionMode === em.value;
                  return (
                    <button
                      key={em.value}
                      type="button"
                      onClick={() => setExtractionMode(em.value)}
                      aria-pressed={active}
                      title={em.hint}
                      className={cn('btn-secondary text-small px-3 py-1.5', active && 'text-accent-brand')}
                      style={
                        active
                          ? {
                              background: 'rgb(var(--accent-brand-rgb) / 0.12)',
                              borderColor: 'rgb(var(--accent-brand-rgb) / 0.4)',
                            }
                          : undefined
                      }
                    >
                      {em.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div
              className="rounded-2xl p-4 flex gap-2.5 glass-hairline"
              style={{ background: 'rgb(var(--accent-brand-rgb) / 0.06)' }}
            >
              <Info className="w-4 h-4 flex-shrink-0 text-accent-brand mt-0.5" aria-hidden />
              <p className="text-small text-text-secondary">
                Modality (printed, handwritten, table, form, fax, visual) is auto-detected per page —
                there&apos;s no manual override here yet. The analyzer picks the extraction strategy
                that fits each document.
              </p>
            </div>

            <div className="card p-4 flex items-center justify-between gap-3">
              <div>
                <p className="text-body text-text-primary font-medium">Mask PHI in exports</p>
                <p className="text-small text-text-muted">Redacts names, SSNs, emails, phone numbers.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={maskPhi}
                onClick={() => setMaskPhi((v) => !v)}
                className="relative w-11 h-6 rounded-full flex-shrink-0 transition-colors duration-fast"
                style={{
                  background: maskPhi
                    ? 'rgb(var(--accent-brand-rgb))'
                    : 'rgb(var(--text-primary-rgb) / 0.15)',
                }}
              >
                <span
                  className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-fast"
                  style={{ transform: maskPhi ? 'translateX(20px)' : 'translateX(0)' }}
                />
              </button>
            </div>

            <button
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="btn-primary w-full justify-center"
            >
              {isUploading ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
              ) : (
                <UploadIcon className="w-4 h-4" aria-hidden />
              )}
              {isUploading ? 'Uploading…' : 'Start extraction'}
            </button>
          </motion.div>
        </div>
      </div>
    </AppLayout>
  );
}
