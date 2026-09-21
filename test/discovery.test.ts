import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app.js';
import { db, withTenant } from '../src/db/client.js';
import { resetFake } from '../src/modules/messaging/adapters/fake.js';
import { registerFinder, type Finder } from '../src/modules/discovery/index.js';
import { setCompanyLookup } from '../src/spine/registry/index.js';
import { resetEnv } from '../src/env.js';
import { TENANT_A, TENANT_B, resetDb, startQueue, teardownDb, tokenFor } from './helpers.js';

const app = createApp();

const PHONE = '+966501234567';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN!;
const SIGNUP_URL = process.env.MARKETPLACE_SIGNUP_URL!;

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
      redirect: 'manual',
    }),
  );
}

const json = (body: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type Company = { id: string; name: string };

async function addCompany(
  name: string,
  profile: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<Company> {
  const res = await request('/v1/companies', {
    method: 'POST',
    ...json({
      name,
      country: 'SA',
      identifiers: [],
      source: { type: 'api', ref: name },
      ...extra,
    }),
  });
  expect(res.status).toBe(201);
  const { company } = (await res.json()) as { company: Company };

  if (Object.keys(profile).length) {
    const p = await request(`/v1/companies/${company.id}/profile`, {
      method: 'PUT',
      ...json(profile),
    });
    expect(p.status).toBe(200);
  }
  return company;
}

type SearchResult = {
  finder: string;
  finderRunId: number;
  candidates: { company: Company; score: number; reasons: string[] }[];
};

async function search(query: Record<string, unknown>, token = tokenA): Promise<SearchResult> {
  const res = await request('/v1/discovery/search', { method: 'POST', ...json(query) }, token);
  expect(res.status).toBe(200);
  return (await res.json()) as SearchResult;
}

/** Proves the swap: a different algorithm, the same endpoint. */
let pinned = '';
const fixedFinder: Finder = {
  name: 'test',
  async find() {
    return [{ companyId: pinned, score: 0.42, reasons: ['because the test said so'] }];
  },
};

beforeAll(async () => {
  await resetDb();
  await startQueue();
  registerFinder(fixedFinder);
  tokenA = await tokenFor(TENANT_A);
  tokenB = await tokenFor(TENANT_B);
});

afterAll(async () => {
  process.env.FINDER = 'basic';
  resetEnv();
  setCompanyLookup(undefined);
  await teardownDb();
});

beforeEach(async () => {
  await resetDb();
  resetFake();
  setCompanyLookup(null);
  process.env.FINDER = 'basic';
  resetEnv();
});

describe('search', () => {
  async function threeCompanies() {
    return {
      riyadhDiesel: await addCompany('Riyadh Diesel Buyer', { buys: ['diesel'], city: 'Riyadh' }),
      jeddahDiesel: await addCompany('Jeddah Diesel Buyer', { buys: ['diesel'], city: 'Jeddah' }),
      riyadhLpg: await addCompany('Riyadh LPG Buyer', { buys: ['lpg'], city: 'Riyadh' }),
    };
  }

  it('narrows by category and city, and logs every run', async () => {
    const { riyadhDiesel } = await threeCompanies();

    const narrow = await search({ buys: ['diesel'], city: 'Riyadh' });
    expect(narrow.finder).toBe('basic');
    expect(narrow.candidates).toHaveLength(1);
    expect(narrow.candidates[0]!.company.id).toBe(riyadhDiesel.id);
    expect(narrow.candidates[0]!.score).toBe(1);
    expect(narrow.candidates[0]!.reasons).toEqual(['buys: diesel', 'city: Riyadh']);

    const wide = await search({ buys: ['diesel'] });
    expect(wide.candidates).toHaveLength(2);

    const runs = await withTenant(
      TENANT_A,
      (tx) => tx<{ finder: string; result_count: number }[]>`
        select finder, result_count from finder_runs order by id
      `,
    );
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.finder === 'basic')).toBe(true);
    expect(runs.map((r) => r.result_count)).toEqual([1, 2]);
  });

  it('never returns a company already on the marketplace or merged away', async () => {
    const onPlatform = await addCompany('Joined Already', { buys: ['diesel'], city: 'Riyadh' });
    const loser = await addCompany('Merged Away', { buys: ['diesel'], city: 'Riyadh' });
    const survivor = await addCompany('Survivor', { buys: ['diesel'], city: 'Riyadh' });

    await db()`
      update companies set on_platform_ref = 'mkt-1', on_platform_at = now()
      where id = ${onPlatform.id}
    `;
    await db()`update companies set merged_into = ${survivor.id} where id = ${loser.id}`;

    const result = await search({ buys: ['diesel'], city: 'Riyadh' });
    expect(result.candidates.map((c) => c.company.id)).toEqual([survivor.id]);
  });

  it('matches Arabic free text by trigram', async () => {
    const falah = await addCompany('شركة الفلاح للتجارة', { buys: ['diesel'] });
    await addCompany('شركة النور', { buys: ['diesel'] });

    const result = await search({ text: 'الفلاح' });
    expect(result.candidates.map((c) => c.company.id)).toEqual([falah.id]);
  });

  it('honours limit', async () => {
    await threeCompanies();
    const result = await search({ limit: 1 });
    expect(result.candidates).toHaveLength(1);
  });

  it('runs whichever finder FINDER names', async () => {
    const { riyadhLpg } = await threeCompanies();
    pinned = riyadhLpg.id;

    process.env.FINDER = 'test';
    resetEnv();
    const result = await search({ buys: ['diesel'], city: 'Riyadh' });

    expect(result.finder).toBe('test');
    // The basic finder would never return an LPG buyer for this query.
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.company.id).toBe(riyadhLpg.id);
    expect(result.candidates[0]!.score).toBe(0.42);

    const [run] = await withTenant(
      TENANT_A,
      (tx) => tx<{ finder: string }[]>`select finder from finder_runs order by id desc limit 1`,
    );
    expect(run!.finder).toBe('test');
  });
});

