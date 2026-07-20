'use client';

import React from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { BRANDING, copyrightLine } from '@/lib/branding';

interface FooterProps {
  className?: string;
}

const Footer: React.FC<FooterProps> = ({ className }) => {
  return (
    <footer className={cn('border-t border-border-default py-4 px-6', className)}>
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
        <p className="text-small text-text-muted">{copyrightLine()}</p>
        <div className="flex items-center gap-6">
          <Link
            href="/help"
            className="text-small text-text-muted hover:text-text-secondary transition-colors"
          >
            Help
          </Link>
          <a
            href={BRANDING.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-small text-text-muted hover:text-text-secondary transition-colors"
          >
            Documentation
          </a>
          <a
            href={BRANDING.statusUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-small text-text-muted hover:text-text-secondary transition-colors"
          >
            Status
          </a>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
