import { type JSX, useState } from 'react';
/**
 * The enquiry form a visitor fills — the front door of the whole CRM.
 *
 * The server has always accepted submissions (POST /api/webhooks/forms/:key,
 * with the origin allow-list, redirect and success message you would expect),
 * and the admin panel hands out a link — but the link went to the raw JSON
 * endpoint, so nobody could ever see their own form. This page is what the
 * link should have been: a public route with no signed-in user, in the same
 * family as /s/:token. The person arriving has never heard of iPropy, followed
 * an ad or a WhatsApp forward on a phone, and will leave in seconds if the
 * first screen is not obviously a form they can fill.
 *
 * It renders whatever fields the form defines (type and required flags are
 * honoured; sensible types are guessed for forms made before those existed),
 * passes UTM parameters from the page URL straight into the submission so
 * attribution survives, and shows the form's own success message.
 */
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileQuestion, SendHorizontal, ShieldCheck } from 'lucide-react';
import { nameFieldName, phoneFieldName, VERIFY_POLL_ATTEMPTS, VERIFY_POLL_INTERVAL_MS } from '../lib/truecaller';
import { api } from '../lib/api';
import { Skeleton, Spinner } from '../components/ui';

interface FormField {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}

/** The control each field renders: the form's type when it has one, otherwise what the field is obviously for. */
function controlFor(f: FormField): 'textarea' | 'input' {
  if (f.type === 'textarea') return 'textarea';
  if (!f.type && /message|enquiry|comment|query/i.test(f.name)) return 'textarea';
  return 'input';
}

function inputTypeFor(f: FormField): string {
  if (f.type && f.type !== 'text' && f.type !== 'textarea') return f.type;
  if (/mail/i.test(f.name)) return 'email';
  if (/mobile|phone|whatsapp/i.test(f.name)) return 'tel';
  return 'text';
}

