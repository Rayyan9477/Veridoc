'use client';

/**
 * Settings — Display tab is fully built (theme, density, default landing
 * tab, timezone, date format); the rest are labeled placeholders since
 * there's no settings-persistence endpoint yet. Everything here is
 * either wired to the real theme mechanism (`useTheme`) or persisted to
 * `localStorage` only — never claimed as "saved to server".
 */

import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  Blocks,
  Building2,
  Check,
  LayoutPanelLeft,
  Monitor,
  Moon,
  Palette,
  Settings as SettingsIcon,
  Sun,
  User,
  Wrench,
} from 'lucide-react';
import { AppLayout } from '@/components/layout';
import { useAuth } from '@/hooks/useAuth';
import { useTheme, type ThemeChoice } from '@/components/ThemeProvider';
import { cn } from '@/lib/utils';
import { NAV_GROUPS } from '@/components/layout/nav-config';

type SettingsTab = 'profile' | 'display' | 'notifications' | 'integrations' | 'tenant' | 'advanced';

const TABS: { id: SettingsTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'display', label: 'Display', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: SettingsIcon },
  { id: 'integrations', label: 'API & Integrations', icon: Blocks },
  { id: 'tenant', label: 'Tenant', icon: Building2 },
  { id: 'advanced', label: 'Advanced', icon: Wrench },
];

type Density = 'comfortable' | 'compact';
type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD' | 'MMM D, YYYY';

const LANDING_TAB_OPTIONS = NAV_GROUPS.flatMap((g) => g.items).filter((item) =>
  ['/dashboard', '/documents', '/tasks', '/schemas', '/security'].includes(item.href),
);

const TIMEZONE_OPTIONS = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
];

const DATE_FORMAT_OPTIONS: DateFormat[] = ['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'MMM D, YYYY'];

function formatWithPattern(date: Date, pattern: DateFormat): string {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  const monthShort = date.toLocaleDateString('en-US', { month: 'short' });
  switch (pattern) {
    case 'MM/DD/YYYY':
      return `${mm}/${dd}/${yyyy}`;
    case 'DD/MM/YYYY':
      return `${dd}/${mm}/${yyyy}`;
    case 'YYYY-MM-DD':
      return `${yyyy}-${mm}-${dd}`;
    case 'MMM D, YYYY':
      return `${monthShort} ${date.getDate()}, ${yyyy}`;
    default:
      return date.toLocaleDateString();
  }
}

const LS_KEYS = {
  density: 'veridoc:settings:density',
  landingTab: 'veridoc:settings:landing-tab',
  timezone: 'veridoc:settings:timezone',
  dateFormat: 'veridoc:settings:date-format',
} as const;

function readLocal(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage disabled (private mode) — preference just won't persist.
  }
}

