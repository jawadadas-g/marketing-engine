import type { Tx } from '../../db/client.js';
import type { Channel, Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { findCompanyIds, type FinderQuery } from '../discovery/index.js';
import { configuredChannels, preflight } from '../messaging/index.js';
import { contactInput, upsertContact, type ContactFields, type ContactRow } from './contacts.js';
import { CampaignError } from './errors.js';

/**
 * The most contacts one audience resolves to. A run snapshots every one of
 * them, so this is also the largest campaign run. A number to revisit.
 */
export const MAX_AUDIENCE = 100_000;

/** How many companies a search audience asks the finder for. */
export const MAX_SEARCH_COMPANIES = 10_000;

export type ContactFilter = {
  /** The contact has an address for at least one of these. */
  hasChannel?: Channel[] | undefined;
  /** The contact's `attributes.tags` holds at least one of these. */
  tags?: string[] | undefined;
  companyIds?: string[] | undefined;
};

export type SearchDefinition = {
  finderQuery: Omit<FinderQuery, 'limit'> & { limit?: number | undefined };
  contactFilter?: ContactFilter | undefined;
};

export type AudienceRow = {
  id: string;
  tenant_id: string;
  name: string;
  kind: 'static' | 'search';
  definition: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

export async function createAudience(
  tx: Tx,
  input: {
    tenantId: string;
    name: string;
    kind: 'static' | 'search';
    definition?: SearchDefinition | undefined;
  },
): Promise<AudienceRow> {
  if (input.kind === 'search' && !input.definition) {
    throw new CampaignError('definition_required', 400, 'a search audience needs a definition');
  }

  let row: AudienceRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<AudienceRow[]>`
        insert into audiences (tenant_id, name, kind, definition)
        values (${input.tenantId}, ${input.name}, ${input.kind},
                ${sp.json((input.kind === 'search' ? input.definition : {}) as never)})
        returning *
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new CampaignError('audience_exists', 409, `an audience named ${input.name} already exists`);
    }
    throw err;
  }
  if (!row) throw new Error('createAudience wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.saved',
    subjectType: 'audience',
    subjectId: row.id,
    payload: { name: row.name, kind: row.kind, created: true },
  });
  return row;
}

export async function getAudience(tx: Tx, id: string): Promise<AudienceRow | undefined> {
  const [row] = await tx<AudienceRow[]>`select * from audiences where id = ${id}`;
  return row;
}

export async function listAudiences(tx: Tx): Promise<(AudienceRow & { members: number | null })[]> {
  return tx<(AudienceRow & { members: number | null })[]>`
    select a.*,
           case when a.kind = 'static'
                then (select count(*)::int from audience_members m where m.audience_id = a.id)
           end as members
    from audiences a
    order by a.created_at desc, a.id desc
  `;
}

export async function memberCount(tx: Tx, audienceId: string): Promise<number> {
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n from audience_members where audience_id = ${audienceId}
  `;
  return row?.n ?? 0;
}

export async function patchAudience(
  tx: Tx,
  input: { tenantId: string; id: string; name?: string | undefined; definition?: SearchDefinition | undefined },
): Promise<AudienceRow | undefined> {
  const existing = await getAudience(tx, input.id);
  if (!existing) return undefined;
  if (input.definition && existing.kind !== 'search') {
    throw new CampaignError('not_search', 400, 'only a search audience has a definition');
  }

  let row: AudienceRow | undefined;
  try {
    [row] = await tx.savepoint(
      (sp) => sp<AudienceRow[]>`
        update audiences set
          name       = ${input.name ?? existing.name},
          definition = ${sp.json((input.definition ?? existing.definition) as never)},
          updated_at = now()
        where id = ${input.id}
        returning *
      `,
    );
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new CampaignError('audience_exists', 409, `an audience named ${input.name} already exists`);
    }
    throw err;
  }

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.saved',
    subjectType: 'audience',
    subjectId: input.id,
    payload: { name: row!.name, kind: row!.kind, created: false },
  });
  return row;
}

