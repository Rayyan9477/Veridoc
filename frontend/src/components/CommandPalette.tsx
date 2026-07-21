'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CornerDownLeft, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ALL_NAV_ITEMS, type NavItem } from './layout/nav-config';

/**
 * ⌘K command palette — fuzzy route jump across the whole app. Opens on
 * ⌘K / Ctrl+K, or when any component dispatches the
 * `veridoc:open-command-palette` window event (used by the header search).
 */
export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo<NavItem[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ALL_NAV_ITEMS;
    return ALL_NAV_ITEMS.filter((item) =>
      `${item.label} ${item.href} ${item.keywords ?? ''}`.toLowerCase().includes(q)
    );
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('veridoc:open-command-palette', onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('veridoc:open-command-palette', onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 20);
      return () => clearTimeout(t);
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  const go = useCallback(
    (item?: NavItem) => {
      const target = item ?? results[active];
      if (!target) return;
      setOpen(false);
      router.push(target.href);
    },
    [results, active, router]
  );

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go();
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center p-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="absolute inset-0 backdrop-blur-sm"
        style={{ background: 'rgb(var(--bg-overlay-rgb) / 0.55)' }}
        onClick={() => setOpen(false)}
      />
      <div className="glass-panel relative w-full max-w-xl overflow-hidden animate-slide-up">
        <div className="flex items-center gap-3 px-4 h-14 border-b border-border-default">
          <Search className="w-5 h-5 text-text-muted" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search documents, jump to a route, run an action…"
            className="flex-1 bg-transparent text-body text-text-primary placeholder:text-text-muted outline-none"
            aria-label="Command palette search"
          />
          <kbd className="text-[0.65rem] font-mono text-text-muted px-1.5 py-0.5 rounded glass-hairline">
            ESC
          </kbd>
        </div>
        <div className="max-h-80 overflow-y-auto p-2 no-scrollbar">
          {results.length === 0 ? (
            <div className="px-3 py-10 text-center text-body text-text-muted">No matches.</div>
          ) : (
            results.map((item, i) => {
              const Icon = item.icon;
              const isActive = i === active;
              return (
                <button
                  key={item.href}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item)}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-colors duration-fast',
                    isActive ? 'text-text-primary' : 'text-text-secondary'
                  )}
                  style={isActive ? { background: 'rgb(var(--accent-brand-rgb) / 0.12)' } : undefined}
                >
                  <Icon className={cn('w-4 h-4', isActive ? 'text-accent-brand' : 'text-text-muted')} />
                  <span className="flex-1 text-body">{item.label}</span>
                  <span className="hidden sm:block text-small text-text-muted font-mono">{item.href}</span>
                  {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-text-muted" aria-hidden />}
                </button>
              );
            })
          )}
        </div>
        <div className="flex items-center gap-4 px-4 h-10 border-t border-border-default text-[0.65rem] text-text-muted font-mono">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="ml-auto">⌘K toggle</span>
        </div>
      </div>
    </div>
  );
}

export default CommandPalette;
