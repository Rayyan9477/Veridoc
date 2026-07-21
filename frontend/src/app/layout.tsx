import type { Metadata, Viewport } from 'next';
import { Sora, Manrope, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/components/providers';
import { Toaster } from 'react-hot-toast';
import { PageErrorBoundary } from '@/components/ErrorBoundary';
import { ThemeProvider } from '@/components/ThemeProvider';
import { BRANDING } from '@/lib/branding';

// Glass design system fonts — Sora (display), Manrope (UI), JetBrains Mono
// (IDs / model names / confidence values). Self-hosted by next/font.
const manrope = Manrope({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
});

const sora = Sora({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-display',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-mono',
});

// V3 Phase 8 — branding metadata read from src/lib/branding.ts.
// Renaming the product is a one-file change.
export const metadata: Metadata = {
  title: {
    default: BRANDING.productName,
    template: `%s · ${BRANDING.productName}`,
  },
  description: BRANDING.metaDescription,
  keywords: [
    'document extraction',
    'AI',
    'OCR',
    'provenance',
    'HIPAA',
    'multi-tenant',
    'dual-VLM',
    BRANDING.productName,
  ],
  authors: [{ name: BRANDING.companyName }],
  creator: BRANDING.companyName,
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  // V3 Phase 8 — theme color uses CSS custom property updated by
  // ThemeProvider on dark-mode toggle. Static fallback below.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#0891b2' },
    { media: '(prefers-color-scheme: dark)', color: '#07090d' },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${sora.variable} ${jetbrainsMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-screen bg-canvas font-sans antialiased text-text-primary">
        <ThemeProvider>
          <Providers>
            <PageErrorBoundary>
              {children}
            </PageErrorBoundary>
            <Toaster
              position="top-right"
              toastOptions={{
                duration: 4000,
                // V3 Phase 8 — Toast styling uses semantic tokens
                // so dark-mode flip is automatic.
                className:
                  'bg-surface-raised text-primary border border-default rounded-xl shadow-elev-3',
                style: {
                  padding: '16px',
                },
                success: {
                  iconTheme: {
                    primary: 'rgb(var(--accent-success-rgb))',
                    secondary: 'rgb(var(--bg-surface-raised-rgb))',
                  },
                },
                error: {
                  iconTheme: {
                    primary: 'rgb(var(--accent-danger-rgb))',
                    secondary: 'rgb(var(--bg-surface-raised-rgb))',
                  },
                },
              }}
            />
          </Providers>
        </ThemeProvider>
      </body>
    </html>
  );
}
