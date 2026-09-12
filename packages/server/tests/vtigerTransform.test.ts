import { describe, expect, it } from 'vitest';
import {
  transformContact, transformNote, transformTask, transformMeeting,
  transformEmail, transformCall, parseVtigerCurrency,
} from '../src/scripts/vtiger/transform.js';

// Shape matches the live account's discovery pull; values are synthetic —
// never the real customer's name/phone/email.
const SAMPLE_CONTACT = {
  id: '12x555',
  firstname: '', lastname: 'Test Buyer',
  email: 'buyer@example.com', mobile: '9811100000', otherphone: '',
  contacttype: 'Buyer', leadsource: 'Propertywala', title: 'Apartment',
  contactstatus: 'Lead Lost', happiness_rating: 'Greenfields Colony',
  cf_contacts_beds: '3 BHK', cf_contacts_test4: 'Deal with others',
  cf_contacts_budgetdemand: '', support_end_date: '2026-03-15',
  language: '', assigned_user_id: '19x1',
  department: 'B-204', cf_contacts_ertyu: '', cf_contacts_test2: '',
  cf_contacts_test5: '5th Floor', cf_contacts_test6: '', cf_contacts_test7: '',
  birthday: '',
  createdtime: '2019-06-01 10:00:00', modifiedtime: '2026-01-10 09:30:00',
};

const KNOWN = {
  contact_type: new Set(['Buyer', 'Seller', 'Tenant', 'Landlord']),
  lead_source: new Set(['99acres', 'Website', 'Referral']), // deliberately missing 'Propertywala'
  property_type: new Set(['Apartment', 'Villa']),
  configuration: new Set(['3 BHK', '4 BHK']),
  locality: new Set<string>(), // deliberately empty, like a dynamic list
  lost_reason: new Set(['Budget Mismatch']), // deliberately missing 'Deal with others'
};

function opts(overrides: Partial<typeof KNOWN> = {}) {
  return {
    existingPicklistValues: { ...KNOWN, ...overrides },
    resolveOwner: (id: string | undefined) => (id === '19x1' ? 'ipropy-user-uuid' : undefined),
  };
}

describe('transformContact', () => {
  it('maps the direct-match fields and preserves historical dates', () => {
    const result = transformContact(SAMPLE_CONTACT, opts());
    expect(result.values.full_name).toBe('Test Buyer');
    expect(result.values.mobile).toBe('9811100000');
    expect(result.values.contact_type).toBe('Buyer');
    expect(result.values.property_type).toBe('Apartment');
    expect(result.values.configuration).toEqual(['3 BHK']);
    expect(result.values.owner_id).toBe('ipropy-user-uuid');
    expect(result.createdAt).toBe(new Date('2019-06-01T10:00:00').toISOString());
    expect(result.updatedAt).toBe(new Date('2026-01-10T09:30:00').toISOString());
  });

  it('maps the known pipeline stage cleanly', () => {
    const result = transformContact(SAMPLE_CONTACT, opts());
    expect(result.values.status).toBe('Lost');
    expect(result.warnings).toHaveLength(0);
  });

  it('falls back to New and warns on an unmapped stage, rather than leaving it unset', () => {
    const result = transformContact({ ...SAMPLE_CONTACT, contactstatus: 'Some New Stage' }, opts());
    expect(result.values.status).toBe('New');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ field: 'contactstatus' }),
    );
  });

  it('flags a value not already in the target picklist, rather than silently coercing it', () => {
    const result = transformContact(SAMPLE_CONTACT, opts());
    expect(result.newPicklistValues).toContainEqual({ picklist: 'lead_source', value: 'Propertywala' });
    expect(result.newPicklistValues).toContainEqual({ picklist: 'lost_reason', value: 'Deal with others' });
    // Already-known values must NOT be flagged
    expect(result.newPicklistValues).not.toContainEqual(expect.objectContaining({ picklist: 'contact_type' }));
  });

  it('wraps a single locality/bedroom value into the array field iPropy expects', () => {
    const result = transformContact(SAMPLE_CONTACT, opts());
    expect(result.values.preferred_locations).toEqual(['Greenfields Colony']);
  });

  it('folds property-shaped asides into one qualification note, none of them dropped', () => {
    const result = transformContact(SAMPLE_CONTACT, opts());
    const notes = result.values.qualification_notes as string;
    expect(notes).toContain('Unit Number: B-204');
    expect(notes).toContain('Floor: 5th Floor');
    expect(notes).not.toContain('Unit Type'); // was blank on this row — not printed as "Unit Type: "
  });

  it('handles the name being entirely in firstname instead of lastname', () => {
    const result = transformContact({ ...SAMPLE_CONTACT, firstname: 'Whole Name Here', lastname: '' }, opts());
    expect(result.values.full_name).toBe('Whole Name Here');
  });

  it('warns when a row has neither a usable phone nor an email', () => {
    const result = transformContact({ ...SAMPLE_CONTACT, mobile: '', email: '' }, opts());
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ field: 'mobile/email' }),
    );
  });

  it('leaves budget undefined rather than 0 when the multicurrency field is blank', () => {
    const result = transformContact(SAMPLE_CONTACT, opts());
    expect(result.values.budget).toBeUndefined();
  });
});

