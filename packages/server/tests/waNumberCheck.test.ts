import { describe, expect, it } from 'vitest';
import { cappedDailyLimit, isWhatsAppPhotoHost, MAX_DAILY_CAP } from '../src/integrations/whatsapp/business/numberCheck.js';

describe('the number checker\'s safety rules', () => {
  it('fetches pictures only from WhatsApp\'s own hosts over https', () => {
    expect(isWhatsAppPhotoHost('https://pps.whatsapp.net/v/t61/abc.jpg')).toBe(true);
    expect(isWhatsAppPhotoHost('https://scontent.xx.fbcdn.net/x.jpg')).toBe(true);
    expect(isWhatsAppPhotoHost('http://pps.whatsapp.net/abc.jpg')).toBe(false);
    expect(isWhatsAppPhotoHost('https://evil.example.com/whatsapp.net')).toBe(false);
    expect(isWhatsAppPhotoHost('https://nottruewhatsapp.net/x.jpg')).toBe(false);
    expect(isWhatsAppPhotoHost('http://127.0.0.1:2785/x')).toBe(false);
    expect(isWhatsAppPhotoHost('not a url')).toBe(false);
  });
  it('keeps the daily cap sane: a default for nonsense, never above the ceiling, never silly low', () => {
    expect(cappedDailyLimit(undefined)).toBe(150);
    expect(cappedDailyLimit(-5)).toBe(150);
    expect(cappedDailyLimit(1)).toBe(10);
    expect(cappedDailyLimit(99999)).toBe(MAX_DAILY_CAP);
    expect(cappedDailyLimit(200)).toBe(200);
  });
});
