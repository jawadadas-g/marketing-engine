import { randomBytes } from 'node:crypto';
import { db, type Tx } from '../../db/client.js';
import { emit } from '../../spine/events/index.js';
import type { Channel } from '../../spine/contacts/normalize.js';
import { resolve, type CompanyRow } from '../../spine/registry/index.js';
import { send, type ContactInput, type MessageRow } from '../messaging/index.js';
import { activeFinder, type Candidate, type FinderQuery } from './finder/index.js';

export * from './finder/index.js';

const DEFAULT_INVITE_DAYS = 14;

export type ProfileRow = {
  company_id: string;
  buys: string[];
  sells: string[];
  sector: string | null;
  city: string | null;
  size: string | null;
  updated_at: Date;
};

export type InviteRow = {
  id: string;
  tenant_id: string;
  company_id: string;
  message_id: string | null;
  token: string;
  status: 'sent' | 'accepted' | 'expired';
  accepted_ref: string | null;
  created_at: Date;
  accepted_at: Date | null;
  expires_at: Date;
};

export type SearchResult = {
  finder: string;
  candidates: {
    company: CompanyRow;
    profile: ProfileRow | null;
    view: Record<string, unknown> | null;
    score: number;
    reasons: string[];
  }[];
};

/**
 * Run the active finder, log what was asked and what came back, then fill the
 * answer out with everything the caller needs to act on it.
 */
export async function search(
  tx: Tx,
  input: { tenantId: string; query: FinderQuery },
): Promise<SearchResult> {
  const finder = activeFinder();

  const startedAt = Date.now();
  const candidates = await finder.find(tx, input.tenantId, input.query);
  const durationMs = Date.now() - startedAt;

  await tx`
    insert into finder_runs (tenant_id, finder, query, result_count, duration_ms)
    values (${input.tenantId}, ${finder.name}, ${tx.json(input.query as never)},
            ${candidates.length}, ${durationMs})
  `;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'discovery.searched',
    subjectType: 'search',
    subjectId: finder.name,
    payload: { finder: finder.name, query: input.query, count: candidates.length },
  });

  return { finder: finder.name, candidates: await hydrate(tx, candidates) };
}

async function hydrate(tx: Tx, candidates: Candidate[]): Promise<SearchResult['candidates']> {
  const filled: SearchResult['candidates'] = [];

  for (const candidate of candidates) {
    const [company] = await tx<CompanyRow[]>`
      select * from companies where id = ${candidate.companyId}
    `;
    if (!company) continue;

    const [profile] = await tx<ProfileRow[]>`
      select * from company_profiles where company_id = ${company.id}
    `;
    // RLS keeps this to the calling tenant's own view.
    const [view] = await tx<Record<string, unknown>[]>`
      select * from tenant_company where company_id = ${company.id}
    `;

    filled.push({
      company,
      profile: profile ?? null,
      view: view ?? null,
      score: candidate.score,
      reasons: candidate.reasons,
    });
  }

  return filled;
}

/** The pool is shared, so any tenant may describe a company in it. */
export async function setProfile(
  tx: Tx,
  input: {
    tenantId: string;
    companyId: string;
    buys?: string[] | undefined;
    sells?: string[] | undefined;
    sector?: string | undefined;
    city?: string | undefined;
    size?: string | undefined;
  },
): Promise<ProfileRow> {
  const [row] = await tx<ProfileRow[]>`
    insert into company_profiles (company_id, buys, sells, sector, city, size)
    values (${input.companyId}, ${input.buys ?? []}, ${input.sells ?? []},
            ${input.sector ?? null}, ${input.city ?? null}, ${input.size ?? null})
    on conflict (company_id) do update set
      buys   = case when cardinality(excluded.buys) > 0 then excluded.buys
                    else company_profiles.buys end,
      sells  = case when cardinality(excluded.sells) > 0 then excluded.sells
                    else company_profiles.sells end,
      sector = coalesce(excluded.sector, company_profiles.sector),
      city   = coalesce(excluded.city, company_profiles.city),
      size   = coalesce(excluded.size, company_profiles.size),
      updated_at = now()
    returning *
  `;
  if (!row) throw new Error('setProfile wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'company.profiled',
    subjectType: 'company',
    subjectId: input.companyId,
    payload: { buys: row.buys, sells: row.sells, sector: row.sector, city: row.city },
  });

  return row;
}

