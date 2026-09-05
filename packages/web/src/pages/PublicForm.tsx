import type { JSX } from 'react';
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
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, FileQuestion, SendHorizontal } from 'lucide-react';
import { api } from '../lib/api';
import { Skeleton, Spinner } from '../components/ui';

interface FormField {
  name: string;
  label: string;
  type?: string;
  required?: boolean;
}

interface PublicForm {
  id: string;
  name: string;
  fields: FormField[];
  success_message: string | null;
  captcha_enabled: boolean;
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

export default function PublicFormPage(): JSX.Element {
  const { publicKey } = useParams<{ publicKey: string }>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; redirect: string | null } | null>(null);

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

