'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { ArrowRight, Lock, User } from 'lucide-react';
import { authApi } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { BRANDING } from '@/lib/branding';

// DEV MODE: skip login — gated on NODE_ENV + opt-in env var so production
// builds never compile the bypass. Mirrors ProtectedRoute.tsx.
const DEV_AUTO_LOGIN =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === 'true';

export default function LoginPage() {
  const router = useRouter();
  const { setUser } = useAuthStore();

  useEffect(() => {
    if (DEV_AUTO_LOGIN) router.replace('/dashboard');
  }, [router]);

  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ username: '', password: '' });
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.username || !form.password) {
      setError('Enter your username and password.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      await authApi.login({ username: form.username, password: form.password });
      const user = await authApi.getCurrentUser();
      setUser(user);
      toast.success('Welcome back!');
      router.push('/dashboard');
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : '';
      toast.error(raw || 'Invalid credentials');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
      >
        <div className="flex flex-col items-center mb-6">
          <span className="grid place-items-center w-12 h-12 rounded-2xl glass-panel mb-3">
            <span className="font-display text-xl font-semibold text-accent-brand">V</span>
          </span>
          <h1 className="font-display text-h1 font-semibold text-text-primary">Welcome back</h1>
          <p className="text-body text-text-secondary mt-1">Sign in to continue.</p>
        </div>

        <form onSubmit={submit} className="glass-panel p-6 space-y-4">
          <div>
            <label htmlFor="username" className="block text-small text-text-muted mb-1.5 tracking-wide">
              USERNAME
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" aria-hidden />
              <input
                id="username"
                className="input pl-9"
                autoComplete="username"
                placeholder="jane.operator"
                value={form.username}
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </div>
          </div>

          <div>
            <label htmlFor="password" className="block text-small text-text-muted mb-1.5 tracking-wide">
              PASSWORD
            </label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" aria-hidden />
              <input
                id="password"
                type="password"
                className="input pl-9"
                autoComplete="current-password"
                placeholder="••••••••"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
              />
            </div>
          </div>

          <div className="flex items-center justify-between text-small">
            <label className="inline-flex items-center gap-2 text-text-secondary cursor-pointer">
              <input type="checkbox" style={{ accentColor: 'rgb(var(--accent-brand-rgb))' }} />
              Remember me
            </label>
            <Link href="/forgot-password" className="text-accent-brand">
              Forgot password?
            </Link>
          </div>

          {error && <p className="text-small conf-low">{error}</p>}

          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? 'Signing in…' : (
              <>
                Sign in <ArrowRight className="w-4 h-4" aria-hidden />
              </>
            )}
          </button>
        </form>

        <p className="text-center text-small text-text-muted mt-5">
          No account?{' '}
          <Link href="/signup" className="text-accent-brand">
            Request access
          </Link>
        </p>
        <p className="text-center text-[0.65rem] font-mono text-text-muted mt-6">
          {BRANDING.productName} {BRANDING.versionLabel} · build a3f1c
        </p>
      </motion.div>
    </div>
  );
}
