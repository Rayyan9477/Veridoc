'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BRANDING } from '@/lib/branding';
import { activeNavHref, NAV_GROUPS, type NavItem } from './nav-config';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

function Wordmark() {
  return (
    <Link
      href="/dashboard"
      aria-label={`${BRANDING.productName} home`}
      className="flex items-center gap-3 px-1"
    >
      <span className="relative grid place-items-center w-9 h-9 rounded-xl glass-panel">
        <span className="font-display text-lg font-semibold text-accent-brand">V</span>
      </span>
      <span className="flex flex-col leading-tight">
        <span className="font-display text-h3 font-semibold text-text-primary">
          {BRANDING.productName}
        </span>
        <span className="text-[0.65rem] text-text-muted font-mono">{BRANDING.versionLabel}</span>
      </span>
    </Link>
  );
}

function NavLink({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
  const pathname = usePathname();
  const isActive = activeNavHref(pathname) === item.href;
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? 'page' : undefined}
      className={cn('relative', isActive ? 'nav-item-active' : 'nav-item')}
    >
      <Icon
        className={cn('w-[1.15rem] h-[1.15rem] shrink-0', isActive && 'text-accent-brand')}
        aria-hidden
      />
      <span className="flex-1 truncate">{item.label}</span>
      {isActive && (
        <motion.span
          layoutId="sidebarActive"
          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-6 rounded-r-full bg-accent-brand"
          transition={{ type: 'spring', stiffness: 500, damping: 32 }}
          aria-hidden
        />
      )}
    </Link>
  );
}

function SidebarBody({ onNavigate }: { onNavigate: () => void }) {
  return (
    <div className="flex flex-col h-full">
      <div className="h-16 flex items-center px-4 border-b border-border-default">
        <Wordmark />
      </div>
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 pb-8 no-scrollbar">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="nav-group-label">{group.label}</div>
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <NavLink key={item.href} item={item} onNavigate={onNavigate} />
              ))}
            </div>
          </div>
        ))}
      </nav>
    </div>
  );
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  return (
    <>
      {/* Mobile drawer */}
      <AnimatePresence>
        {isOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onClose}
              className="fixed inset-0 z-40 lg:hidden"
              style={{ background: 'rgb(var(--bg-overlay-rgb) / 0.55)' }}
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 320, damping: 32 }}
              className="fixed inset-y-0 left-0 z-50 w-72 glass-panel !rounded-none lg:hidden"
            >
              <button
                onClick={onClose}
                aria-label="Close navigation"
                className="btn-ghost absolute top-3.5 right-3 p-1.5"
              >
                <X className="w-5 h-5" aria-hidden />
              </button>
              <SidebarBody onNavigate={onClose} />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Desktop rail — frosted over the ambient canvas */}
      <aside
        className="hidden lg:flex flex-col w-72 shrink-0 border-r border-border-default backdrop-blur-xl"
        style={{ background: 'rgb(var(--bg-surface-rgb) / 0.35)' }}
      >
        <SidebarBody onNavigate={() => {}} />
      </aside>
    </>
  );
}
