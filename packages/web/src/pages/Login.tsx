import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Building2, Eye, EyeOff, Sparkles } from 'lucide-react';
import { useApp } from '../lib/store';
import { ApiError, api } from '../lib/api';
import { Spinner } from '../components/ui';

export default function Login(): JSX.Element {
  const { user, login, loading } = useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('admin@ipropy.com');
  const [password, setPassword] = useState('Admin@123');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Public endpoint: this screen renders before anyone is signed in.
  const { data: brand } = useQuery({ queryKey: ['public-brand'], queryFn: () => api.publicBrand(), staleTime: Infinity });

  if (!loading && user) {
    const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? (user.channelPartnerId ? '/portal' : '/dashboard');
    return <Navigate to={from} replace />;
  }

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <div className="relative hidden w-1/2 flex-col justify-between overflow-hidden bg-brand-700 p-12 text-white lg:flex">
        <div
          className="absolute inset-0 opacity-20"
          style={{
            backgroundImage:
              'radial-gradient(circle at 20% 20%, #a5b4fc 0, transparent 45%), radial-gradient(circle at 80% 70%, #22d3ee 0, transparent 40%)',
          }}
        />
        <div className="relative flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
            <Building2 className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <span className="block text-2xl font-semibold leading-tight tracking-tight">
              {brand?.orgName ?? 'iPropy'}
            </span>
            {brand?.tagline && (
              <span className="block text-xs uppercase tracking-[0.18em] text-brand-200">{brand.tagline}</span>
            )}
          </div>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-4xl font-semibold leading-tight tracking-tight">
            The AI-native CRM built for real estate.
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-brand-100">
            Capture every enquiry, score it in seconds, match it to live inventory,
            and follow up on WhatsApp — without leaving one screen.
          </p>

          <ul className="mt-8 space-y-3 text-sm text-brand-100">
            {[
              'Fully customisable modules, fields, layouts and dashboards',
              'Lead scoring and property matching that explain themselves',
              'WhatsApp, telephony and portal leads wired in from day one',
              'Role hierarchy, sharing rules and field-level permissions',
            ].map((line) => (
              <li key={line} className="flex items-start gap-2.5">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" />
                {line}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-brand-200">
          Real-estate CRM · Leads · Inventory · Bookings · Collections
        </p>
      </div>

      {/* Form */}
      <div className="flex w-full items-center justify-center px-6 lg:w-1/2">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
              <Building2 className="h-5 w-5" />
            </div>
            <span className="text-xl font-semibold">{brand?.orgName ?? 'iPropy'}</span>
          </div>

          <h2 className="text-2xl font-semibold tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-muted">Sign in to your workspace.</p>

          <form onSubmit={submit} className="mt-8 space-y-4">
            <div>
              <label className="label" htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                autoFocus
              />
            </div>

            <div>
              <label className="label" htmlFor="password">Password</label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  className="input pr-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                {error}
              </div>
            )}

            <button type="submit" className="btn-primary w-full py-2.5" disabled={busy}>
              {busy && <Spinner />}
              Sign in
            </button>
          </form>

          <div className="mt-8 rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs dark:border-slate-800 dark:bg-slate-900">
            <p className="font-medium text-slate-700 dark:text-slate-300">Demo accounts</p>
            <p className="mt-1 text-slate-500">
              Admin: <code>admin@ipropy.com</code> · Sales head: <code>priya.sharma@ipropy.com</code> ·
              Executive: <code>aisha.khan@ipropy.com</code>
            </p>
            <p className="mt-1 text-slate-500">All use the seeded password <code>Admin@123</code>.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