describe('invites', () => {
  async function configureMessaging(token = tokenA) {
    await request(
      '/v1/channels/sms',
      {
        method: 'PUT',
        ...json({ provider: 'fake', sender: 'ACME', config: { token: 'good' } }),
      },
      token,
    );
    await request(
      '/v1/templates/invite',
      { method: 'PUT', ...json({ channel: 'sms', body: 'Join us: {{ invite_url }}' }) },
      token,
    );
  }

  type InviteResponse = {
    invite: { id: string; token: string; status: string } | null;
    message: { id: string; status: string; body: string };
  };

  async function sendInvite(companyId: string, phone = PHONE): Promise<InviteResponse> {
    const res = await request(`/v1/companies/${companyId}/invite`, {
      method: 'POST',
      ...json({ contact: { phone }, channel: 'sms', template: 'invite' }),
    });
    return (await res.json()) as InviteResponse;
  }

  it('sends, redirects, accepts, and drops the company out of search', async () => {
    await configureMessaging();
    const company = await addCompany('Invitee Co', { buys: ['diesel'], city: 'Riyadh' });

    // Invite from a search result, so the run can be judged by its outcome.
    const found = await search({ buys: ['diesel'], city: 'Riyadh' });
    const inviteRes = await request(`/v1/companies/${company.id}/invite`, {
      method: 'POST',
      ...json({
        contact: { phone: PHONE },
        channel: 'sms',
        template: 'invite',
        finderRunId: found.finderRunId,
      }),
    });
    const { invite, message } = (await inviteRes.json()) as InviteResponse;

    const [linked] = await db()<{ finder_run_id: string }[]>`
      select finder_run_id from invites where id = ${invite!.id}
    `;
    expect(Number(linked!.finder_run_id)).toBe(found.finderRunId);
    expect(invite!.status).toBe('sent');
    expect(message.status).toBe('queued');
    expect(message.body).toContain(`/i/${invite!.token}`);

    const events = await withTenant(
      TENANT_A,
      (tx) => tx`select id from events where type = 'invite.sent'`,
    );
    expect(events).toHaveLength(1);

    // The invitee follows the link.
    const redirect = await request(`/i/${invite!.token}`, {}, null);
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(
      `${SIGNUP_URL}?invite=${encodeURIComponent(invite!.token)}`,
    );

    // The marketplace reports the signup.
    const accept = () =>
      request(
        '/internal/invites/accept',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
          body: JSON.stringify({ token: invite!.token, ref: 'mkt-42' }),
        },
        null,
      );

    const accepted = await accept();
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ companyId: company.id, tenantId: TENANT_A });

    const [row] = await db()<{ on_platform_ref: string }[]>`
      select on_platform_ref from companies where id = ${company.id}
    `;
    expect(row!.on_platform_ref).toBe('mkt-42');

    const [inviteRow] = await db()<{ status: string }[]>`
      select status from invites where id = ${invite!.id}
    `;
    expect(inviteRow!.status).toBe('accepted');

    const acceptedEvents = await withTenant(
      TENANT_A,
      (tx) => tx`select id from events where type = 'invite.accepted'`,
    );
    expect(acceptedEvents).toHaveLength(1);

    // A second accept is a conflict, not a silent no-op.
    expect((await accept()).status).toBe(409);

    // And the company is no longer a prospect.
    const result = await search({ buys: ['diesel'], city: 'Riyadh' });
    expect(result.candidates).toHaveLength(0);
  });

  it('refuses the accept callback without the internal token', async () => {
    await configureMessaging();
    const company = await addCompany('Invitee Co', {});
    const { invite } = await sendInvite(company.id);

    const res = await request(
      '/internal/invites/accept',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': 'wrong' },
        body: JSON.stringify({ token: invite!.token, ref: 'mkt-1' }),
      },
      null,
    );
    expect(res.status).toBe(401);

    const [row] = await db()<{ status: string }[]>`
      select status from invites where id = ${invite!.id}
    `;
    expect(row!.status).toBe('sent');
  });

  it('writes no invite when can_send refuses', async () => {
    await configureMessaging();
    const company = await addCompany('Suppressed Co', {});

    await request('/v1/suppression', {
      method: 'POST',
      ...json({ channel: 'sms', address: PHONE, reason: 'complaint' }),
    });

    const res = await request(`/v1/companies/${company.id}/invite`, {
      method: 'POST',
      ...json({ contact: { phone: PHONE }, channel: 'sms', template: 'invite' }),
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as InviteResponse;
    expect(body.invite).toBeNull();
    expect(body.message.status).toBe('blocked');

    const invites = await db()`select id from invites`;
    expect(invites).toHaveLength(0);
  });

  it('will not act on an expired invite', async () => {
    await configureMessaging();
    const company = await addCompany('Late Co', {});
    const { invite } = await sendInvite(company.id);

    await db()`update invites set expires_at = now() - interval '1 day' where id = ${invite!.id}`;

    const redirect = await request(`/i/${invite!.token}`, {}, null);
    expect(redirect.status).toBe(410);

    const accept = await request(
      '/internal/invites/accept',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN },
        body: JSON.stringify({ token: invite!.token, ref: 'mkt-1' }),
      },
      null,
    );
    expect(accept.status).toBe(409);
    expect(await accept.json()).toMatchObject({ error: 'expired' });
  });
});

