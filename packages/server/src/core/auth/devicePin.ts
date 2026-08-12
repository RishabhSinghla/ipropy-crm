import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { hashPassword, verifyPassword } from '../../middleware/auth.js';

export const PIN_DEVICE_COOKIE = 'ipropy_pin_device';
export const PIN_DEVICE_DAYS = 180;

/** Return one cookie value without adding cookie-parser to the whole server. */
export function pinDeviceToken(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== PIN_DEVICE_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim()) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function pinDeviceTokenHash(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('base64url');
}

function pinMaterial(rawToken: string, pin: string): string {
  return crypto.createHmac('sha256', config.auth.pinPepper)
    .update(`${rawToken}:${pin}`)
    .digest('base64url');
}

export async function hashDevicePin(rawToken: string, pin: string): Promise<string> {
  return hashPassword(pinMaterial(rawToken, pin));
}

export async function verifyDevicePin(rawToken: string, pin: string, hash: string): Promise<boolean> {
  return verifyPassword(pinMaterial(rawToken, pin), hash);
}

/** Four digits are convenient, so reject the handful people guess first. */
export function pinIsTooCommon(pin: string): boolean {
  if (!/^\d{4}$/.test(pin)) return true;
  if (/^(\d)\1{3}$/.test(pin)) return true;
  return new Set([
    '0123', '1234', '2345', '3456', '4567', '5678', '6789',
    '9876', '8765', '7654', '6543', '5432', '4321', '3210',
    '2580', '0852', '1212', '1122', '1010', '2000',
  ]).has(pin);
}

const cookieBase = {
  httpOnly: true,
  secure: config.isProd,
  sameSite: 'strict' as const,
  path: '/api/auth/pin',
};

export function setPinDeviceCookie(res: Response, rawToken: string): void {
  res.cookie(PIN_DEVICE_COOKIE, rawToken, {
    ...cookieBase,
    maxAge: PIN_DEVICE_DAYS * 86_400_000,
  });
}

export function clearPinDeviceCookie(res: Response): void {
  res.clearCookie(PIN_DEVICE_COOKIE, cookieBase);
}
