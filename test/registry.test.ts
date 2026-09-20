import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { resetFake } from '../src/modules/messaging/adapters/fake.js';
import {
  fakeLookup,
  normalizeIdentifiers,
  normalizeName,
  resetFakeLookup,
  seedFakeLookup,
  setCompanyLookup,
} from '../src/spine/registry/index.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

const CR = '1010123456';
const OTHER_CR = '4030999888';
const PHONE = '+966501234567';

let tokenA: string;
let tokenB: string;

function request(path: string, init: RequestInit = {}, token: string | null = tokenA) {
  return app.fetch(
    new Request(`http://engine.test${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers ?? {}),
      },
    }),
  );
}

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type Created = {
  company: { id: string; name: string; country: string | null; merged_into: string | null };
  created: boolean;
  mergedFrom: string[];
};

async function postCompany(body: Record<string, unknown>, token = tokenA): Promise<Created> {
  const res = await request('/v1/companies', { method: 'POST', ...json(body) }, token);
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

beforeAll(async () => {
  await resetDb();
  await startQueue();
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(async () => {
  setCompanyLookup(undefined);
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  resetFake();
  resetFakeLookup();
  setCompanyLookup(null);
});

describe('normalisation', () => {
  it('folds legal forms and case to the same name', () => {
    expect(normalizeName('Al-Falah Trading Co. Ltd')).toBe(normalizeName('AL FALAH TRADING'));
  });

  it('derives a domain from a company email but not a free-mail one', () => {
    const free = normalizeIdentifiers([{ type: 'email', value: 'info@gmail.com' }]);
    expect(free.identifiers).toEqual([{ type: 'email', value: 'info@gmail.com' }]);

    const owned = normalizeIdentifiers([{ type: 'email', value: 'sales@alfalah.com.sa' }]);
    expect(owned.identifiers).toEqual([
      { type: 'email', value: 'sales@alfalah.com.sa' },
      { type: 'domain', value: 'alfalah.com.sa' },
    ]);
  });
});

describe('upsert', () => {
  it('makes one company from three doors, with a source row each', async () => {
    const first = await postCompany({
      name: 'Al Falah Trading',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'file.csv:2' },
    });
    expect(first.created).toBe(true);

    for (const type of ['api', 'rfq'] as const) {
      const again = await postCompany({
        name: 'Al Falah Trading',
        identifiers: [{ type: 'cr', value: CR }],
        source: { type, ref: `${type}-1` },
      });
      expect(again.created).toBe(false);
      expect(again.company.id).toBe(first.company.id);
    }

    const companies = await db()`select id from companies`;
    expect(companies).toHaveLength(1);

    const sources = await withTenant(
      TENANT_A,
      (tx) => tx`select source_type from company_sources where company_id = ${first.company.id}`,
    );
    expect(sources).toHaveLength(3);
  });

  it('merges two companies when one record carries both their identifiers', async () => {
    const x = await postCompany({
      name: 'Al Falah',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'x' },
    });
    const y = await postCompany({
      name: 'Falah Group',
      identifiers: [{ type: 'domain', value: 'alfalah.com.sa' }],
      source: { type: 'import', ref: 'y' },
    });
    expect(y.company.id).not.toBe(x.company.id);

    const merged = await postCompany({
      name: 'Al Falah Trading',
      identifiers: [
        { type: 'cr', value: CR },
        { type: 'domain', value: 'alfalah.com.sa' },
      ],
      source: { type: 'api', ref: 'both' },
    });

    // The older row survives.
    expect(merged.company.id).toBe(x.company.id);
    expect(merged.mergedFrom).toEqual([y.company.id]);

    const [loser] = await db()<{ merged_into: string }[]>`
      select merged_into from companies where id = ${y.company.id}
    `;
    expect(loser!.merged_into).toBe(x.company.id);

    // Identifiers and sources followed the survivor.
    const identifiers = await db()`
      select id from company_identifiers where company_id = ${x.company.id}
    `;
    expect(identifiers).toHaveLength(2);
    const orphanSources = await db()`
      select id from company_sources where company_id = ${y.company.id}
    `;
    expect(orphanSources).toHaveLength(0);

    // Asking for the loser gives the survivor.
    const res = await request(`/v1/companies/${y.company.id}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { company: { id: string } };
    expect(detail.company.id).toBe(x.company.id);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx<{ payload: { losers: string[] } }[]>`
        select payload from events where type = 'company.merged'
      `,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.losers).toEqual([y.company.id]);
  });

  it('links a near-identical Arabic name but keeps different ones apart', async () => {
    const first = await postCompany({
      name: 'شركة الفلاح للتجارة',
      country: 'SA',
      identifiers: [],
      source: { type: 'import', ref: '1' },
    });
    const second = await postCompany({
      name: 'الفلاح للتجاره',
      country: 'SA',
      identifiers: [],
      source: { type: 'import', ref: '2' },
    });
    expect(second.created).toBe(false);
    expect(second.company.id).toBe(first.company.id);

    const other = await postCompany({
      name: 'شركة النور',
      country: 'SA',
      identifiers: [],
      source: { type: 'import', ref: '3' },
    });
    expect(other.created).toBe(true);
    expect(other.company.id).not.toBe(first.company.id);
  });

  it('leaves a weak identifier with the company that already had it', async () => {
    const a = await postCompany({
      name: 'Company A',
      identifiers: [
        { type: 'cr', value: CR },
        { type: 'phone', value: PHONE },
      ],
      source: { type: 'import', ref: 'a' },
    });

    const b = await postCompany({
      name: 'Company B',
      identifiers: [
        { type: 'cr', value: OTHER_CR },
        { type: 'phone', value: PHONE },
      ],
      source: { type: 'import', ref: 'b' },
    });

    expect(b.company.id).not.toBe(a.company.id);

    // B keeps its own CR; the phone stays with A.
    const [phoneOwner] = await db()<{ company_id: string }[]>`
      select company_id from company_identifiers where type = 'phone' and value = ${PHONE}
    `;
    expect(phoneOwner!.company_id).toBe(a.company.id);

    const [source] = await withTenant(
      TENANT_A,
      (tx) => tx<{ data: { conflicts?: { type: string; value: string }[] } }[]>`
        select data from company_sources where company_id = ${b.company.id}
      `,
    );
    expect(source!.data.conflicts).toEqual([
      { type: 'phone', value: PHONE, heldBy: a.company.id },
    ]);
  });
});