export type InviteResult =
  | { invite: InviteRow; message: MessageRow }
  | { invite: null; message: MessageRow };

/**
 * An invite is not a special kind of message. It is a transactional message
 * carrying a token, sent through the same door as everything else — so consent
 * and the sending rules apply to it exactly as they do to anything else.
 */
export async function invite(
  tx: Tx,
  input: {
    tenantId: string;
    companyId: string;
    contact: ContactInput;
    channel?: Channel | undefined;
    template: string;
    variables?: Record<string, unknown> | undefined;
    defaultCountry?: string | undefined;
    expiresInDays?: number | undefined;
  },
): Promise<InviteResult> {
  const token = randomBytes(32).toString('base64url');
  const base = (process.env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');

  const message = await send(tx, {
    tenantId: input.tenantId,
    contact: input.contact,
    ...(input.channel ? { channel: input.channel } : {}),
    purpose: 'transactional',
    template: input.template,
    variables: { ...(input.variables ?? {}), invite_url: `${base}/i/${token}` },
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  // can_send refused, so nothing was sent and there is nothing to accept.
  if (message.status === 'blocked') return { invite: null, message };

  const days = input.expiresInDays ?? DEFAULT_INVITE_DAYS;
  const [row] = await tx<InviteRow[]>`
    insert into invites (tenant_id, company_id, message_id, token, status, expires_at)
    values (${input.tenantId}, ${input.companyId}, ${message.id}, ${token}, 'sent',
            now() + (${days} || ' days')::interval)
    returning *
  `;
  if (!row) throw new Error('invite wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'invite.sent',
    subjectType: 'invite',
    subjectId: row.id,
    payload: { companyId: input.companyId, messageId: message.id, expiresAt: row.expires_at },
  });

  return { invite: row, message };
}

/** An invite the public redirect may act on: still open, not yet expired. */
export async function openInvite(token: string): Promise<InviteRow | undefined> {
  const [row] = await db()<InviteRow[]>`
    select * from invites
    where token = ${token} and status = 'sent' and expires_at > now()
  `;
  return row;
}

export type AcceptResult =
  | { ok: true; companyId: string; tenantId: string }
  | { ok: false; reason: 'not_found' | 'already_accepted' | 'expired' };

/**
 * The marketplace reporting a signup. Runs as the owning role: this call comes
 * from the marketplace with its own key, not from a tenant with a JWT, and it
 * writes the company's on-platform reference, which is pool-wide.
 */
export async function acceptInvite(input: {
  token: string;
  ref: string;
}): Promise<AcceptResult> {
  return db().begin(async (tx) => {
    const [row] = await tx<InviteRow[]>`
      select * from invites where token = ${input.token} for update
    `;
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.status === 'accepted') return { ok: false, reason: 'already_accepted' };
    if (row.status === 'expired' || row.expires_at.getTime() <= Date.now()) {
      return { ok: false, reason: 'expired' };
    }

    await tx`
      update invites set status = 'accepted', accepted_ref = ${input.ref}, accepted_at = now()
      where id = ${row.id}
    `;

    // The company is on the marketplace now: it stays in the pool, and
    // discovery stops suggesting it.
    await tx`
      update companies set on_platform_ref = ${input.ref}, on_platform_at = now(), updated_at = now()
      where id = ${row.company_id}
    `;

    // Nobody else needs to invite a company that has already joined.
    await tx`
      update invites set status = 'expired'
      where company_id = ${row.company_id} and id <> ${row.id} and status = 'sent'
    `;

    await emit(tx, {
      tenantId: row.tenant_id,
      type: 'invite.accepted',
      subjectType: 'invite',
      subjectId: row.id,
      payload: { companyId: row.company_id, ref: input.ref },
    });

    return { ok: true, companyId: row.company_id, tenantId: row.tenant_id };
  }) as Promise<AcceptResult>;
}

/** Follows a merge, so an invite still works after its company was merged away. */
export async function companyForInvite(tx: Tx, companyId: string): Promise<CompanyRow | undefined> {
  return resolve(tx, companyId);
}
