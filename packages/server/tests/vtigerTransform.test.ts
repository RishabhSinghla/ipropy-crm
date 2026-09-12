import { describe, expect, it } from 'vitest';
import {
  transformNote, transformTask, transformMeeting,
  transformEmail, transformCall, parseVtigerCurrency,
} from '../src/scripts/vtiger/transform.js';
import { buildLead, buildInventory, type TargetSchema } from '../src/scripts/vtiger/buildRecord.js';
import { destinationFor } from '../src/scripts/vtiger/routing.js';

// Shape matches the live account's discovery pull; values are synthetic —
// never the real customer's name/phone/email.
const SAMPLE = {
  id: '12x555',
  firstname: '', lastname: 'Test Person',
  email: 'person@example.com', mobile: '9811100000', otherphone: '9822200000',
  contacttype: 'Buyer', leadsource: 'Propertywala', title: 'Apartment',
  contactstatus: 'Lead Won', happiness_rating: 'Greenfields Colony',
  cf_contacts_beds: '3 BHK', cf_contacts_test4: 'Deal with others',
  cf_contacts_budgetdemand: '8500000', support_end_date: '2026-03-15',
  department: 'B-204', cf_contacts_test5: '5th Floor', cf_contacts_test6: 'North',
  cf_contacts_test7: '1800', cf_contacts_test2: 'Front', cf_contacts_ertyu: 'Builder Floor',
  cf_contacts_test3: 'VIP Group', othercity: 'Second unit note',
  assigned_user_id: '19x1', createdtime: '2019-06-01 10:00:00', modifiedtime: '2026-01-10 09:30:00',
  // noise Vtiger keeps on every row — must not appear in the notes
  record_currency_id: '1', timespentinlead_won: '3600', isclosed: '0',
};

/** A schema where everything resolves — the healthy case. */
function fullSchema(overrides: Partial<Record<string, string | null>> = {}): TargetSchema {
  const fields: Record<string, string | null> = {
    full_name: 'full_name', mobile: 'mobile', alternate_phone: 'alternate_phone',
    email: 'email', secondary_email: 'secondary_email', status: 'status',
    contact_type: 'contact_type', lead_source: 'lead_source', property_type: 'property_type',
    configuration: 'configuration', preferred_locations: 'preferred_locations',
    lost_reason: 'lost_reason', budget: 'budget', next_followup_at: 'next_followup_at',
    preferred_language: 'preferred_language', notes: 'qualification_notes',
    // inventory side
    category: 'category', unit_type: 'unit_type', unit_number: 'unit_number',
    portion_type: 'portion_type', floor: 'floor', facing: 'facing', bedrooms: 'bedrooms',
    area_size: 'area_size', area_size_unit: 'area_size_unit', asking_price: 'asking_price',
    asking_price_unit: 'asking_price_unit', next_follow_up: 'next_follow_up',
    property_source: 'property_source', block_tower: 'block_tower',
    ...overrides,
  };
  const picklists: Record<string, string> = {
    status: 'lead_status', contact_type: 'contact_type', lead_source: 'lead_source',
    property_type: 'property_type', configuration: 'configuration',
    preferred_locations: 'locality', lost_reason: 'lost_reason', category: 'property_type',
    facing: 'facing', portion_type: 'portion_type', bedrooms: 'configuration', floor: 'floor_list',
    property_source: 'lead_source', unit_type: 'property_type',
  };
  const known: Record<string, Set<string>> = {
    lead_status: new Set(['New', 'Converted', 'Lost', 'Negotiation', 'Qualified', 'Site Visit Scheduled', 'Attempted Contact']),
    property_status: new Set(['Available', 'Held', 'Sold', 'Not For Sale']),
    contact_type: new Set(['Buyer', 'Seller', 'Tenant']),
    lead_source: new Set(['99acres']), // deliberately missing 'Propertywala'
    property_type: new Set(['Apartment', 'Builder Floor']),
    configuration: new Set(['3 BHK']),
    locality: new Set<string>(),
    lost_reason: new Set(['Budget Mismatch']),
    facing: new Set(['North', 'South']),
    floor_list: new Set(['Ground']),
    portion_type: new Set<string>(),
  };
  return {
    fields,
    notesField: fields.notes ?? null,
    picklistOf: (f) => picklists[f] ?? null,
    knownValues: (p) => known[p] ?? new Set<string>(),
    resolveOwner: (id) => (id === '19x1' ? 'user-uuid' : undefined),
  };
}

describe('destinationFor', () => {
  it('sends only Sellers to inventories', () => {
    expect(destinationFor('Seller')).toBe('inventory');
    expect(destinationFor('seller')).toBe('inventory'); // case shouldn't decide this
    expect(destinationFor('Buyer')).toBe('lead');
    expect(destinationFor('Tenant')).toBe('lead');
    expect(destinationFor('Dealer')).toBe('lead');
    expect(destinationFor('Builder')).toBe('lead');
    expect(destinationFor('Vendor')).toBe('lead');
    expect(destinationFor('Landlord')).toBe('lead');
    expect(destinationFor('')).toBe('lead');
    expect(destinationFor(undefined)).toBe('lead');
  });
});