/** UTM parameters survive the click: whatever is on the form's URL goes into the submission. */
function utmFromLocation(): Record<string, string> {
  const out: Record<string, string> = {};
  const params = new URLSearchParams(window.location.search);
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid']) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

/** Only navigate somewhere a form owner would have typed — never a javascript: URL from the database. */
function safeRedirect(url: string | null): string | null {
  if (!url) return null;
  return /^(https?:\/\/|\/)/.test(url) ? url : null;
}

/**
 * "Verify with Truecaller" — the visitor proving their own number.
 *
 * Only rendered when an admin has switched the card on, so a form with no
 * provider looks exactly as it did before this existed.
 *
 * The browser never decides anything here. It opens Truecaller, then asks our
 * own server whether the verification landed; the server holds the number that
 * was proven and uses that one when the form is submitted, whatever is typed
 * in the box. The nonce travelling back with the form is what ties the two.
 */
function VerifyWithTruecaller({ fields, onVerified }: {
  fields: FormField[];
  onVerified: (found: { name: string | null; phone: string | null; nonce: string }) => void;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'waiting' | 'done' | 'unavailable'>('idle');

  const verify = async (): Promise<void> => {
    setState('waiting');

    let started: { nonce: string; deepLink: string };
    try {
      started = await api.startTruecaller();
    } catch {
      setState('unavailable');
      return;
    }

    // A custom scheme this phone cannot handle leaves a blank window standing,
    // which is the only way to tell "Truecaller is not installed" from "the
    // person has not finished yet".
    const opened = window.open(started.deepLink);
    window.setTimeout(() => {
      try {
        if (opened && opened.location.href === 'about:blank') {
          opened.close();
          setState('unavailable');
        }
      } catch {
        // Reading the location threw, which means it navigated somewhere —
        // the good case.
      }
    }, 800);

    for (let attempt = 0; attempt < VERIFY_POLL_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => { window.setTimeout(resolve, VERIFY_POLL_INTERVAL_MS); });
      const result = await api.truecallerResult(started.nonce).catch(() => null);
      if (result?.status === 'verified') {
        onVerified({ name: result.name, phone: result.phone, nonce: started.nonce });
        setState('done');
        return;
      }
      if (result?.status === 'failed') break;
    }
    setState('unavailable');
  };

  if (state === 'done') {
    return (
      <p className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        Your number is verified. Just add anything else we should know.
      </p>
    );
  }

  return (
    <div className="mb-4">
      <button
        type="button"
        onClick={() => { void verify(); }}
        disabled={state === 'waiting'}
        className="btn-secondary w-full justify-center"
      >
        {state === 'waiting' ? <Spinner /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
        {state === 'waiting' ? 'Waiting for Truecaller…' : 'Verify with Truecaller'}
      </button>
      {state === 'unavailable' && (
        <p className="mt-2 text-xs text-muted">
          Truecaller could not verify you on this device. Please fill the form in below —
          it works exactly the same.
        </p>
      )}
      {state === 'idle' && (
        <p className="mt-2 text-xs text-muted">
          One tap instead of typing. {fields.length > 0 && 'We only ever see your name and number.'}
        </p>
      )}
    </div>
  );
}

export default function PublicFormPage(): JSX.Element {
  const { publicKey } = useParams<{ publicKey: string }>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; redirect: string | null } | null>(null);
  /** Proof that a verification happened. The server re-reads it; this is only the handle. */
  const [truecallerNonce, setTruecallerNonce] = useState<string | null>(null);

  const { data: form, isLoading, isError } = useQuery({
    queryKey: ['public-form', publicKey],
    queryFn: () => api.publicForm(publicKey!),
    enabled: Boolean(publicKey),
    retry: false,
  });

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!form || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { ...utmFromLocation() };
      for (const f of form.fields) payload[f.name] = values[f.name]?.trim() ?? '';
      if (truecallerNonce) payload.truecallerNonce = truecallerNonce;
      const res = await api.submitPublicForm(publicKey!, payload);
      const redirect = safeRedirect(res.redirectUrl);
      setDone({ message: res.message, redirect });
      if (redirect) {
        // The success message is read before the page goes anywhere.
        setTimeout(() => { window.location.href = redirect; }, 2500);
      }
    } catch (err) {
      setError((err as Error).message || 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-md space-y-4 p-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  // One plain message for unknown, mistyped or switched-off forms — the page
  // does not guess which, so nobody learns that a key they are probing is real.
  if (isError || !form) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <FileQuestion className="h-10 w-10 text-muted" />
        <h1 className="text-lg font-semibold">This form is no longer available</h1>
        <p className="text-sm text-muted">
          It may have been turned off, or the link may be wrong. Ask whoever sent it for a new one.
        </p>
      </div>
    );
  }

  if (done) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <CheckCircle2 className="h-12 w-12 text-positive" />
        <h1 className="text-lg font-semibold">{done.message}</h1>
        {done.redirect && (
          <p className="text-sm text-muted">Taking you there…</p>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-start justify-center bg-bg p-4 sm:p-6">
      <form onSubmit={(e) => void submit(e)} className="card mt-4 w-full max-w-md p-5 sm:p-6">
        <h1 className="mb-4 text-lg font-semibold tracking-tight">{form.name}</h1>

        {form.truecaller && (
          <VerifyWithTruecaller
            fields={form.fields}
            onVerified={({ name, phone, nonce }) => {
              setTruecallerNonce(nonce);
              // Which boxes these are is read off the form an admin built, so
              // no field is named here and a form without one simply fills
              // nothing while the server still keeps the proven number.
              const nameBox = nameFieldName(form.fields);
              const phoneBox = phoneFieldName(form.fields);
              setValues((v) => ({
                ...v,
                ...(nameBox && name ? { [nameBox]: name } : {}),
                ...(phoneBox && phone ? { [phoneBox]: phone } : {}),
              }));
            }}
          />
        )}

        <div className="space-y-3.5">
          {form.fields.map((f) => {
            const id = `field-${f.name}`;
            const common = {
              id,
              name: f.name,
              required: f.required === true,
              value: values[f.name] ?? '',
              onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
                setValues((v) => ({ ...v, [f.name]: e.target.value })),
              className: 'input w-full',
            };
            return (
              <div key={f.name}>
                <label className="label" htmlFor={id}>
                  {f.label}
                  {f.required === true && <span aria-hidden="true"> *</span>}
                </label>
                {controlFor(f) === 'textarea'
                  ? <textarea {...common} rows={4} />
                  : <input {...common} type={inputTypeFor(f)} />}
              </div>
            );
          })}
        </div>

        {error && (
          <p role="alert" className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <button type="submit" disabled={submitting} className="btn-primary mt-5 w-full justify-center">
          {submitting ? <Spinner /> : <SendHorizontal className="h-4 w-4" />}
          Submit
        </button>
      </form>
    </div>
  );
}

