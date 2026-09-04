/**
 * The refresh token, kept where a script cannot read it.
 *
 * Both tokens lived in `localStorage`, which any script running on the page can
 * read — an injected advert, a compromised dependency, a bookmarklet. The access
 * token being there is a small problem because it expires in minutes. The
 * refresh token being there is a large one: it is good for thirty days and its
 * whole purpose is minting access tokens, so a copy of it is a month of somebody
 * else's login.
 *
 * `httpOnly` is the fix, and it is the only fix — nothing else stops a script
 * reading a value the browser will hand it.
 *
 * Scoped to `/api/auth`, so it is attached to the two requests that need it and
 * to no other. A cookie sent on every image and API call is a cookie with a
 * hundred more chances to end up somewhere it should not.
 *
 * `sameSite: 'strict'` because the app and the API are one origin in every
 * environment: production serves the built web app from the same service, and in
 * development Vite proxies `/api`, so the browser sees one origin there too.
 *
 * Nothing here logs anybody out. The server keeps accepting a refresh token in
 * the request body, so a browser holding the old localStorage value carries on
 * working until it next refreshes, at which point it gets a cookie and stops
 * needing the old one.
 */
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { refreshLifetimeMs } from './session.js';

export const REFRESH_COOKIE = 'ipropy_rt';

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Only over HTTPS in production. Setting it in development would mean the
    // cookie is never stored over plain http, and sign-in would appear to work
    // and then silently fail to persist.
    secure: config.isProd,
    sameSite: 'strict',
    path: '/api/auth',
    // The same number the stored session expires on, from one place.
    maxAge: refreshLifetimeMs(),
  });
}

export function clearRefreshCookie(res: Response): void {
  // The attributes must match the ones it was set with or the browser keeps it.
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'strict',
    path: '/api/auth',
  });
}

/**
 * The refresh token for this request: the cookie first, then the body.
 *
 * The body is the transition path and it is deliberately still accepted. Every
 * browser already signed in is holding its token in localStorage, and refusing
 * it would sign out the whole team the moment this deploys.
 */
export function readRefreshToken(req: Request): string | null {
  const fromCookie = parseCookie(req.headers.cookie, REFRESH_COOKIE);
  if (fromCookie) return fromCookie;
  const body = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
  return typeof body === 'string' && body.length >= 10 ? body : null;
}

/**
 * One named cookie out of the header.
 *
 * Hand-parsed rather than adding a dependency for a single value we generate
 * ourselves: the token is base64url, so it carries no quoting, no separators and
 * nothing that needs decoding. A general-purpose parser would be more code and
 * more supply chain for no gain here.
 */
function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value.length ? value : null;
  }
  return null;
}
