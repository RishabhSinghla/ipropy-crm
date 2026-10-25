import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTOMATIC_MESSAGE_TEXT, isAutomationOnlyProvider, parseRoles, redactAutomated, rolesInUse, setChannelRolesInMemory,
} from '../src/integrations/whatsapp/business/channelRoles.js';

const OFFICIAL = 'whatsapp_meta';
const PHONE = 'whatsapp_openwa';

afterEach(() => setChannelRolesInMemory({ automation: null, chat: null }));

const rows = [
  { id: '1', direction: 'outbound', provider: OFFICIAL, type: 'template', body: 'Hi Asha, 3BHK at Sector 50', template_name: 'new_lead', media: { x: 1 }, error_message: 'boom', sent_by_name: 'Ravi' },
  { id: '2', direction: 'inbound', provider: OFFICIAL, type: 'text', body: 'Yes please call me', template_name: null, media: null, error_message: null, sent_by_name: null },
  { id: '3', direction: 'outbound', provider: PHONE, type: 'text', body: 'Sure, 5pm works', template_name: null, media: null, error_message: null, sent_by_name: 'Ravi' },
];

describe('WhatsApp channel roles', () => {
  it('ignore anything that is not a WhatsApp route', () => {
    expect(parseRoles({ automation: 'smtp', chat: 7 })).toEqual({ automation: null, chat: null });
  });

  it('change nothing until an admin sets one', () => {
    expect(rolesInUse()).toBe(false);
    expect(isAutomationOnlyProvider(OFFICIAL)).toBe(false);
    expect(redactAutomated(rows, false).map((r) => r.body)).toEqual(rows.map((r) => r.body));
  });

  it('hide an automatic message from the team but never a customer reply or a chat message', () => {
    setChannelRolesInMemory({ automation: OFFICIAL, chat: PHONE });
    const [auto, reply, chat] = redactAutomated(rows, false);
    expect(auto).toMatchObject({ body: AUTOMATIC_MESSAGE_TEXT, template_name: null, media: null, error_message: null, sent_by_name: null, automated: true });
    expect(auto).not.toHaveProperty('provider');
    expect(reply!.body).toBe('Yes please call me');
    expect(chat!.body).toBe('Sure, 5pm works');
  });

  it('let an admin read everything, still flagged as automatic', () => {
    setChannelRolesInMemory({ automation: OFFICIAL, chat: PHONE });
    const [auto] = redactAutomated(rows, true);
    expect(auto).toMatchObject({ body: 'Hi Asha, 3BHK at Sector 50', template_name: 'new_lead', automated: true });
    expect(auto).not.toHaveProperty('provider');
  });

  it('treat a route used for both jobs as ordinary chat', () => {
    setChannelRolesInMemory({ automation: OFFICIAL, chat: OFFICIAL });
    expect(isAutomationOnlyProvider(OFFICIAL)).toBe(false);
  });
});
