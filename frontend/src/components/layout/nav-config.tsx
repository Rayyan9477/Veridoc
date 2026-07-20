/**
 * Glass shell navigation — the single source of truth for the sidebar,
 * the ⌘K command palette, and header page titles. Grouped into the four
 * Glass sections: WORKSPACE / BUILD / INTEGRATE / ADMIN.
 */
import {
  Activity,
  Boxes,
  ClipboardCheck,
  FileText,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  ScrollText,
  ShieldCheck,
  TerminalSquare,
  Upload,
  Users,
  Webhook,
} from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  label: string;
  href: string;
  icon: ComponentType<{ className?: string }>;
  /** Extra terms for command-palette fuzzy matching. */
  keywords?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard, keywords: 'overview metrics home' },
      { label: 'Documents', href: '/documents', icon: FileText, keywords: 'extractions list' },
      { label: 'Upload', href: '/documents/upload', icon: Upload, keywords: 'ingest new file' },
      { label: 'Tasks', href: '/tasks', icon: ListChecks, keywords: 'queue jobs live' },
      { label: 'HITL review', href: '/review', icon: ClipboardCheck, keywords: 'human in the loop flagged approve' },
    ],
  },
  {
    label: 'Build',
    items: [
      { label: 'Schemas', href: '/schemas', icon: Boxes, keywords: 'templates fields designer' },
      { label: 'Profiles', href: '/profiles', icon: Layers, keywords: 'medical finance legal emitters' },
    ],
  },
  {
    label: 'Integrate',
    items: [
      { label: 'Webhooks', href: '/webhooks', icon: Webhook, keywords: 'subscriptions delivery dlq' },
      { label: 'API keys', href: '/api-keys', icon: KeyRound, keywords: 'tokens access scopes' },
      { label: 'API explorer', href: '/api-explorer', icon: TerminalSquare, keywords: 'rest docs try it' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Security', href: '/security', icon: ShieldCheck, keywords: 'audit chain sessions phi' },
      { label: 'Audit log', href: '/audit', icon: ScrollText, keywords: 'events tamper anchored' },
      { label: 'Users', href: '/users', icon: Users, keywords: 'rbac roles mfa tenancy' },
      { label: 'Health', href: '/health', icon: Activity, keywords: 'status components readiness' },
    ],
  },
];

export const ALL_NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Routes reachable outside the sidebar (user menu), so header titles resolve. */
const EXTRA_TITLES: Array<[string, string]> = [
  ['/settings', 'Settings'],
  ['/help', 'Help'],
];

/** Longest-prefix match so nested routes still resolve to their section title. */
export function pageTitleForPath(pathname: string): string {
  const match = bestNavMatch(pathname);
  if (match) return match.label;
  for (const [href, label] of EXTRA_TITLES) {
    if (pathname === href || pathname.startsWith(href + '/')) return label;
  }
  return 'Veridoc';
}

/** The single nav item that should render active for a path (longest match wins,
 *  so `/documents/upload` activates Upload only — not the `/documents` parent). */
export function activeNavHref(pathname: string): string | null {
  return bestNavMatch(pathname)?.href ?? null;
}

function bestNavMatch(pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const item of ALL_NAV_ITEMS) {
    if (pathname === item.href || pathname.startsWith(item.href + '/')) {
      if (!best || item.href.length > best.href.length) best = item;
    }
  }
  return best;
}