describe('tenant isolation', () => {
  it("keeps tenant A's invites and finder runs away from tenant B", async () => {
    await request('/v1/channels/sms', {
      method: 'PUT',
      ...json({ provider: 'fake', sender: 'ACME', config: { token: 'good' } }),
    });
    await request('/v1/templates/invite', {
      method: 'PUT',
      ...json({ channel: 'sms', body: 'Join us: {{ invite_url }}' }),
    });

    const company = await addCompany('Shared Prospect', { buys: ['diesel'] });
    await search({ buys: ['diesel'] });

    const res = await request(`/v1/companies/${company.id}/invite`, {
      method: 'POST',
      ...json({ contact: { phone: PHONE }, channel: 'sms', template: 'invite' }),
    });
    const { invite } = (await res.json()) as { invite: { id: string } };

    const forB = await request(`/v1/invites/${invite.id}`, {}, tokenB);
    expect(forB.status).toBe(404);

    const invitesForB = await withTenant(TENANT_B, (tx) => tx`select id from invites`);
    const runsForB = await withTenant(TENANT_B, (tx) => tx`select id from finder_runs`);
    expect(invitesForB).toHaveLength(0);
    expect(runsForB).toHaveLength(0);
  });
});

describe('csv import with profiles', () => {
  it('fills profiles from the optional columns', async () => {
    const csv = [
      'name,country,cr,vat,domain,phone,email,relationship,tags,buys,sells,sector,city',
      'Profiled Co,SA,1010999111,,,,,prospect,,diesel;lpg,,energy,Riyadh',
    ].join('\n');

    const res = await request('/v1/companies/import?ref=profiles.csv', {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv' },
      body: csv,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rows: 1, created: 1 });

    const [profile] = await db()<
      { buys: string[]; sector: string; city: string }[]
    >`select buys, sector, city from company_profiles`;
    expect(profile!.buys).toEqual(['diesel', 'lpg']);
    expect(profile!.sector).toBe('energy');
    expect(profile!.city).toBe('Riyadh');

    const found = await search({ buys: ['diesel'], city: 'Riyadh' });
    expect(found.candidates).toHaveLength(1);
  });
});
