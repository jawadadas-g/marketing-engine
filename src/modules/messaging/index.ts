import type { Tx } from '../../db/client.js';
import { normalize, type Channel, type Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { decrypt, encrypt } from '../../spine/secrets.js';
import { enqueue } from '../../jobs/index.js';
import { adapterFor, type ProviderConfig } from './adapters/index.js';
import { MessagingError } from './errors.js';
import { findByIdentifier } from '../../spine/registry/index.js';
import { addressFor, selectChannel, type ContactInput } from './selection.js';
import { assertParses, render } from './templates.js';

export type { ContactInput } from './selection.js';
export { addressFor } from './selection.js';

export const SEND_JOB = 'message.send';

/** Three provider attempts before a message is failed and falls back. */
export const SEND_RETRY_LIMIT = 3;

export type ChannelConfigRow = {
  id: string;
  tenant_id: string;
  channel: string;
  provider: string;
  sender: string;
  unsubscribe_text: string | null;
  config_ciphertext: Buffer;
  config_iv: Buffer;
  config_tag: Buffer;
  created_at: Date;
  updated_at: Date;
};

export type MessageRow = {
  id: string;
  tenant_id: string;
  channel: string;
  address: string;
  region: string | null;
  purpose: string;
  template_name: string;
  body: string;
  provider: string | null;
  provider_message_id: string | null;
  status: 'blocked' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';
  blocked_reason: string | null;
  error: string | null;
  contact: ContactInput;
  variables: Record<string, unknown>;
  fallback_channels: string[];
  parent_message_id: string | null;
  company_id: string | null;
  created_at: Date;
  updated_at: Date;
};

/** What a channel config looks like from outside. Never the credentials. */
export function redactConfig(row: ChannelConfigRow) {
  return {
    channel: row.channel,
    provider: row.provider,
    sender: row.sender,
    unsubscribeText: row.unsubscribe_text,
    configured: true,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Ask the provider whether these credentials work. Deliberately separate from
 * storing them: this makes an HTTP call, and no database transaction should be
 * held open across a round trip to someone else's API.
 */
export async function validateChannelConfig(input: {
  channel: Channel;
  provider: string;
  sender: string;
  config: ProviderConfig;
}): Promise<void> {
  const adapter = adapterFor(input.provider, input.channel);
  if (!adapter) {
    throw new MessagingError('unknown_provider', 422, `no adapter for provider ${input.provider}`);
  }
  const check = await adapter.validateCredentials(input.config, input.sender);
  if (!check.ok) throw new MessagingError('credentials_rejected', 422, check.reason);
}

/** Store credentials that validateChannelConfig has already accepted. */
export async function storeChannelConfig(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    provider: string;
    sender: string;
    unsubscribeText?: string | undefined;
    config: ProviderConfig;
  },
): Promise<ChannelConfigRow> {
  const sealed = encrypt(input.config);

  const [row] = await tx<ChannelConfigRow[]>`
    insert into tenant_channel_configs
      (tenant_id, channel, provider, sender, unsubscribe_text,
       config_ciphertext, config_iv, config_tag)
    values (${input.tenantId}, ${input.channel}, ${input.provider}, ${input.sender},
            ${input.unsubscribeText ?? null},
            ${sealed.ciphertext}, ${sealed.iv}, ${sealed.tag})
    on conflict (tenant_id, channel) do update set
      provider          = excluded.provider,
      sender            = excluded.sender,
      unsubscribe_text  = excluded.unsubscribe_text,
      config_ciphertext = excluded.config_ciphertext,
      config_iv         = excluded.config_iv,
      config_tag        = excluded.config_tag,
      updated_at        = now()
    returning *
  `;
  if (!row) throw new Error('storeChannelConfig wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'channel.configured',
    subjectType: 'channel',
    subjectId: input.channel,
    payload: { provider: input.provider, sender: input.sender },
  });

  return row;
}

export async function getChannelConfig(
  tx: Tx,
  tenantId: string,
  channel: string,
): Promise<ChannelConfigRow | undefined> {
  const [row] = await tx<ChannelConfigRow[]>`
    select * from tenant_channel_configs
    where tenant_id = ${tenantId} and channel = ${channel}
  `;
  return row;
}

export async function listChannelConfigs(
  tx: Tx,
  tenantId: string,
): Promise<Map<Channel, ChannelConfigRow>> {
  const rows = await tx<ChannelConfigRow[]>`
    select * from tenant_channel_configs where tenant_id = ${tenantId}
  `;
  return new Map(rows.map((r) => [r.channel as Channel, r]));
}

export type TemplateRow = {
  id: string;
  tenant_id: string;
  name: string;
  channel: string;
  body: string;
  subject: string | null;
  provider_ref: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

export async function upsertTemplate(
  tx: Tx,
  input: {
    tenantId: string;
    name: string;
    channel: Channel;
    body: string;
    subject?: string | undefined;
    providerRef?: Record<string, unknown> | undefined;
  },
): Promise<TemplateRow> {
  assertParses(input.body);

  if (input.subject) assertParses(input.subject);

  const [row] = await tx<TemplateRow[]>`
    insert into templates (tenant_id, name, channel, body, subject, provider_ref)
    values (${input.tenantId}, ${input.name}, ${input.channel}, ${input.body},
            ${input.subject ?? null},
            ${input.providerRef ? tx.json(input.providerRef as never) : null})
    on conflict (tenant_id, name, channel) do update set
      body         = excluded.body,
      subject      = excluded.subject,
      provider_ref = excluded.provider_ref,
      updated_at   = now()
    returning *
  `;
  if (!row) throw new Error('upsertTemplate wrote no row');

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'template.saved',
    subjectType: 'template',
    subjectId: input.name,
    payload: { channel: input.channel },
  });

  return row;
}

