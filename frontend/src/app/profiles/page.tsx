'use client';

/**
 * Profiles gallery — the document profiles the extraction engine can
 * target. Now backed by the live `GET /api/v1/profiles` endpoint, which
 * enumerates the built-in descriptors registered in `src/profiles/*.py`
 * (generic-document, medical-rcm, finance). Descriptions, doc types,
 * validator-pack counts, and specialised emitters all come straight off
 * those descriptors — nothing here is fabricated.
 */

import { motion } from 'framer-motion';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, FileStack, Layers, ShieldCheck } from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { fetchProfiles, type Profile } from '@/lib/api/build';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

/** Export formats every profile ships with, regardless of specialisation. */
const BASELINE_EMITTERS = ['JSON', 'Excel', 'Markdown', 'Bbox overlay', 'Signed receipt'];

/** Friendly labels for the specialised emitter ids the backend returns. */
const EMITTER_LABELS: Record<string, string> = {
  ccda: 'C-CDA',
  x12_275: 'X12 275',
  x12_837: 'X12 837',
  fhir: 'FHIR R4',
};

function emitterLabel(id: string): string {
  return EMITTER_LABELS[id] ?? id.replace(/_/g, ' ').toUpperCase();
}

function displayEmitters(profile: Profile): string[] {
  return [...BASELINE_EMITTERS, ...profile.emitters.map(emitterLabel)];
}

export default function ProfilesPage() {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['profiles'],
    queryFn: fetchProfiles,
  });

  const profiles = data ?? [];
  const builtInCount = profiles.filter((p) => p.tier === 'built-in').length;
  const communityCount = profiles.filter((p) => p.tier !== 'built-in').length;
  const totalValidators = profiles.reduce((sum, p) => sum + p.validator_count, 0);

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div {...fade(0)}>
          <p className="text-body text-text-secondary max-w-3xl">
            Document profiles tune detection signals, prompt notes, validator packs, and export
            emitters per document category. Auto-detect picks one automatically; the upload flow
            also lets you force one via <span className="font-mono text-small">profile_override</span>.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Built-in" delay={0.02} value={builtInCount} loading={isLoading} icon={<Layers className="w-4 h-4" />} />
          <StatCard label="Community" delay={0.05} value={communityCount} loading={isLoading} icon={<FileStack className="w-4 h-4" />} />
          <StatCard label="Validator packs" delay={0.08} value={totalValidators} loading={isLoading} icon={<ShieldCheck className="w-4 h-4" />} />
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[420px]" />
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
            <h3 className="font-display text-h3 font-semibold text-text-primary">Couldn’t load profiles</h3>
            <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
              The profiles endpoint could not be reached.
            </p>
            <button type="button" onClick={() => refetch()} className="btn-secondary text-small px-3 py-1.5 mt-5">
              Try again
            </button>
          </div>
        ) : profiles.length === 0 ? (
          <div className="card p-10 text-center">
            <span
              className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
              style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
            >
              <Layers className="w-6 h-6" aria-hidden />
            </span>
            <h3 className="font-display text-h3 font-semibold text-text-primary">No profiles registered</h3>
            <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
              The extraction engine has no document profiles registered.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {profiles.map((profile, i) => (
              <ProfileCardView key={profile.id} profile={profile} delay={0.02 * i} />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
}

function StatCard({
  label,
  value,
  delay,
  loading,
  icon,
}: {
  label: string;
  value: number;
  delay: number;
  loading: boolean;
  icon: React.ReactNode;
}) {
  return (
    <motion.div {...fade(delay)} className="stat-card">
      <div className="flex items-center justify-between">
        <span className="stat-label">{label}</span>
        <span
          className="grid place-items-center w-8 h-8 rounded-lg text-accent-brand"
          style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
        >
          {icon}
        </span>
      </div>
      <div className="stat-value">{loading ? '—' : value}</div>
    </motion.div>
  );
}

function ProfileCardView({ profile, delay }: { profile: Profile; delay: number }) {
  const emitters = displayEmitters(profile);
  return (
    <motion.div {...fade(delay)}>
      <div className="card-hover p-6 h-full flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <span
            className="grid place-items-center w-10 h-10 rounded-xl text-accent-brand shrink-0"
            style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
          >
            <Layers className="w-5 h-5" aria-hidden />
          </span>
          <span className={profile.tier === 'built-in' ? 'badge-success' : 'badge-info'}>
            {profile.tier === 'built-in' ? 'Built-in' : 'Available'}
          </span>
        </div>

        <h3 className="mt-4 font-display text-h3 font-semibold text-text-primary">{profile.name}</h3>
        <p className="mt-0.5 font-mono text-small text-text-muted">{profile.id}</p>

        <p className="mt-3 text-body text-text-secondary flex-1">{profile.description}</p>

        {profile.doc_types.length > 0 && (
          <div className="mt-4">
            <p className="text-small uppercase tracking-wide text-text-muted mb-1.5">Document types</p>
            <div className="flex flex-wrap gap-1.5">
              {profile.doc_types.map((dt) => (
                <span key={dt} className="badge-info">
                  {dt}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="mt-3 flex items-center gap-1.5 text-small text-text-secondary">
          <ShieldCheck className="w-3.5 h-3.5 text-accent-brand" aria-hidden />
          <span>
            {profile.validator_count} validator pack{profile.validator_count === 1 ? '' : 's'}
          </span>
        </div>

        <div className="mt-3">
          <p className="text-small uppercase tracking-wide text-text-muted mb-1.5">Emitters</p>
          <div className="flex flex-wrap gap-1.5">
            {emitters.map((e) => (
              <span
                key={e}
                className="badge font-mono"
                style={{ background: 'rgb(var(--text-primary-rgb) / 0.06)', color: 'rgb(var(--text-secondary-rgb))' }}
              >
                {e}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-5 pt-4 border-t border-border-default">
          <button
            type="button"
            disabled
            title="Profile configuration isn't wired up yet"
            className="btn-secondary text-small px-3 py-1.5 w-full justify-center opacity-60 cursor-not-allowed"
          >
            Configure
            <span className="text-small text-text-muted">(soon)</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}
