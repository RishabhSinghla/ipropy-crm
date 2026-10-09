/** Semantic backgrounds; unread remains a separate dot/font state. */
export function notificationTone(kind: string, link: string | null): string {
  if (link?.startsWith('/capture')) return 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950 dark:hover:bg-emerald-900';
  if (kind === 'ai') return 'bg-violet-50 hover:bg-violet-100 dark:bg-violet-950 dark:hover:bg-violet-900';
  if (kind === 'mention') return 'bg-sky-50 hover:bg-sky-100 dark:bg-sky-950 dark:hover:bg-sky-900';
  if (['import', 'reminder', 'task'].includes(kind)) return 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-950 dark:hover:bg-amber-900';
  if (['matches', 'buyer_match', 'whatsapp', 'repeat_enquiry', 'webform'].includes(kind)) return 'bg-emerald-50 hover:bg-emerald-100 dark:bg-emerald-950 dark:hover:bg-emerald-900';
  if (kind === 'escalation' || kind === 'sla_breach' || /error|fail|warning|integration/i.test(kind)) return 'bg-red-50 hover:bg-red-100 dark:bg-red-950 dark:hover:bg-red-900';
  if (kind === 'birthday') return 'bg-pink-50 hover:bg-pink-100 dark:bg-pink-950 dark:hover:bg-pink-900';
  return 'bg-brand-50 hover:bg-brand-100 dark:bg-brand-950 dark:hover:bg-brand-900';
}
