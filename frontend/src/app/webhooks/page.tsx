'use client';

/**
 * Webhooks — subscriptions, delivery log, and dead-letter queue.
 *
 * The backend exposes a webhooks router but its exact response/request
 * shapes aren't confirmed from here, so:
 *  - Subscriptions attempts a real `GET /api/v1/webhooks` and normalises
 *    across a handful of plausible field names (see lib/api/integrate.ts).
 *    An error or empty payload renders an honest empty state.
 *  - Delivery log / Dead-letter queue have no confirmed read endpoint at
 *    all, so they render as clearly-labelled "not wired yet" states
 *    rather than guessing a path that might not exist.
 *  - "New subscription" is a labelled UI stub — the POST body shape for
 *    creating a subscription isn't confirmed, so submitting never calls
 *    the network; it says so plainly.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import toast from 'react-hot-toast';
import {
  Webhook,
  Plus,
  X,
  Inbox,
  AlertTriangle,
  RefreshCw,
  Link2,
  KeyRound,
  Send,
  Radio,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { cn, formatRelativeTime } from '@/lib/utils';
import { fetchWebhookSubscriptions, type WebhookSubscription } from '@/lib/api/integrate';

const fade = (delay = 0) => ({
  initial: { opacity: 0, y: 12 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.35, delay, ease: [0.16, 1, 0.3, 1] as const },
});

type WebhookTab = 'subscriptions' | 'deliveries' | 'dlq';

const TABS: { id: WebhookTab; label: string }[] = [
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'deliveries', label: 'Delivery log' },
  { id: 'dlq', label: 'Dead-letter queue' },
];

export default function WebhooksPage() {
  const [tab, setTab] = useState<WebhookTab>('subscriptions');
  const [showCreate, setShowCreate] = useState(false);

  const subscriptions = useQuery({
    queryKey: ['webhooks', 'subscriptions'],
    queryFn: fetchWebhookSubscriptions,
    retry: 1,
  });

  return (
    <AppLayout>
      <div className="space-y-6">
        <motion.div
          {...fade(0)}
          className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div>
            <h1 className="font-display text-h2 font-semibold text-text-primary flex items-center gap-2.5">
              <Webhook className="w-5 h-5 text-accent-brand" aria-hidden />
              Webhooks
            </h1>
            <p className="mt-1 text-body text-text-secondary">
              Event subscriptions, delivery history, and failed-delivery recovery.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => subscriptions.refetch()}
              className="btn-secondary text-small px-3 py-1.5"
            >
              <RefreshCw
                className={cn('w-4 h-4', subscriptions.isFetching && 'animate-spin')}
                aria-hidden
              />
              Refresh
            </button>
            <button onClick={() => setShowCreate(true)} className="btn-primary text-small px-3 py-1.5">
              <Plus className="w-4 h-4" aria-hidden />
              New subscription
            </button>
          </div>
        </motion.div>

        <motion.div {...fade(0.04)} className="flex items-center gap-1.5 flex-wrap">
          {TABS.map((t) => (
            <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </TabButton>
          ))}
        </motion.div>

        <motion.div {...fade(0.08)}>
          {tab === 'subscriptions' && <SubscriptionsPanel query={subscriptions} />}
          {tab === 'deliveries' && (
            <NotWiredPanel
              icon={Send}
              title="Delivery log unavailable"
              body="There's no confirmed backend endpoint for webhook delivery history yet. Once the webhooks router exposes a deliveries read path, this tab will list each attempt with its response code, latency, and retry count."
            />
          )}
          {tab === 'dlq' && (
            <NotWiredPanel
              icon={Inbox}
              title="Dead-letter queue unavailable"
              body="There's no confirmed backend endpoint for permanently-failed deliveries yet. Once exposed, this tab will list dead-lettered events with a replay action per item."
            />
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {showCreate && <NewSubscriptionModal onClose={() => setShowCreate(false)} />}
      </AnimatePresence>
    </AppLayout>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3.5 py-2 rounded-xl text-body font-medium transition-colors duration-fast',
        active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
      )}
      style={
        active
          ? {
              background: 'rgb(var(--accent-brand-rgb) / 0.12)',
              boxShadow: 'inset 0 0 0 1px rgb(var(--accent-brand-rgb) / 0.25)',
            }
          : undefined
      }
    >
      {children}
    </button>
  );
}

function SubscriptionsPanel({
  query,
}: {
  query: ReturnType<typeof useQuery<WebhookSubscription[]>>;
}) {
  const { data, isLoading, isError } = query;
  const subs = data ?? [];

  if (isLoading) {
    return (
      <div className="card p-4 space-y-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-14 w-full" />
        ))}
      </div>
    );
  }

  if (isError || subs.length === 0) {
    return (
      <div className="card p-10 text-center">
        <span
          className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-accent-brand mb-4"
          style={{ background: 'rgb(var(--accent-brand-rgb) / 0.12)' }}
        >
          <Webhook className="w-6 h-6" aria-hidden />
        </span>
        <h3 className="font-display text-h3 font-semibold text-text-primary">
          No subscriptions — webhooks API returned nothing
        </h3>
        <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">
          {isError
            ? 'The webhooks endpoint didn’t respond successfully. Create a subscription once the backend is reachable, or check the API URL configuration.'
            : 'No webhook subscriptions are configured yet. Create one to start receiving extraction.* events.'}
        </p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <thead>
            <tr className="border-b border-border-default text-small text-text-muted">
              <th className="text-left font-medium px-4 py-3">URL</th>
              <th className="text-left font-medium px-4 py-3">Events</th>
              <th className="text-left font-medium px-4 py-3">Secret rotated</th>
              <th className="text-left font-medium px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-default">
            {subs.map((sub) => (
              <SubscriptionRow key={sub.id} sub={sub} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SubscriptionRow({ sub }: { sub: WebhookSubscription }) {
  const [active, setActive] = useState(sub.active);

  return (
    <tr className="hover:bg-white/5 transition-colors">
      <td className="px-4 py-3 max-w-xs">
        <div className="flex items-center gap-2 min-w-0">
          <Link2 className="w-3.5 h-3.5 text-text-muted flex-shrink-0" aria-hidden />
          <span className="font-mono text-small text-text-primary truncate" title={sub.url || undefined}>
            {sub.url || '—'}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        {sub.events.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {sub.events.map((ev) => (
              <span key={ev} className="badge-info font-mono">
                {ev}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-small text-text-muted">no events configured</span>
        )}
      </td>
      <td className="px-4 py-3 text-small text-text-secondary whitespace-nowrap">
        {sub.secretRotatedAt ? formatRelativeTime(sub.secretRotatedAt) : 'unknown'}
      </td>
      <td className="px-4 py-3">
        <ToggleStub
          active={active}
          onToggle={() => {
            setActive((v) => !v);
            toast('Toggling isn’t wired to a confirmed endpoint yet.', { icon: '⚠️' });
          }}
        />
      </td>
    </tr>
  );
}

function ToggleStub({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={active ? 'Disable subscription' : 'Enable subscription'}
      onClick={onToggle}
      className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors duration-fast flex-shrink-0"
      style={{
        background: active
          ? 'rgb(var(--accent-success-rgb) / 0.4)'
          : 'rgb(var(--text-primary-rgb) / 0.12)',
      }}
    >
      <span
        className="inline-block h-3.5 w-3.5 rounded-full transition-transform duration-fast"
        style={{
          background: 'rgb(var(--bg-surface-raised-rgb))',
          boxShadow: '0 0 0 1px rgb(var(--border-strong-rgb))',
          transform: active ? 'translateX(1.1rem)' : 'translateX(0.2rem)',
        }}
      />
    </button>
  );
}

function NotWiredPanel({
  icon: Icon,
  title,
  body,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
}) {
  return (
    <div className="card p-10 text-center">
      <span
        className="mx-auto grid place-items-center w-12 h-12 rounded-xl text-text-muted mb-4"
        style={{ background: 'rgb(var(--text-primary-rgb) / 0.06)' }}
      >
        <Icon className="w-6 h-6" aria-hidden />
      </span>
      <h3 className="font-display text-h3 font-semibold text-text-primary">{title}</h3>
      <p className="mt-2 max-w-md mx-auto text-body text-text-secondary">{body}</p>
    </div>
  );
}

const COMMON_EVENTS = [
  'extraction.completed',
  'extraction.failed',
  'extraction.requires_review',
  'document.uploaded',
];

function NewSubscriptionModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['extraction.completed']);
  const [secret, setSecret] = useState('');

  const toggleEvent = (ev: string) => {
    setEvents((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    toast(
      'This is a preview form — creating a subscription needs a confirmed POST /api/v1/webhooks contract, so nothing was sent.',
      { icon: 'ℹ️', duration: 6000 },
    );
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="absolute inset-0"
        style={{ background: 'rgb(var(--bg-overlay-rgb) / 0.55)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-subscription-title"
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 16 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="card relative w-full max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-start justify-between gap-4 p-5 border-b border-border-default">
          <div>
            <h2 id="new-subscription-title" className="font-display text-h3 font-semibold text-text-primary">
              New subscription
            </h2>
            <p className="mt-1 text-small text-text-secondary">
              Deliver signed event payloads to an HTTPS endpoint.
            </p>
          </div>
          <button onClick={onClose} className="btn-ghost p-1.5 flex-shrink-0" aria-label="Close">
            <X className="w-4 h-4" aria-hidden />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div
            className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-small"
            style={{ background: 'rgb(var(--accent-warning-rgb) / 0.12)', color: 'rgb(var(--accent-warning-rgb))' }}
          >
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" aria-hidden />
            <span>
              Preview only — the create-subscription request shape isn&apos;t confirmed yet, so submitting
              won&apos;t call the API.
            </span>
          </div>

          <div>
            <label htmlFor="webhook-url" className="block text-small font-medium text-text-secondary mb-1.5">
              Endpoint URL
            </label>
            <input
              id="webhook-url"
              type="url"
              required
              placeholder="https://your-service.example.com/hooks/veridoc"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="input font-mono"
            />
          </div>

          <div>
            <span className="block text-small font-medium text-text-secondary mb-1.5">Events</span>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_EVENTS.map((ev) => {
                const selected = events.includes(ev);
                return (
                  <button
                    key={ev}
                    type="button"
                    onClick={() => toggleEvent(ev)}
                    className={cn('font-mono', selected ? 'badge-primary' : 'badge-info')}
                    style={!selected ? { opacity: 0.5 } : undefined}
                    aria-pressed={selected}
                  >
                    {ev}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="webhook-secret" className="block text-small font-medium text-text-secondary mb-1.5">
              Signing secret
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <KeyRound
                  className="w-3.5 h-3.5 text-text-muted absolute left-3.5 top-1/2 -translate-y-1/2"
                  aria-hidden
                />
                <input
                  id="webhook-secret"
                  type="text"
                  placeholder="whsec_..."
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  className="input font-mono pl-9"
                />
              </div>
              <button
                type="button"
                className="btn-secondary text-small px-3 py-2.5"
                onClick={() =>
                  setSecret(
                    `whsec_${Array.from({ length: 24 }, () =>
                      '0123456789abcdef'[Math.floor(Math.random() * 16)],
                    ).join('')}`,
                  )
                }
              >
                Generate
              </button>
            </div>
            <p className="mt-1.5 text-small text-text-muted flex items-center gap-1.5">
              <Radio className="w-3 h-3" aria-hidden />
              Used to sign the <code className="font-mono">X-Veridoc-Signature</code> header on each delivery.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-small px-3.5 py-2">
              Cancel
            </button>
            <button type="submit" className="btn-primary text-small px-3.5 py-2">
              <Plus className="w-4 h-4" aria-hidden />
              Create subscription
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
