/**
 * Safe formula evaluator for `formula` uitype fields and workflow expressions.
 *
 * Deliberately NOT eval/Function: admins author these strings in the UI, so the
 * evaluator is a hand-written recursive-descent parser over a fixed grammar.
 * Supported:
 *   {field} references, numbers, 'strings', + - * / %, comparisons,
 *   AND/OR/NOT, parentheses, and a whitelist of functions.
 */

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'field'; v: string }
  | { t: 'ident'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

const OPERATORS = ['<=', '>=', '!=', '==', '&&', '||', '<', '>', '=', '+', '-', '*', '/', '%'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];

    if (/\s/.test(c)) { i++; continue; }

    if (c === '{') {
      const end = input.indexOf('}', i);
      if (end === -1) throw new Error('unterminated { in formula');
      tokens.push({ t: 'field', v: input.slice(i + 1, end).trim() });
      i = end + 1;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== quote) {
        if (input[j] === '\\' && j + 1 < input.length) { out += input[j + 1]; j += 2; }
        else { out += input[j]; j++; }
      }
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j])) j++;
      tokens.push({ t: 'num', v: Number.parseFloat(input.slice(i, j)) });
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j])) j++;
      const word = input.slice(i, j);
      const upper = word.toUpperCase();
      if (upper === 'AND') tokens.push({ t: 'op', v: '&&' });
      else if (upper === 'OR') tokens.push({ t: 'op', v: '||' });
      else if (upper === 'NOT') tokens.push({ t: 'op', v: '!' });
      else tokens.push({ t: 'ident', v: word });
      i = j;
      continue;
    }

    if (c === '(') { tokens.push({ t: 'lparen' }); i++; continue; }
    if (c === ')') { tokens.push({ t: 'rparen' }); i++; continue; }
    if (c === ',') { tokens.push({ t: 'comma' }); i++; continue; }
    if (c === '!') {
      if (input[i + 1] === '=') { tokens.push({ t: 'op', v: '!=' }); i += 2; }
      else { tokens.push({ t: 'op', v: '!' }); i++; }
      continue;
    }

    const two = input.slice(i, i + 2);
    const op = OPERATORS.find((o) => o.length === 2 && o === two) ?? OPERATORS.find((o) => o.length === 1 && o === c);
    if (op) { tokens.push({ t: 'op', v: op }); i += op.length; continue; }

    throw new Error(`unexpected character '${c}' in formula`);
  }
  return tokens;
}

type Value = number | string | boolean | null;

const FUNCTIONS: Record<string, (...args: Value[]) => Value> = {
  IF: (cond, a, b) => (truthy(cond) ? a ?? null : b ?? null),
  ROUND: (n, d) => {
    const p = 10 ** (Number(d ?? 0));
    return Math.round(Number(n ?? 0) * p) / p;
  },
  FLOOR: (n) => Math.floor(Number(n ?? 0)),
  CEIL: (n) => Math.ceil(Number(n ?? 0)),
  ABS: (n) => Math.abs(Number(n ?? 0)),
  MIN: (...args) => Math.min(...args.map((a) => Number(a ?? 0))),
  MAX: (...args) => Math.max(...args.map((a) => Number(a ?? 0))),
  SUM: (...args) => args.reduce<number>((acc, a) => acc + Number(a ?? 0), 0),
  CONCAT: (...args) => args.map((a) => (a === null || a === undefined ? '' : String(a))).join(''),
  UPPER: (s) => String(s ?? '').toUpperCase(),
  LOWER: (s) => String(s ?? '').toLowerCase(),
  TRIM: (s) => String(s ?? '').trim(),
  LEN: (s) => String(s ?? '').length,
  LEFT: (s, n) => String(s ?? '').slice(0, Number(n ?? 0)),
  RIGHT: (s, n) => String(s ?? '').slice(-Number(n ?? 0)),
  COALESCE: (...args) => args.find((a) => a !== null && a !== undefined && a !== '') ?? null,
  ISEMPTY: (v) => v === null || v === undefined || v === '',
  TODAY: () => new Date().toISOString().slice(0, 10),
  NOW: () => new Date().toISOString(),
  YEAR: (d) => new Date(String(d)).getFullYear(),
  MONTH: (d) => new Date(String(d)).getMonth() + 1,
  DAY: (d) => new Date(String(d)).getDate(),
  DAYS_BETWEEN: (a, b) => {
    const d1 = new Date(String(a)).getTime();
    const d2 = new Date(String(b)).getTime();
    if (Number.isNaN(d1) || Number.isNaN(d2)) return 0;
    return Math.round((d2 - d1) / 86_400_000);
  },
  ADD_DAYS: (d, n) => {
    const date = new Date(String(d));
    if (Number.isNaN(date.getTime())) return null;
    date.setDate(date.getDate() + Number(n ?? 0));
    return date.toISOString().slice(0, 10);
  },
  /** Real-estate helpers so admins can express pricing without arithmetic soup. */
  LAKH: (n) => Number(n ?? 0) * 100_000,
  CRORE: (n) => Number(n ?? 0) * 10_000_000,
  TO_LAKH: (n) => Number(n ?? 0) / 100_000,
  TO_CRORE: (n) => Number(n ?? 0) / 10_000_000,
  SQFT_TO_SQM: (n) => Number(n ?? 0) * 0.092903,
  SQM_TO_SQFT: (n) => Number(n ?? 0) / 0.092903,
  PERCENT_OF: (value, pct) => (Number(value ?? 0) * Number(pct ?? 0)) / 100,
};