/** An audience a campaign points at stays: the campaign's history refers to it. */
export async function deleteAudience(tx: Tx, input: { tenantId: string; id: string }): Promise<boolean> {
  const [used] = await tx<{ id: string }[]>`
    select id from campaigns where audience_id = ${input.id} limit 1
  `;
  if (used) {
    throw new CampaignError('audience_in_use', 409, 'a campaign uses this audience');
  }

  const deleted = await tx`delete from audiences where id = ${input.id}`;
  if (deleted.count === 0) return false;

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'audience.deleted',
    subjectType: 'audience',
    subjectId: input.id,
  });
  return true;
}

async function staticAudience(tx: Tx, id: string): Promise<AudienceRow> {
  const audience = await getAudience(tx, id);
  if (!audience) throw new CampaignError('not_found', 404, 'audience not found');
  if (audience.kind !== 'static') {
    throw new CampaignError('not_static', 400, 'members belong to static audiences only');
  }
  return audience;
}

/** Add stored contacts by id. Ids this tenant does not have are reported, not added. */
export async function addMembers(
  tx: Tx,
  input: { audienceId: string; contactIds: string[] },
): Promise<{ added: number; unknown: string[] }> {
  await staticAudience(tx, input.audienceId);

  const known = await tx<{ id: string }[]>`
    select id from contacts where id = any(${input.contactIds}::uuid[])
  `;
  const knownIds = new Set(known.map((k) => k.id));

  const inserted = knownIds.size
    ? await tx`
        insert into audience_members (audience_id, contact_id)
        select ${input.audienceId}, unnest(${[...knownIds]}::uuid[])
        on conflict do nothing
      `
    : { count: 0 };

  return { added: inserted.count, unknown: input.contactIds.filter((id) => !knownIds.has(id)) };
}

/**
 * Add members by address. Each row is upserted as a contact first, so an
 * address nobody has stored yet becomes a contact, with no consent.
 */
export async function addMembersByAddress(
  tx: Tx,
  input: { tenantId: string; audienceId: string; rows: ContactFields[] },
): Promise<{ added: number; contactsCreated: number; rejected: { row: number; reason: string }[] }> {
  await staticAudience(tx, input.audienceId);

  const ids: string[] = [];
  let contactsCreated = 0;
  const rejected: { row: number; reason: string }[] = [];

  for (const [index, fields] of input.rows.entries()) {
    try {
      const { contact, created } = await tx.savepoint((sp) =>
        upsertContact(sp, { tenantId: input.tenantId, ...fields }),
      );
      ids.push(contact.id);
      if (created) contactsCreated += 1;
    } catch (err) {
      const reason = err instanceof CampaignError ? err.code : (err as Error).message;
      rejected.push({ row: index + 2, reason });
    }
  }

  const { added } = await addMembers(tx, { audienceId: input.audienceId, contactIds: ids });
  return { added, contactsCreated, rejected };
}

export async function removeMember(
  tx: Tx,
  input: { audienceId: string; contactId: string },
): Promise<boolean> {
  await staticAudience(tx, input.audienceId);
  const deleted = await tx`
    delete from audience_members
    where audience_id = ${input.audienceId} and contact_id = ${input.contactId}
  `;
  return deleted.count > 0;
}

/**
 * Who this audience means right now, as contact ids in id order. The order is
 * the point: a run that expands the same audience twice gets the same list.
 *
 * A search audience runs the finder, takes the companies it returns, and then
 * this tenant's contacts linked to them.
 */
