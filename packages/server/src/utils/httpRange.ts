export type ByteRange =
  | { ok: true; start: number; end: number }
  | { ok: false };

/** Parse one RFC 7233 byte range and clamp it to a known in-memory payload. */
export function parseByteRange(header: string, size: number): ByteRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0 || (!match[1] && !match[2])) return { ok: false };

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { ok: false };
    return { ok: true, start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
      || start < 0 || start >= size || requestedEnd < start) {
    return { ok: false };
  }
  return { ok: true, start, end: Math.min(requestedEnd, size - 1) };
}