function Placeholder({
  icon: Icon,
  title,
  description,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <div className="py-14 text-center space-y-2">
      <Icon className="w-8 h-8 mx-auto text-text-muted" aria-hidden />
      <h3 className="font-display text-h3 font-semibold text-text-primary">{title}</h3>
      <p className="text-body text-text-muted max-w-md mx-auto">{description}</p>
      <span className="badge-info inline-flex mt-2">Coming soon</span>
    </div>
  );
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-6 py-4">
      <div className="sm:w-48 shrink-0">
        <p className="text-body text-text-primary font-medium">{label}</p>
        {hint && <p className="text-small text-text-muted mt-0.5">{hint}</p>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

const THEME_CHOICES: { value: ThemeChoice; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('display');
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();

  const [density, setDensity] = useState<Density>('comfortable');
  const [landingTab, setLandingTab] = useState(LANDING_TAB_OPTIONS[0]?.href ?? '/dashboard');
  const [timezone, setTimezone] = useState('UTC');
  const [dateFormat, setDateFormat] = useState<DateFormat>('MM/DD/YYYY');
  const [hydrated, setHydrated] = useState(false);

  // Hydrate from localStorage once mounted (SSR-safe — avoids hydration mismatch).
  useEffect(() => {
    const storedDensity = readLocal(LS_KEYS.density);
    if (storedDensity === 'comfortable' || storedDensity === 'compact') setDensity(storedDensity);

    const storedLanding = readLocal(LS_KEYS.landingTab);
    if (storedLanding) setLandingTab(storedLanding);

    const storedTz = readLocal(LS_KEYS.timezone);
    if (storedTz) setTimezone(storedTz);
    else if (typeof Intl !== 'undefined') {
      try {
        const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (detected) setTimezone(detected);
      } catch {
        // keep default
      }
    }

    const storedFmt = readLocal(LS_KEYS.dateFormat);
    if (storedFmt) setDateFormat(storedFmt as DateFormat);

    setHydrated(true);
  }, []);

  const handleDensity = (next: Density) => {
    setDensity(next);
    writeLocal(LS_KEYS.density, next);
  };
  const handleLandingTab = (next: string) => {
    setLandingTab(next);
    writeLocal(LS_KEYS.landingTab, next);
  };
  const handleTimezone = (next: string) => {
    setTimezone(next);
    writeLocal(LS_KEYS.timezone, next);
  };
  const handleDateFormat = (next: DateFormat) => {
    setDateFormat(next);
    writeLocal(LS_KEYS.dateFormat, next);
  };

  const initials = (user?.username ?? 'VD').slice(0, 2).toUpperCase();
  const now = new Date();

  return (
    <AppLayout>
      <div className="space-y-6">
        <p className="text-body text-text-secondary max-w-2xl">
          Personal preferences for this account. Display settings are saved on this device;
          the other tabs are on the roadmap.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
          {/* Left tab nav */}
          <nav className="lg:col-span-1 card p-2 h-fit">
            <ul className="space-y-0.5">
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => setTab(t.id)}
                      className={cn(active ? 'nav-item-active' : 'nav-item', 'w-full')}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon className="w-4 h-4 shrink-0" aria-hidden />
                      <span className="truncate">{t.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Tab content */}
          <div className="lg:col-span-4 card p-6">
            {tab === 'profile' && (
              <div>
                <h2 className="text-h3 font-display font-semibold text-text-primary mb-4">Profile</h2>
                {user ? (
                  <div className="flex items-center gap-4 p-4 rounded-xl glass-hairline">
                    <span
                      className="grid place-items-center w-12 h-12 rounded-full text-body font-semibold text-accent-brand shrink-0"
                      style={{ background: 'rgb(var(--accent-brand-rgb) / 0.14)' }}
                    >
                      {initials}
                    </span>
                    <div className="min-w-0">
                      <p className="text-body text-text-primary font-medium truncate">{user.username}</p>
                      <p className="text-small text-text-muted truncate">{user.email}</p>
                      <div className="flex flex-wrap gap-1.5 mt-1.5">
                        {user.roles.map((r) => (
                          <span key={r} className="badge-primary">{r}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="py-10 text-center text-body text-text-muted">Not signed in.</div>
                )}
                <p className="text-small text-text-muted mt-4">
                  Editable profile fields (display name, avatar, password) are on the roadmap.
                </p>
                <span className="badge-info inline-flex mt-2">Coming soon</span>
              </div>
            )}

            {tab === 'display' && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-h3 font-display font-semibold text-text-primary">Display</h2>
                  <span className="badge-success">
                    <Check className="w-3 h-3" aria-hidden />
                    saved on this device
                  </span>
                </div>
                <p className="text-small text-text-muted mb-2">
                  These preferences persist to this browser only — there&apos;s no settings
                  endpoint yet, so nothing is sent to the server.
                </p>
                <div className="divide-y divide-border-default">
                  <FieldRow label="Theme" hint="Light, dark, or match your system.">
                    <div className="inline-flex rounded-xl glass-hairline p-1 gap-1">
                      {THEME_CHOICES.map((choice) => {
                        const Icon = choice.icon;
                        const active = theme === choice.value;
                        return (
                          <button
                            key={choice.value}
                            onClick={() => setTheme(choice.value)}
                            className={cn(
                              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-small transition-colors duration-fast',
                              active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
                            )}
                            style={active ? { background: 'rgb(var(--accent-brand-rgb) / 0.14)' } : undefined}
                            aria-pressed={active}
                          >
                            <Icon className="w-3.5 h-3.5" aria-hidden />
                            {choice.label}
                          </button>
                        );
                      })}
                    </div>
                  </FieldRow>

                  <FieldRow label="Density" hint="Comfortable spacing or a tighter, compact layout.">
                    <div className="inline-flex rounded-xl glass-hairline p-1 gap-1">
                      {(['comfortable', 'compact'] as Density[]).map((d) => {
                        const active = density === d;
                        return (
                          <button
                            key={d}
                            onClick={() => handleDensity(d)}
                            className={cn(
                              'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-small capitalize transition-colors duration-fast',
                              active ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary',
                            )}
                            style={active ? { background: 'rgb(var(--accent-brand-rgb) / 0.14)' } : undefined}
                            aria-pressed={active}
                          >
                            <LayoutPanelLeft className="w-3.5 h-3.5" aria-hidden />
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </FieldRow>

                  <FieldRow label="Default landing tab" hint="Where you land right after sign-in.">
                    <select
                      value={landingTab}
                      onChange={(e) => handleLandingTab(e.target.value)}
                      className="input max-w-xs"
                    >
                      {LANDING_TAB_OPTIONS.map((item) => (
                        <option key={item.href} value={item.href}>
                          {item.label}
                        </option>
                      ))}
                    </select>
                  </FieldRow>

                  <FieldRow label="Timezone" hint="Used to render timestamps across the app.">
                    <select
                      value={timezone}
                      onChange={(e) => handleTimezone(e.target.value)}
                      className="input max-w-xs"
                    >
                      {!TIMEZONE_OPTIONS.includes(timezone) && (
                        <option value={timezone}>{timezone} (detected)</option>
                      )}
                      {TIMEZONE_OPTIONS.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </FieldRow>

                  <FieldRow label="Date format" hint={`Preview: ${formatWithPattern(now, dateFormat)}`}>
                    <select
                      value={dateFormat}
                      onChange={(e) => handleDateFormat(e.target.value as DateFormat)}
                      className="input max-w-xs"
                    >
                      {DATE_FORMAT_OPTIONS.map((fmt) => (
                        <option key={fmt} value={fmt}>
                          {fmt}
                        </option>
                      ))}
                    </select>
                  </FieldRow>
                </div>
                {!hydrated && <p className="sr-only">Loading saved preferences…</p>}
              </div>
            )}

            {tab === 'notifications' && (
              <Placeholder
                icon={SettingsIcon}
                title="Notifications"
                description="Email and webhook alerts for extraction completion, HITL review, and failures will live here."
              />
            )}

            {tab === 'integrations' && (
              <Placeholder
                icon={Blocks}
                title="API & Integrations"
                description="Manage API keys, webhooks, and outbound integrations. See the API keys and Webhooks pages for what's already live."
              />
            )}

            {tab === 'tenant' && (
              <Placeholder
                icon={Building2}
                title="Tenant"
                description="Tenant-wide defaults — PHI enforcement, data retention, and branding — will be configurable here."
              />
            )}

            {tab === 'advanced' && (
              <Placeholder
                icon={Wrench}
                title="Advanced"
                description="Extraction engine overrides, feature flags, and diagnostics for power users."
              />
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