describe('parseVtigerCurrency', () => {
  it('reads a plain Indian-formatted amount', () => {
    expect(parseVtigerCurrency('85,00,000')).toBe(8_500_000);
  });

  it('reads the value before Vtiger multicurrency\'s "::" separator', () => {
    expect(parseVtigerCurrency('8500000::Indian Rupee:1.0:8500000:8500000')).toBe(8_500_000);
  });

  it('returns undefined, not 0, for an empty or unreadable value', () => {
    expect(parseVtigerCurrency('')).toBeUndefined();
    expect(parseVtigerCurrency(undefined)).toBeUndefined();
  });
});

describe('transformNote', () => {
  it('maps a ModComments row to a comment body with its Vtiger linkage', () => {
    const result = transformNote({
      commentcontent: 'Called, wants a site visit next week', related_to: '12x555',
      creator: '19x1', is_private: '0', createdtime: '2024-05-01 12:00:00',
    });
    expect(result?.body).toBe('Called, wants a site visit next week');
    expect(result?.relatedVtigerId).toBe('12x555');
    expect(result?.isPrivate).toBe(false);
  });

  it('returns null for a comment with no content, rather than a blank timeline entry', () => {
    expect(transformNote({ commentcontent: '', related_to: '12x555' })).toBeNull();
  });
});

describe('transformTask / transformMeeting', () => {
  it('formats a task into a labelled note, keeping status and description', () => {
    const result = transformTask({
      subject: 'Follow up on loan approval', taskstatus: 'In Progress',
      description: 'Bank confirmed pre-approval', date_start: '2024-06-01',
      contact_id: '12x555', createdtime: '2024-06-01 09:00:00',
    });
    expect(result?.body).toContain('[Task] Follow up on loan approval');
    expect(result?.body).toContain('Status: In Progress');
    expect(result?.body).toContain('Bank confirmed pre-approval');
    expect(result?.relatedVtigerId).toBe('12x555');
  });

  it('formats a meeting/site-visit with check-in details when present', () => {
    const result = transformMeeting({
      subject: 'Site visit', location: 'Baner project site',
      checkin_datetime: '2024-06-02 11:00:00', actual_checkedin_location: 'Baner',
      contact_id: '12x555',
    });
    expect(result?.body).toContain('[Meeting] Site visit');
    expect(result?.body).toContain('Checked in: 2024-06-02 11:00:00 at Baner');
  });
});

describe('transformEmail', () => {
  it('maps a Contacts-linked email and splits multi-address fields', () => {
    const result = transformEmail({
      parent_type: 'Contacts', parent_id: '12x555', subject: 'Brochure attached',
      from_email: 'rep@dsassociates.com', saved_toid: 'buyer@example.com, second@example.com',
      description: 'Please find attached', createdtime: '2024-07-01 10:00:00',
    });
    expect(result?.toAddresses).toEqual(['buyer@example.com', 'second@example.com']);
    expect(result?.relatedVtigerId).toBe('12x555');
  });

  it('skips an email not linked to a Contact', () => {
    expect(transformEmail({ parent_type: 'Accounts', parent_id: '5x1' })).toBeNull();
  });
});

describe('transformCall', () => {
  it('maps a Contacts-linked call with direction-appropriate from/to', () => {
    const result = transformCall({
      customertype: 'Contacts', customer: '12x555', customernumber: '9811100000',
      direction: 'Inbound', totalduration: '120', starttime: '2024-08-01 09:00:00',
    });
    expect(result?.direction).toBe('inbound');
    expect(result?.fromNumber).toBe('9811100000');
    expect(result?.durationSeconds).toBe(120);
  });

  it('skips a call not linked to a Contact', () => {
    expect(transformCall({ customertype: 'Leads', customer: '7x1' })).toBeNull();
  });
});