describe('tenant scoping', () => {
  it('shares the company but not what each tenant says about it', async () => {
    const created = await postCompany({
      name: 'Shared Co',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'api', ref: 'a' },
      tenantView: { relationship: 'prospect', tags: ['vip'], notes: "A's note" },
    });

    // B sees the company itself.
    const forB = await request(`/v1/companies/${created.company.id}`, {}, tokenB);
    expect(forB.status).toBe(200);
    const detail = (await forB.json()) as {
      company: { id: string };
      tenantView: unknown;
      sources: unknown[];
    };
    expect(detail.company.id).toBe(created.company.id);

    // But not A's view of it, nor A's provenance.
    expect(detail.tenantView).toBeNull();
    expect(detail.sources).toHaveLength(0);
  });

  it("gives tenant B its own view rather than editing A's", async () => {
    const created = await postCompany({
      name: 'Shared Co',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'api', ref: 'a' },
      tenantView: { relationship: 'prospect', tags: ['vip'] },
    });

    const res = await request(
      `/v1/companies/${created.company.id}/view`,
      { method: 'PUT', ...json({ relationship: 'supplier', tags: ['mine'] }) },
      tokenB,
    );
    expect(res.status).toBe(200);

    const rows = await db()<{ tenant_id: string; relationship: string; tags: string[] }[]>`
      select tenant_id, relationship, tags from tenant_company
      where company_id = ${created.company.id} order by tenant_id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.tenant_id === TENANT_A)!.relationship).toBe('prospect');
    expect(rows.find((r) => r.tenant_id === TENANT_B)!.relationship).toBe('supplier');
  });
});

describe('lookup', () => {
  it('fills the name from the registrar and records a lookup source', async () => {
    setCompanyLookup(fakeLookup);
    seedFakeLookup(CR, { name: 'مؤسسة الفلاح التجارية', city: 'Riyadh', status: 'active' });

    const created = await postCompany({
      name: 'whatever the spreadsheet said',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'file.csv:2' },
      enrich: true,
    });

    expect(created.company.name).toBe('مؤسسة الفلاح التجارية');

    const sources = await withTenant(
      TENANT_A,
      (tx) => tx<{ source_type: string; source_ref: string }[]>`
        select source_type, source_ref from company_sources
        where company_id = ${created.company.id} order by source_type
      `,
    );
    expect(sources.map((s) => s.source_type)).toEqual(['import', 'lookup']);
    expect(sources.find((s) => s.source_type === 'lookup')!.source_ref).toBe(`fake:${CR}`);
  });

  it('is a no-op when lookup is disabled', async () => {
    setCompanyLookup(null);

    const created = await postCompany({
      name: 'Unenriched Co',
      identifiers: [{ type: 'cr', value: CR }],
      source: { type: 'import', ref: 'file.csv:2' },
      enrich: true,
    });

    expect(created.company.name).toBe('Unenriched Co');
    const sources = await withTenant(
      TENANT_A,
      (tx) => tx<{ source_type: string }[]>`
        select source_type from company_sources where company_id = ${created.company.id}
      `,
    );
    expect(sources.map((s) => s.source_type)).toEqual(['import']);
  });
});

describe('messages learn the company', () => {
  async function configureMessaging() {
    await request('/v1/channels/sms', {
      method: 'PUT',
      ...json({
        provider: 'fake',
        sender: 'ACME',
        unsubscribeText: 'Reply STOP',
        config: { token: 'good' },
      }),
    });
    await request('/v1/templates/greet', {
      method: 'PUT',
      ...json({ channel: 'sms', body: 'Hi' }),
    });
  }

  it('stamps company_id when the address is a known identifier', async () => {
    await configureMessaging();
    const created = await postCompany({
      name: 'Known Co',
      identifiers: [{ type: 'phone', value: PHONE }],
      source: { type: 'api', ref: 'a' },
    });

    const known = await request('/v1/messages', {
      method: 'POST',
      ...json({
        contact: { phone: PHONE },
        channel: 'sms',
        purpose: 'transactional',
        template: 'greet',
      }),
    });
    expect(known.status).toBe(202);
    const { message } = (await known.json()) as { message: { id: string } };

    const [row] = await db()<{ company_id: string }[]>`
      select company_id from messages where id = ${message.id}
    `;
    expect(row!.company_id).toBe(created.company.id);

    const unknown = await request('/v1/messages', {
      method: 'POST',
      ...json({
        contact: { phone: '+966555000111' },
        channel: 'sms',
        purpose: 'transactional',
        template: 'greet',
      }),
    });
    const other = (await unknown.json()) as { message: { id: string } };
    const [otherRow] = await db()<{ company_id: string | null }[]>`
      select company_id from messages where id = ${other.message.id}
    `;
    expect(otherRow!.company_id).toBeNull();
  });
});

describe('csv import', () => {
  it('creates, links and reports rejected rows', async () => {
    const csv = [
      'name,country,cr,vat,domain,phone,email,relationship,tags',
      `Alpha Co,SA,${CR},,,,,customer,vip;gold`,
      `"Beta, Limited",SA,${OTHER_CR},,,,,,`,
      `Gamma Co,SA,${CR},,,,,supplier,`,
      'Delta Co,SA,,,delta.example,,,,',
      'Epsilon Co,SA,,,,notaphone,,,',
    ].join('\r\n');

    const res = await request('/v1/companies/import?ref=file.csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csv,
    });
    expect(res.status).toBe(200);

    const summary = (await res.json()) as {
      rows: number;
      created: number;
      linked: number;
      rejected: { row: number; reason: string }[];
    };

    expect(summary.rows).toBe(5);
    // Alpha, Beta and Delta are new; Gamma shares Alpha's CR so it links.
    expect(summary.created).toBe(3);
    expect(summary.linked).toBe(1);

    // The quoted field kept its comma rather than splitting into two columns.
    const names = await db()<{ name: string }[]>`select name from companies order by name`;
    expect(names.map((n) => n.name)).toContain('Beta, Limited');

    // Epsilon offered only a phone, and it does not parse, so there is nothing
    // to match it on ever. Rejected, by the line number in the file.
    expect(summary.rejected).toEqual([{ row: 6, reason: 'not a valid phone number' }]);
  });

  it('refuses a file whose header is not the fixed one', async () => {
    const res = await request('/v1/companies/import', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: 'company,cr\nAlpha,1010',
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('header must be exactly');
  });
});

describe('lookup by identifier', () => {
  it('finds a company by a normalised identifier', async () => {
    const created = await postCompany({
      name: 'Findable Co',
      identifiers: [{ type: 'cr', value: '1010-123456' }],
      source: { type: 'api', ref: 'a' },
    });

    const res = await request(`/v1/companies?identifier=cr:${CR}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { company: { id: string } };
    expect(detail.company.id).toBe(created.company.id);

    const missing = await request('/v1/companies?identifier=cr:9999999999');
    expect(missing.status).toBe(404);
  });
});