describe('buildLead', () => {
  it('maps the person, the requirement and the historical dates', () => {
    const r = buildLead(SAMPLE, fullSchema());
    expect(r.values.full_name).toBe('Test Person');
    expect(r.values.mobile).toBe('9811100000');
    expect(r.values.alternate_phone).toBe('9822200000');
    expect(r.values.contact_type).toBe('Buyer');
    expect(r.values.property_type).toBe('Apartment');
    expect(r.values.configuration).toEqual(['3 BHK']);
    expect(r.values.preferred_locations).toEqual(['Greenfields Colony']);
    expect(r.values.budget).toBe(8_500_000);
    expect(r.createdAt).toBe(new Date('2019-06-01T10:00:00').toISOString());
  });

  it('translates the Vtiger stage into the lead pipeline', () => {
    expect(buildLead(SAMPLE, fullSchema()).values.status).toBe('Converted');
    expect(buildLead({ ...SAMPLE, contactstatus: 'Lead Lost' }, fullSchema()).values.status).toBe('Lost');
    expect(buildLead({ ...SAMPLE, contactstatus: 'New Contact' }, fullSchema()).values.status).toBe('New');
  });

  it('keeps the original Vtiger stage in the notes, since three mappings are guesses', () => {
    const r = buildLead(SAMPLE, fullSchema());
    expect(r.values.qualification_notes).toContain('Vtiger stage: Lead Won');
  });

  it('falls back to New and warns on a stage nobody mapped', () => {
    const r = buildLead({ ...SAMPLE, contactstatus: 'Brand New Stage' }, fullSchema());
    expect(r.values.status).toBe('New');
    expect(r.warnings.join(' ')).toContain('Brand New Stage');
  });

  it('flags a dropdown value the target does not have, rather than bending it', () => {
    const r = buildLead(SAMPLE, fullSchema());
    expect(r.newPicklistValues).toContainEqual({ picklist: 'lead_source', value: 'Propertywala' });
    expect(r.newPicklistValues).toContainEqual({ picklist: 'lost_reason', value: 'Deal with others' });
    expect(r.newPicklistValues).not.toContainEqual(expect.objectContaining({ picklist: 'contact_type' }));
  });

  it('writes a value into notes when the field does not exist on this database', () => {
    const r = buildLead(SAMPLE, fullSchema({ property_type: null, budget: null }));
    const notes = String(r.values.qualification_notes);
    expect(notes).toContain('Category: Apartment');
    expect(notes).toContain('budget: 8500000');
    expect(r.values.property_type).toBeUndefined();
  });

  it('carries every other populated Vtiger column into the notes', () => {
    const notes = String(buildLead(SAMPLE, fullSchema()).values.qualification_notes);
    expect(notes).toContain('Group: VIP Group');       // cf_contacts_test3, never explicitly mapped
    expect(notes).toContain('Second Unit: Second unit note');
  });

  it('leaves Vtiger internal bookkeeping out of the notes', () => {
    const notes = String(buildLead(SAMPLE, fullSchema()).values.qualification_notes);
    expect(notes).not.toContain('record_currency_id');
    expect(notes).not.toContain('timespentinlead_won');
    expect(notes).not.toContain('isclosed');
  });

  it('handles the whole name sitting in firstname instead of lastname', () => {
    const r = buildLead({ ...SAMPLE, firstname: 'Only First', lastname: '' }, fullSchema());
    expect(r.values.full_name).toBe('Only First');
  });

  it('never leaves a record nameless', () => {
    const r = buildLead({ ...SAMPLE, firstname: '', lastname: '' }, fullSchema());
    expect(r.values.full_name).toBe('(no name in Vtiger)');
  });
});

