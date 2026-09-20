import { describe, expect, it } from 'vitest';
import { WHATSAPP_BASE, tabHref } from '../src/lib/whatsapp';

/**
 * The WhatsApp page's tabs must link absolutely.
 *
 * **This is a real bug that was live for about an hour on 20 September.** The
 * tabs used `to="chats"`, which inside a route matched as `/whatsapp/*` does
 * not resolve against `/whatsapp` — it resolves against the whole current
 * pathname. So the address grew on every click and every render:
 *
 *     /whatsapp/chats
 *     /whatsapp/chats/campaigns
 *     /whatsapp/chats/campaigns/chats/chats/chats/… (a hundred of them)
 *
 * and the page rendered nothing at all. The owner found it by clicking
 * Campaigns once.
 *
 * A relative link looks correct in review and in a single click; it only
 * misbehaves on the second one, which is why this is pinned rather than left
 * to somebody noticing.
 */
describe('the WhatsApp page links to its own tabs', () => {
  it('builds an absolute path, which cannot compound', () => {
    expect(tabHref('campaigns')).toBe('/whatsapp/campaigns');
    expect(tabHref('chats')).toBe('/whatsapp/chats');
  });

  it('never yields a relative path, from anywhere', () => {
    for (const path of ['chats', 'campaigns', 'templates', 'health']) {
      expect(tabHref(path).startsWith('/')).toBe(true);
      // The failure mode itself: a second segment of the same name appearing
      // twice is what the address bar filled up with.
      expect(tabHref(path).split('/').filter((part) => part === path)).toHaveLength(1);
    }
  });

  it('keeps every tab under one base, so the route stays one place', () => {
    expect(tabHref('health').startsWith(`${WHATSAPP_BASE}/`)).toBe(true);
  });
});