export async function resolveAudience(
  tx: Tx,
  audience: AudienceRow,
  input: { limit: number },
): Promise<string[]> {
  if (audience.kind === 'static') {
    const rows = await tx<{ contact_id: string }[]>`
      select contact_id from audience_members
      where audience_id = ${audience.id}
      order by contact_id
      limit ${input.limit}
    `;
    return rows.map((r) => r.contact_id);
  }

  const definition = audience.definition as SearchDefinition;
  const companies = await findCompanyIds(tx, {
    tenantId: audience.tenant_id,
    query: {
      ...definition.finderQuery,
      limit: Math.min(definition.finderQuery.limit ?? MAX_SEARCH_COMPANIES, MAX_SEARCH_COMPANIES),
    },
  });
  if (companies.length === 0) return [];

  const filter = definition.contactFilter ?? {};
  const channels = filter.hasChannel ?? [];
  const wantsPhone = channels.includes('sms') || channels.includes('whatsapp');
  const wantsEmail = channels.includes('email');
  const wantsTelegram = channels.includes('telegram');

  const rows = await tx<{ id: string }[]>`
    select id from contacts
    where tenant_id = ${audience.tenant_id}
      and company_id = any(${companies}::uuid[])
      ${filter.companyIds?.length ? tx`and company_id = any(${filter.companyIds}::uuid[])` : tx``}
      ${filter.tags?.length ? tx`and attributes -> 'tags' ?| ${filter.tags}::text[]` : tx``}
      ${
        channels.length
          ? tx`and (
              (${wantsPhone} and phone is not null)
              or (${wantsEmail} and email is not null)
              or (${wantsTelegram} and telegram is not null)
            )`
          : tx``
      }
    order by id
    limit ${input.limit}
  `;
  return rows.map((r) => r.id);
}

export type PreviewContact = {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  telegram: string | null;
  allowed: boolean;
  channel: Channel | null;
  reason: string | null;
};

/**
 * The honest answer to "who will actually get this": the first `limit`
 * contacts the audience resolves to, each with the verdict send() would give
 * it for this purpose, and the size of the whole audience.
 */
export async function previewAudience(
  tx: Tx,
  input: {
    tenantId: string;
    audienceId: string;
    limit: number;
    purpose: Purpose;
    channel?: Channel | undefined;
    at?: Date | undefined;
  },
): Promise<{ total: number; sampled: number; sendable: number; contacts: PreviewContact[] }> {
  const audience = await getAudience(tx, input.audienceId);
  if (!audience) throw new CampaignError('not_found', 404, 'audience not found');

  const ids = await resolveAudience(tx, audience, { limit: MAX_AUDIENCE });
  const sample = ids.slice(0, input.limit);
  const rows = await tx<ContactRow[]>`
    select * from contacts where id = any(${sample}::uuid[]) order by id
  `;

  const contacts: PreviewContact[] = [];
  for (const contact of rows) {
    const verdict = await preflight(tx, {
      tenantId: input.tenantId,
      contact: contactInput(contact),
      purpose: input.purpose,
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.at ? { at: input.at } : {}),
    });
    contacts.push({
      id: contact.id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      telegram: contact.telegram,
      allowed: verdict.allowed,
      channel: verdict.allowed ? verdict.channel : null,
      reason: verdict.allowed ? null : verdict.reason,
    });
  }

  return {
    total: ids.length,
    sampled: contacts.length,
    sendable: contacts.filter((c) => c.allowed).length,
    contacts,
  };
}

/**
 * Is anyone in this audience sendable? Stops at the first who is, so an
 * audience with somebody reachable near the front answers at once.
 *
 * Someone held back only by a sending window counts: a campaign defers them
 * until the window opens rather than dropping them.
 */
export async function anySendable(
  tx: Tx,
  input: {
    tenantId: string;
    audience: AudienceRow;
    purpose: Purpose;
    channel?: Channel | undefined;
    at?: Date | undefined;
  },
): Promise<boolean> {
  if ((await configuredChannels(tx, input.tenantId)).length === 0) return false;

  const ids = await resolveAudience(tx, input.audience, { limit: MAX_AUDIENCE });
  for (let start = 0; start < ids.length; start += 500) {
    const rows = await tx<ContactRow[]>`
      select * from contacts where id = any(${ids.slice(start, start + 500)}::uuid[]) order by id
    `;
    for (const contact of rows) {
      const verdict = await preflight(tx, {
        tenantId: input.tenantId,
        contact: contactInput(contact),
        purpose: input.purpose,
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.at ? { at: input.at } : {}),
      });
      if (verdict.allowed || verdict.window) return true;
    }
  }
  return false;
}