describe('buildInventory — a Seller becomes a unit', () => {
  const seller = { ...SAMPLE, contacttype: 'Seller' };

  it('keeps the owner reachable on the inventory record', () => {
    const r = buildInventory(seller, fullSchema());
    expect(r.values.full_name).toBe('Test Person');
    expect(r.values.mobile).toBe('9811100000');
    expect(r.values.email).toBe('person@example.com');
    expect(r.values.contact_type).toBe('Seller');
  });

  it('maps the unit details that sit on the Vtiger contact', () => {
    const r = buildInventory(seller, fullSchema());
    expect(r.values.unit_number).toBe('B-204');
    expect(r.values.facing).toBe('North');
    expect(r.values.portion_type).toBe('Front');
    expect(r.values.bedrooms).toBe('3 BHK');
    expect(r.values.area_size).toBe(1800);
  });

  it("reads the seller's Budget as their asking price", () => {
    expect(buildInventory(seller, fullSchema()).values.asking_price).toBe(8_500_000);
  });

  it('translates the Vtiger stage into the property pipeline, not the lead one', () => {
    expect(buildInventory(seller, fullSchema()).values.status).toBe('Sold'); // Lead Won
    expect(buildInventory({ ...seller, contactstatus: 'Lead Lost' }, fullSchema()).values.status).toBe('Not For Sale');
    expect(buildInventory({ ...seller, contactstatus: 'Property Available' }, fullSchema()).values.status).toBe('Available');
    expect(buildInventory({ ...seller, contactstatus: 'Negotiation' }, fullSchema()).values.status).toBe('Held');
  });

  // Production types Floor, Portion and Facing as dropdowns, not numbers, so
  // the value goes across as written and the option is added if it is new.
  // Coercing "5th Floor" to 5 would have been wrong there, and lossy.
  it('keeps the floor exactly as written and offers it as a new dropdown option', () => {
    const r = buildInventory(seller, fullSchema());
    expect(r.values.floor).toBe('5th Floor');
    expect(r.newPicklistValues).toContainEqual({ picklist: 'floor_list', value: '5th Floor' });
  });

  it('handles a floor with no number in it at all', () => {
    const r = buildInventory({ ...seller, cf_contacts_test5: 'Ground' }, fullSchema());
    expect(r.values.floor).toBe('Ground');
  });

  it('puts the floor in notes when the module has no floor field', () => {
    const r = buildInventory({ ...seller }, fullSchema({ floor: null }));
    expect(String(r.values.qualification_notes)).toContain('Floor: 5th Floor');
  });

  it('warns rather than losing values when the module has no notes field at all', () => {
    const r = buildInventory(seller, fullSchema({ notes: null, block_tower: null }));
    expect(r.warnings.join(' ')).toContain('no notes field');
  });
});

describe('parseVtigerCurrency', () => {
  it('reads a plain Indian-formatted amount', () => {
    expect(parseVtigerCurrency('85,00,000')).toBe(8_500_000);
  });
  it('reads the value before multicurrency\'s "::" separator', () => {
    expect(parseVtigerCurrency('8500000::Indian Rupee:1.0:8500000')).toBe(8_500_000);
  });
  it('returns undefined, not 0, when there is nothing to read', () => {
    expect(parseVtigerCurrency('')).toBeUndefined();
    expect(parseVtigerCurrency(undefined)).toBeUndefined();
  });
});

describe('transformNote', () => {
  it('maps a comment with its Vtiger linkage', () => {
    const r = transformNote({
      commentcontent: 'Called, wants a site visit', related_to: '12x555',
      creator: '19x1', is_private: '0', createdtime: '2024-05-01 12:00:00',
    });
    expect(r?.body).toBe('Called, wants a site visit');
    expect(r?.relatedVtigerId).toBe('12x555');
  });
  it('returns null for an empty comment rather than a blank timeline entry', () => {
    expect(transformNote({ commentcontent: '', related_to: '12x555' })).toBeNull();
  });
});

describe('transformTask / transformMeeting', () => {
  it('formats a task, keeping status and description', () => {
    const r = transformTask({
      subject: 'Follow up on loan', taskstatus: 'In Progress',
      description: 'Bank confirmed', date_start: '2024-06-01', contact_id: '12x555',
    });
    expect(r?.body).toContain('[Task] Follow up on loan');
    expect(r?.body).toContain('Status: In Progress');
  });
  it('formats a site visit with its check-in', () => {
    const r = transformMeeting({
      subject: 'Site visit', location: 'Baner', checkin_datetime: '2024-06-02 11:00:00',
      actual_checkedin_location: 'Baner', contact_id: '12x555',
    });
    expect(r?.body).toContain('[Meeting] Site visit');
    expect(r?.body).toContain('Checked in: 2024-06-02 11:00:00 at Baner');
  });
});

describe('transformEmail / transformCall', () => {
  it('splits multi-address fields', () => {
    const r = transformEmail({
      parent_type: 'Contacts', parent_id: '12x555', subject: 'Brochure',
      from_email: 'rep@example.com', saved_toid: 'a@example.com, b@example.com',
    });
    expect(r?.toAddresses).toEqual(['a@example.com', 'b@example.com']);
  });
  it('skips anything not linked to a contact', () => {
    expect(transformEmail({ parent_type: 'Accounts', parent_id: '5x1' })).toBeNull();
    expect(transformCall({ customertype: 'Leads', customer: '7x1' })).toBeNull();
  });
  it('maps a call with direction-appropriate from/to', () => {
    const r = transformCall({
      customertype: 'Contacts', customer: '12x555', customernumber: '9811100000',
      direction: 'Inbound', totalduration: '120',
    });
    expect(r?.direction).toBe('inbound');
    expect(r?.fromNumber).toBe('9811100000');
    expect(r?.durationSeconds).toBe(120);
  });
});
