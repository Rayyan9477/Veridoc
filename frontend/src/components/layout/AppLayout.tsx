'use client';

import React, { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { ProtectedRoute } from '@/components/auth';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { CommandPalette } from '@/components/CommandPalette';
import Header from './Header';
import Sidebar from './Sidebar';
import Footer from './Footer';

interface AppLayoutProps {
  children: React.ReactNode;
  /** Retained for backwards-compat with existing callers; not rendered. */
  notifications?: number;
  showFooter?: boolean;
  requireAuth?: boolean;
}

const AppLayout: React.FC<AppLayoutProps> = ({
  children,
  showFooter = true,
  requireAuth = true,
}) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const { user, logout } = useAuth();

  const layoutContent = (
    <div className="min-h-screen flex">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-h-screen overflow-hidden">
        <Header
          onMenuClick={() => setSidebarOpen(true)}
          user={user ? { name: user.username, email: user.email } : undefined}
          onSignOut={logout}
        />

        <main className="flex-1 overflow-auto">
          <div className="container-app py-6">
            <ErrorBoundary>{children}</ErrorBoundary>
          </div>
        </main>

        {showFooter && <Footer />}
      </div>

      <CommandPalette />
    </div>
  );

  if (requireAuth) {
    return <ProtectedRoute>{layoutContent}</ProtectedRoute>;
  }
  return layoutContent;
};

export default AppLayout;
