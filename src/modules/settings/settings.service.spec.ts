import type { tenantSettings, tenants } from '../../database/schema';
import { splitUpdate, toSettings } from './settings.service';

type TenantRow = typeof tenants.$inferSelect;
type SettingsRow = typeof tenantSettings.$inferSelect;

const SHOP = '11111111-1111-4111-8111-111111111111';
const EARLIER = new Date('2026-10-01T08:00:00.000Z');
const LATER = new Date('2026-10-02T09:30:00.000Z');

function tenantRow(over: Partial<TenantRow> = {}): TenantRow {
  return {
    id: SHOP,
    name: 'Al-Madina Traders',
    slug: 'al-madina-traders',
    ownerName: 'Bilal',
    phone: '03001234567',
    email: 'shop@example.com',
    address: 'Grain Market',
    city: 'Okara',
    logoUrl: null,
    status: 'active',
    createdAt: EARLIER,
    updatedAt: EARLIER,
    deletedAt: null,
    ...over,
  };
}

function settingsRow(over: Partial<SettingsRow> = {}): SettingsRow {
  return {
    tenantId: SHOP,
    displayName: 'Al-Madina',
    parchiFooter: null,
    defaultCommissionPct: '0.00',
    marketFeePct: '0.00',
    labourPerBag: '0.00',
    defaultUnit: 'kg',
    maundKg: '40.000',
    billPrefix: null,
    financialYearStart: null,
    language: 'en',
    updatedAt: EARLIER,
    ...over,
  };
}

describe('toSettings()', () => {
  it('merges the shop profile and its settings row (defaults)', () => {
    expect(toSettings(tenantRow(), settingsRow())).toEqual({
      name: 'Al-Madina Traders',
      phone: '03001234567',
      email: 'shop@example.com',
      address: 'Grain Market',
      city: 'Okara',
      logoUrl: null,
      displayName: 'Al-Madina',
      parchiFooter: null,
      defaultCommissionPct: '0.00',
      marketFeePct: '0.00',
      labourPerBag: '0.00',
      defaultUnit: 'kg',
      maundKg: '40.000',
      billPrefix: null,
      financialYearStart: null,
      language: 'en',
      updatedAt: EARLIER.toISOString(),
    });
  });

  it('leaves out internal tenant columns (id, slug, status, owner)', () => {
    const settings = toSettings(tenantRow(), settingsRow());

    expect(settings).not.toHaveProperty('id');
    expect(settings).not.toHaveProperty('tenantId');
    expect(settings).not.toHaveProperty('slug');
    expect(settings).not.toHaveProperty('status');
    expect(settings).not.toHaveProperty('ownerName');
  });

  it('keeps decimal strings exactly as the database returns them', () => {
    const settings = toSettings(
      tenantRow(),
      settingsRow({
        defaultCommissionPct: '2.50',
        labourPerBag: '15.00',
        maundKg: '37.324',
      }),
    );

    expect(settings).toMatchObject({
      defaultCommissionPct: '2.50',
      labourPerBag: '15.00',
      maundKg: '37.324',
    });
  });

  it('updatedAt is the settings row time when it is the later one', () => {
    const settings = toSettings(
      tenantRow({ updatedAt: EARLIER }),
      settingsRow({ updatedAt: LATER }),
    );

    expect(settings.updatedAt).toBe(LATER.toISOString());
  });

  it('updatedAt is the shop time when it is the later one', () => {
    const settings = toSettings(
      tenantRow({ updatedAt: LATER }),
      settingsRow({ updatedAt: EARLIER }),
    );

    expect(settings.updatedAt).toBe(LATER.toISOString());
  });
});

describe('splitUpdate()', () => {
  it('puts profile fields on the shop and the rest on the settings row', () => {
    expect(
      splitUpdate({
        name: 'New Name',
        email: null,
        address: 'Main Bazaar',
        city: 'Sahiwal',
        logoUrl: null,
        displayName: 'NN',
        parchiFooter: null,
        defaultCommissionPct: '2.50',
        marketFeePct: '1',
        labourPerBag: '15.00',
        defaultUnit: 'maund',
        maundKg: '40',
        billPrefix: 'NN-',
        financialYearStart: '2026-07-01',
        language: 'ur',
      }),
    ).toEqual({
      shop: {
        name: 'New Name',
        email: null,
        address: 'Main Bazaar',
        city: 'Sahiwal',
        logoUrl: null,
      },
      settings: {
        displayName: 'NN',
        parchiFooter: null,
        defaultCommissionPct: '2.50',
        marketFeePct: '1',
        labourPerBag: '15.00',
        defaultUnit: 'maund',
        maundKg: '40',
        billPrefix: 'NN-',
        financialYearStart: '2026-07-01',
        language: 'ur',
      },
    });
  });

  it.each([
    ['+92 300 1234567', '03001234567'],
    ['0300-1234567', '03001234567'],
    ['0300 123 4567', '03001234567'],
    ['03001234567', '03001234567'],
  ])('normalises phone %p to %p', (phone, stored) => {
    expect(splitUpdate({ phone })).toEqual({
      shop: { phone: stored },
      settings: {},
    });
  });

  it('only settings fields: the shop part is empty', () => {
    expect(splitUpdate({ maundKg: '40' })).toEqual({
      shop: {},
      settings: { maundKg: '40' },
    });
  });

  it('skips undefined fields but keeps null ones (null clears a value)', () => {
    expect(
      splitUpdate({ city: undefined, address: null, billPrefix: null }),
    ).toEqual({
      shop: { address: null },
      settings: { billPrefix: null },
    });
  });

  it('an empty body changes nothing', () => {
    expect(splitUpdate({})).toEqual({ shop: {}, settings: {} });
  });
});
