import clsx, { type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/** Tailwind classes for a coloured badge, derived from a hex colour. */
export function badgeStyle(color: string | null | undefined): React.CSSProperties {
  if (!color) return {};
  return {
    backgroundColor: `${color}18`,
    color,
    borderColor: `${color}35`,
  };
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms = 300): T {
  let timer: ReturnType<typeof setTimeout>;
  return ((...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  }) as T;
}

/** Render a very small subset of markdown (bold, bullets, line breaks). */
export function renderMarkdown(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>')
    .replace(/<\/ul>\s*<ul>/g, '')
    .replace(/\n{2,}/g, '</p><p>')
    .replace(/\n/g, '<br/>');
}

/** Field-value equality that treats null/undefined/'' as the same "empty", and compares arrays by element. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined || b === '';
  if (b === null || b === undefined) return a === '';
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => String(v) === String(b[i]));
  }
  if (typeof a === 'object' || typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return String(a) === String(b);
}

/** Narrows a dependent picklist's options to what its parent field currently allows. */
export function restrictionForField(
  picklistDependencies: { sourceField: string; targetField: string; mapping: Record<string, string[]> }[] | undefined,
  values: Record<string, unknown>,
  fieldName: string,
): string[] | undefined {
  const dep = picklistDependencies?.find((d) => d.targetField === fieldName);
  if (!dep) return undefined;
  const sourceValue = values[dep.sourceField];
  if (!sourceValue) return undefined;
  return dep.mapping[String(sourceValue)] ?? [];
}

export const MODULE_ICON_FALLBACK = 'box';

/** Group modules for the sidebar, preserving the admin-defined order. */
export function groupModules<T extends { menuGroup: string; sequence: number }>(modules: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const m of modules) {
    const key = m.menuGroup || 'CRM';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }
  const order = ['Sales', 'Inventory', 'Marketing', 'Finance', 'Productivity', 'CRM', 'Custom'];
  return [...groups.entries()]
    .sort((a, b) => {
      const ai = order.indexOf(a[0]);
      const bi = order.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map(([key, list]) => [key, list.sort((x, y) => x.sequence - y.sequence)] as [string, T[]]);
}
