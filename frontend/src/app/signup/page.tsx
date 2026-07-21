'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { motion } from 'framer-motion';
import toast from 'react-hot-toast';
import { ArrowRight, Lock, Mail, User } from 'lucide-react';
import { authApi } from '@/lib/api';
import { BRANDING } from '@/lib/branding';

const DEV_AUTO_LOGIN =
  process.env.NODE_ENV !== 'production' &&
  process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN === 'true';

type FormKey = 'username' | 'email' | 'password' | 'confirmPassword';

export default function SignupPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (DEV_AUTO_LOGIN) router.replace('/dashboard');
  }, [router]);

  const [form, setForm] = useState<Record<FormKey, string>>({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState<Record<FormKey, string>>({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });

  const set = (k: FormKey, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: '' }));
  };

  const validate = () => {
    const e: Record<FormKey, string> = { username: '', email: '', password: '', confirmPassword: '' };
    if (form.username.length < 3) e.username = 'At least 3 characters.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = 'Enter a valid email.';
    if (form.password.length < 12) e.password = 'At least 12 characters.';
    if (form.confirmPassword !== form.password) e.confirmPassword = 'Passwords do not match.';
    setErrors(e);
    return !Object.values(e).some(Boolean);
  };

  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!validate()) return;
    setLoading(true);
    try {
      await authApi.signup({
        username: form.username,
        email: form.email,
        password: form.password,
        confirm_password: form.confirmPassword,
      });
      toast.success('Account created — please sign in.');
      router.push('/login');
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  const fields: { key: FormKey; label: string; type?: string; icon: React.ComponentType<{ className?: string }>; placeholder: string; autoComplete: string }[] = [
    { key: 'username', label: 'USERNAME', icon: User, placeholder: 'jane.operator', autoComplete: 'username' },
    { key: 'email', label: 'EMAIL', type: 'email', icon: Mail, placeholder: 'jane@acme.example.com', autoComplete: 'email' },
    { key: 'password', label: 'PASSWORD', type: 'password', icon: Lock, placeholder: '••••••••••••', autoComplete: 'new-password' },
    { key: 'confirmPassword', label: 'CONFIRM PASSWORD', type: 'password', icon: Lock, placeholder: '••••••••••••', autoComplete: 'new-password' },
  ];

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
          <h1 className="font-display text-h1 font-semibold text-text-primary">Create account</h1>
          <p className="text-body text-text-secondary mt-1">Provision a new operator account.</p>
        </div>

        <form onSubmit={submit} className="glass-panel p-6 space-y-4">
          {fields.map(({ key, label, type, icon: Icon, placeholder, autoComplete }) => (
            <div key={key}>
              <label htmlFor={key} className="block text-small text-text-muted mb-1.5 tracking-wide">
                {label}
              </label>
              <div className="relative">
                <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" aria-hidden />
                <input
                  id={key}
                  type={type ?? 'text'}
                  className={errors[key] ? 'input-error pl-9' : 'input pl-9'}
                  placeholder={placeholder}
                  autoComplete={autoComplete}
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                />
              </div>
              {key === 'password' && !errors.password && (
                <p className="mt-1 text-small text-text-muted">Strong · 12+ chars, mixed case, numbers.</p>
              )}
              {errors[key] && <p className="mt-1 text-small conf-low">{errors[key]}</p>}
            </div>
          ))}

          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? 'Creating…' : (
              <>
                Create account <ArrowRight className="w-4 h-4" aria-hidden />
              </>
            )}
          </button>
        </form>

        <p className="text-center text-small text-text-muted mt-5">
          Already have an account?{' '}
          <Link href="/login" className="text-accent-brand">
            Sign in
          </Link>
        </p>
        <p className="text-center text-[0.65rem] font-mono text-text-muted mt-6">
          {BRANDING.productName} {BRANDING.versionLabel} · build a3f1c
        </p>
      </motion.div>
    </div>
  );
}
