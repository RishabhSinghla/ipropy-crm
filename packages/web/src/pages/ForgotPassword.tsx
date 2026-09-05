/**
 * Getting back in, both halves of it.
 *
 * One file because they are one journey and share their look: ask for a link,
 * then use the link. Which half renders is decided by whether there is a token
 * in the address.
 *
 * The request half always reports success. The endpoint deliberately answers
 * identically whether or not the address exists, so that a stranger cannot use
 * this form to find out who works here — and a screen that said "no such
 * account" would hand back exactly what the endpoint refused to say.
 */
import { type JSX, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, KeyRound, Mail } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Spinner } from '../components/ui';

export default function ForgotPassword(): JSX.Element {
  const [params] = useSearchParams();
  const token = params.get('token');
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6 dark:bg-slate-950">
      <div className="w-full max-w-sm">
        {token ? <ChooseNew token={token} /> : <AskForLink />}
      </div>
    </div>
  );
}

function AskForLink(): JSX.Element {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    // No catch that changes the message. Whatever happens, the answer is the
    // same one the server gives, for the reason in the file header.
    try { await api.forgotPassword(email.trim()); } catch { /* deliberate */ }
    setBusy(false);
    setSent(true);
  };

  if (sent) {
    return (
      <div className="card p-6 text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-positive" />
        <h1 className="mt-3 text-base font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted">
          If an account uses that address, a link to choose a new password is on its way.
          It works once and expires in an hour.
        </p>
        <Link to="/login" className="btn-secondary btn-sm mt-5">Back to sign in</Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <div>
        <Mail className="h-6 w-6 text-brand-500" />
        <h1 className="mt-3 text-base font-semibold">Forgot your password?</h1>
        <p className="mt-1 text-sm text-muted">
          Enter the email address on your account and we will send you a link.
        </p>
      </div>
      <div>
        <label className="label" htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          required
          autoFocus
          className="input"
          placeholder="you@ipropy.com"
          value={email}
          onChange={(ev) => setEmail(ev.target.value)}
        />
      </div>
      <button type="submit" className="btn-primary w-full" disabled={busy || !email.trim()}>
        {busy && <Spinner />} Send me a link
      </button>
      <Link to="/login" className="block text-center text-xs text-muted hover:underline">
        Back to sign in
      </Link>
    </form>
  );
}

function ChooseNew({ token }: { token: string }): JSX.Element {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Checked here as well as on the server so somebody is told before they
  // spend their one-use link on a password that was never going to be accepted.
  const tooWeak = password.length > 0 && !(
    password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password)
  );
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reset your password.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="card p-6 text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-positive" />
        <h1 className="mt-3 text-base font-semibold">Password changed</h1>
        <p className="mt-2 text-sm text-muted">
          Everywhere you were signed in has been signed out, including any device PIN.
          Taking you to sign in.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="card space-y-4 p-6">
      <div>
        <KeyRound className="h-6 w-6 text-brand-500" />
        <h1 className="mt-3 text-base font-semibold">Choose a new password</h1>
        <p className="mt-1 text-sm text-muted">
          At least 8 characters, with an upper case letter, a lower case letter and a number.
        </p>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      <div>
        <label className="label" htmlFor="new-password">New password</label>
        <input
          id="new-password"
          type="password"
          required
          autoFocus
          autoComplete="new-password"
          className="input"
          value={password}
          onChange={(ev) => setPassword(ev.target.value)}
        />
        {tooWeak && <p className="mt-1 text-xs text-negative">Needs 8 characters, upper and lower case, and a number.</p>}
      </div>

      <div>
        <label className="label" htmlFor="confirm-password">Type it again</label>
        <input
          id="confirm-password"
          type="password"
          required
          autoComplete="new-password"
          className="input"
          value={confirm}
          onChange={(ev) => setConfirm(ev.target.value)}
        />
        {mismatch && <p className="mt-1 text-xs text-negative">These do not match.</p>}
      </div>

      <button
        type="submit"
        className="btn-primary w-full"
        disabled={busy || tooWeak || mismatch || !password || !confirm}
      >
        {busy && <Spinner />} Set new password
      </button>
    </form>
  );
}
