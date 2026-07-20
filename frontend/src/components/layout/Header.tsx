'use client';

import React from 'react';
import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import { ChevronDown, HelpCircle, LogOut, Menu, Search, Settings } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Dropdown } from '@/components/ui';
import { pageTitleForPath } from './nav-config';

interface HeaderProps {
  onMenuClick?: () => void;
  user?: { name: string; email: string };
  onSignOut?: () => void;
}

const openPalette = () =>
  window.dispatchEvent(new Event('veridoc:open-command-palette'));

export default function Header({ onMenuClick, user, onSignOut }: HeaderProps) {
  const pathname = usePathname();
  const router = useRouter();
  const title = pageTitleForPath(pathname);
  const initials = (user?.name ?? 'VD').slice(0, 2).toUpperCase();

  return (
    <header
      className="sticky top-0 z-30 h-16 flex items-center gap-3 px-4 lg:px-6 border-b border-border-default backdrop-blur-xl"
      style={{ background: 'rgb(var(--bg-canvas-rgb) / 0.55)' }}
    >
      <button onClick={onMenuClick} aria-label="Open navigation" className="btn-ghost p-2 lg:hidden">
        <Menu className="w-5 h-5" aria-hidden />
      </button>

      <h1 className="font-display text-h2 font-semibold text-text-primary shrink-0">{title}</h1>

      {/* ⌘K search trigger */}
      <button
        onClick={openPalette}
        className="ml-2 hidden md:flex items-center gap-2 flex-1 max-w-md h-9 px-3 rounded-xl glass-hairline text-text-muted hover:text-text-secondary transition-colors duration-fast"
        style={{ background: 'rgb(var(--bg-surface-rgb) / 0.4)' }}
        aria-label="Open command palette"
      >
        <Search className="w-4 h-4" aria-hidden />
        <span className="text-body">Search or jump to…</span>
        <kbd className="ml-auto text-[0.65rem] font-mono px-1.5 py-0.5 rounded glass-hairline">⌘K</kbd>
      </button>

      <div className="flex items-center gap-1 ml-auto md:ml-0">
        <button onClick={openPalette} aria-label="Search" className="btn-ghost p-2 md:hidden">
          <Search className="w-5 h-5" aria-hidden />
        </button>

        <span className="hidden sm:inline-flex badge-warning font-mono mr-1">staging</span>

        <ThemeToggle />

        {user ? (
          <Dropdown
            align="right"
            trigger={
              <button className="btn-ghost flex items-center gap-2 pl-1 pr-2" aria-label={`Account: ${user.name}`}>
                <span
                  className="grid place-items-center w-8 h-8 rounded-full text-small font-semibold text-accent-brand"
                  style={{ background: 'rgb(var(--accent-brand-rgb) / 0.14)' }}
                >
                  {initials}
                </span>
                <span className="hidden sm:block text-body text-text-secondary">{user.name}</span>
                <ChevronDown className="hidden sm:block w-4 h-4 text-text-muted" aria-hidden />
              </button>
            }
            items={[
              { label: user.email, disabled: true },
              { divider: true, label: '' },
              { label: 'Settings', icon: <Settings className="w-4 h-4" />, onClick: () => router.push('/settings') },
              { label: 'Help', icon: <HelpCircle className="w-4 h-4" />, onClick: () => router.push('/help') },
              { label: 'Sign out', icon: <LogOut className="w-4 h-4" />, onClick: () => onSignOut?.(), danger: true },
            ]}
          />
        ) : (
          <Link href="/login" className="btn-primary text-small px-3 py-1.5">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