function truthy(v: Value): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return String(v).length > 0 && String(v) !== 'false';
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[], private scope: Record<string, unknown>) {}

  parse(): Value {
    const v = this.parseOr();
    if (this.pos < this.tokens.length) throw new Error('unexpected trailing tokens in formula');
    return v;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  private matchOp(...ops: string[]): string | null {
    const t = this.peek();
    if (t?.t === 'op' && ops.includes(t.v)) { this.pos++; return t.v; }
    return null;
  }

  private parseOr(): Value {
    let left = this.parseAnd();
    while (this.matchOp('||')) {
      const right = this.parseAnd();
      left = truthy(left) || truthy(right);
    }
    return left;
  }

  private parseAnd(): Value {
    let left = this.parseComparison();
    while (this.matchOp('&&')) {
      const right = this.parseComparison();
      left = truthy(left) && truthy(right);
    }
    return left;
  }

  private parseComparison(): Value {
    let left = this.parseAdditive();
    for (;;) {
      const op = this.matchOp('==', '=', '!=', '<', '>', '<=', '>=');
      if (!op) break;
      const right = this.parseAdditive();
      left = compare(op, left, right);
    }
    return left;
  }

  private parseAdditive(): Value {
    let left = this.parseMultiplicative();
    for (;;) {
      const op = this.matchOp('+', '-');
      if (!op) break;
      const right = this.parseMultiplicative();
      if (op === '+') {
        left = typeof left === 'string' || typeof right === 'string'
          ? `${left ?? ''}${right ?? ''}`
          : Number(left ?? 0) + Number(right ?? 0);
      } else {
        left = Number(left ?? 0) - Number(right ?? 0);
      }
    }
    return left;
  }

  private parseMultiplicative(): Value {
    let left = this.parseUnary();
    for (;;) {
      const op = this.matchOp('*', '/', '%');
      if (!op) break;
      const right = this.parseUnary();
      const a = Number(left ?? 0);
      const b = Number(right ?? 0);
      if (op === '*') left = a * b;
      else if (op === '/') left = b === 0 ? 0 : a / b;
      else left = b === 0 ? 0 : a % b;
    }
    return left;
  }

  private parseUnary(): Value {
    if (this.matchOp('!')) return !truthy(this.parseUnary());
    if (this.matchOp('-')) return -Number(this.parseUnary() ?? 0);
    return this.parsePrimary();
  }

  private parsePrimary(): Value {
    const t = this.next();
    if (!t) throw new Error('unexpected end of formula');

    if (t.t === 'num') return t.v;
    if (t.t === 'str') return t.v;
    if (t.t === 'field') {
      const raw = this.scope[t.v];
      if (raw === undefined || raw === null) return null;
      if (typeof raw === 'boolean' || typeof raw === 'number' || typeof raw === 'string') return raw;
      return String(raw);
    }
    if (t.t === 'lparen') {
      const v = this.parseOr();
      const close = this.next();
      if (close?.t !== 'rparen') throw new Error('missing )');
      return v;
    }
    if (t.t === 'ident') {
      const upper = t.v.toUpperCase();
      if (upper === 'TRUE') return true;
      if (upper === 'FALSE') return false;
      if (upper === 'NULL') return null;
      const fn = FUNCTIONS[upper];
      if (!fn) throw new Error(`unknown function '${t.v}'`);
      if (this.peek()?.t !== 'lparen') throw new Error(`expected ( after ${t.v}`);
      this.pos++;
      const args: Value[] = [];
      if (this.peek()?.t !== 'rparen') {
        for (;;) {
          args.push(this.parseOr());
          const nx = this.peek();
          if (nx?.t === 'comma') { this.pos++; continue; }
          break;
        }
      }
      if (this.next()?.t !== 'rparen') throw new Error(`missing ) in ${t.v}(...)`);
      return fn(...args);
    }
    throw new Error('unexpected token in formula');
  }
}

function compare(op: string, a: Value, b: Value): boolean {
  const bothNumeric = a !== null && b !== null && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b))
    && !(typeof a === 'string' && a.trim() === '') && !(typeof b === 'string' && b.trim() === '');
  const x: Value = bothNumeric ? Number(a) : a;
  const y: Value = bothNumeric ? Number(b) : b;
  switch (op) {
    case '==':
    case '=': return x === y || String(x) === String(y);
    case '!=': return !(x === y || String(x) === String(y));
    case '<': return (x as number) < (y as number);
    case '>': return (x as number) > (y as number);
    case '<=': return (x as number) <= (y as number);
    case '>=': return (x as number) >= (y as number);
    default: return false;
  }
}

/**
 * Evaluate `expression` against a record's value bag.
 * Returns undefined (rather than throwing) on a bad formula so one broken
 * admin-authored field never blocks a save; the error is reported at design time.
 */
export function evaluateFormula(expression: string, scope: Record<string, unknown>): Value | undefined {
  try {
    return new Parser(tokenize(expression), scope).parse();
  } catch {
    return undefined;
  }
}

/** Design-time validation used by the field builder to show errors immediately. */
export function validateFormula(expression: string): { valid: boolean; error?: string } {
  try {
    // Parse against an empty scope; missing fields resolve to null, which is fine.
    new Parser(tokenize(expression), {}).parse();
    return { valid: true };
  } catch (err) {
    return { valid: false, error: err instanceof Error ? err.message : 'invalid formula' };
  }
}

export const FORMULA_FUNCTIONS = Object.keys(FUNCTIONS).sort();