/**
 * The send intent. Picks a channel, runs can_send, renders, queues. Never talks
 * to a provider: that is the worker's job, after this has committed.
 *
 * Every query scopes by tenant explicitly rather than leaning on RLS, because
 * this also runs from the send worker's fallback path.
 */
export async function send(
  tx: Tx,
  input: {
    tenantId: string;
    contact: ContactInput;
    /** Omit to let the rules pick. */
    channel?: Channel | undefined;
    purpose: Purpose;
    template: string;
    variables?: Record<string, unknown> | undefined;
    defaultCountry?: string | undefined;
    at?: Date | undefined;
    parentMessageId?: string | undefined;
    /** Set by the fallback path; otherwise selection works it out. */
    fallbackChannels?: Channel[] | undefined;
  },
): Promise<MessageRow> {
  const configs = await listChannelConfigs(tx, input.tenantId);

  if (input.channel) {
    if (!addressFor(input.contact, input.channel)) {
      throw new MessagingError(
        'address_missing',
        400,
        `the contact has no address for channel ${input.channel}`,
      );
    }
    if (!configs.has(input.channel)) {
      throw new MessagingError(
        'channel_not_configured',
        409,
        `no provider configured for channel ${input.channel}`,
      );
    }
  }

  const selection = await selectChannel(tx, {
    tenantId: input.tenantId,
    contact: input.contact,
    purpose: input.purpose,
    configuredChannels: new Set(configs.keys()),
    ...(input.channel ? { preferred: input.channel } : {}),
    ...(input.at ? { at: input.at } : {}),
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  if (!selection.chosen) {
    const row = await insertMessage(tx, {
      ...input,
      channel: input.channel ?? 'sms',
      address: input.channel ? (addressFor(input.contact, input.channel) ?? '') : '',
      region: null,
      body: '',
      status: 'blocked',
      blockedReason: 'no_channel',
      fallbackChannels: [],
    });
    await emit(tx, {
      tenantId: input.tenantId,
      type: 'message.blocked',
      subjectType: 'message',
      subjectId: row.id,
      payload: { reason: 'no_channel', purpose: input.purpose, channels: selection.reasons },
    });
    return row;
  }

  const { channel, address } = selection.chosen;
  const config = configs.get(channel)!;
  const contact = normalize({
    channel,
    address,
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  const [template] = await tx<TemplateRow[]>`
    select * from templates
    where tenant_id = ${input.tenantId} and name = ${input.template} and channel = ${channel}
  `;
  if (!template) {
    throw new MessagingError(
      'template_not_found',
      404,
      `no template named ${input.template} for channel ${channel}`,
    );
  }

  const fallback = input.fallbackChannels ?? selection.fallback;
  const rendered = await renderFor(channel, template, {
    ...(input.variables ?? {}),
    contact: { address: contact.address },
  });

  let body = rendered.body;
  if (input.purpose === 'marketing' && channel !== 'email') {
    // Email carries its opt-out in the List-Unsubscribe header instead.
    const unsubscribe = config.unsubscribe_text?.trim();
    if (!unsubscribe) {
      throw new MessagingError(
        'unsubscribe_text_required',
        422,
        `channel ${channel} has no unsubscribe_text, which marketing messages require`,
      );
    }
    body = `${body}\n${unsubscribe}`;
  }

  // Which company this went to, if the address is one we know. One indexed
  // lookup on a unique key; a miss is normal and costs nothing.
  const company = await companyForAddress(tx, channel, contact.address);

  const row = await insertMessage(tx, {
    ...input,
    channel,
    address: contact.address,
    region: contact.region,
    body,
    status: 'queued',
    fallbackChannels: fallback,
    ...(company ? { companyId: company } : {}),
  });

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'message.queued',
    subjectType: 'message',
    subjectId: row.id,
    payload: {
      channel,
      purpose: input.purpose,
      provider: config.provider,
      fallbackChannels: fallback,
    },
  });

  await enqueue(tx, SEND_JOB, { messageId: row.id }, {
    retryLimit: SEND_RETRY_LIMIT,
    retryBackoff: true,
  });

  return row;
}

/** A template is unfit when the channel needs a piece the template has not got. */
export async function renderFor(
  channel: Channel,
  template: TemplateRow,
  variables: Record<string, unknown>,
): Promise<{ body: string; subject?: string }> {
  if (channel === 'email' && !template.subject) {
    throw new MessagingError(
      'template_unfit',
      422,
      `template ${template.name} has no subject, which email requires`,
    );
  }
  if (channel === 'whatsapp' && !template.provider_ref) {
    throw new MessagingError(
      'template_unfit',
      422,
      `template ${template.name} has no provider_ref, which whatsapp requires`,
    );
  }

  const body = await render(template.body, variables);
  if (!template.subject) return { body };
  return { body, subject: await render(template.subject, variables) };
}

/** A phone or email that is a company identifier says who we are writing to. */
async function companyForAddress(
  tx: Tx,
  channel: Channel,
  address: string,
): Promise<string | undefined> {
  const type = channel === 'email' ? 'email' : channel === 'telegram' ? null : 'phone';
  if (!type) return undefined;
  const company = await findByIdentifier(tx, type, address);
  return company?.id;
}

async function insertMessage(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    contact: ContactInput;
    address: string;
    region: string | null;
    purpose: Purpose;
    template: string;
    body: string;
    variables?: Record<string, unknown> | undefined;
    status: 'blocked' | 'queued';
    blockedReason?: string;
    fallbackChannels: Channel[];
    parentMessageId?: string | undefined;
    companyId?: string | undefined;
  },
): Promise<MessageRow> {
  const [row] = await tx<MessageRow[]>`
    insert into messages
      (tenant_id, channel, address, region, purpose, template_name, body, status,
       blocked_reason, contact, variables, fallback_channels, parent_message_id, company_id)
    values (${input.tenantId}, ${input.channel}, ${input.address}, ${input.region},
            ${input.purpose}, ${input.template}, ${input.body}, ${input.status},
            ${input.blockedReason ?? null},
            ${tx.json(input.contact as never)},
            ${tx.json((input.variables ?? {}) as never)},
            ${input.fallbackChannels},
            ${input.parentMessageId ?? null},
            ${input.companyId ?? null})
    returning *
  `;
  if (!row) throw new Error('send inserted no message row');
  return row;
}

export function openConfig(row: ChannelConfigRow): ProviderConfig {
  return decrypt<ProviderConfig>({
    ciphertext: row.config_ciphertext,
    iv: row.config_iv,
    tag: row.config_tag,
  });
}
