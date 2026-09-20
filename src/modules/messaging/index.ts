import type { Tx } from '../../db/client.js';
import { canSend } from '../../spine/consent/index.js';
import { normalize, type Channel, type Purpose } from '../../spine/contacts/normalize.js';
import { emit } from '../../spine/events/index.js';
import { decrypt, encrypt } from '../../spine/secrets.js';
import { enqueue } from '../../jobs/index.js';
import { adapterFor, type ProviderConfig } from './adapters/index.js';
import { MessagingError } from './errors.js';
import { assertParses, render } from './templates.js';

export const SEND_JOB = 'message.send';

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
  status: 'blocked' | 'queued' | 'sent' | 'delivered' | 'failed';
  blocked_reason: string | null;
  error: string | null;
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

/** Check the credentials against the provider before storing them. */
export async function setChannelConfig(
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
  const adapter = adapterFor(input.provider);
  if (!adapter) {
    throw new MessagingError('unknown_provider', 422, `no adapter for provider ${input.provider}`);
  }
  if (adapter.channel !== input.channel) {
    throw new MessagingError(
      'unknown_provider',
      422,
      `provider ${input.provider} does not serve channel ${input.channel}`,
    );
  }

  const check = await adapter.validateCredentials(input.config, input.sender);
  if (!check.ok) throw new MessagingError('credentials_rejected', 422, check.reason);

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
  if (!row) throw new Error('setChannelConfig wrote no row');

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
  channel: string,
): Promise<ChannelConfigRow | undefined> {
  const [row] = await tx<ChannelConfigRow[]>`
    select * from tenant_channel_configs where channel = ${channel}
  `;
  return row;
}

export type TemplateRow = {
  id: string;
  tenant_id: string;
  name: string;
  channel: string;
  body: string;
  created_at: Date;
  updated_at: Date;
};

export async function upsertTemplate(
  tx: Tx,
  input: { tenantId: string; name: string; channel: Channel; body: string },
): Promise<TemplateRow> {
  assertParses(input.body);

  const [row] = await tx<TemplateRow[]>`
    insert into templates (tenant_id, name, channel, body)
    values (${input.tenantId}, ${input.name}, ${input.channel}, ${input.body})
    on conflict (tenant_id, name, channel) do update set
      body = excluded.body, updated_at = now()
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
 * The send intent. Runs can_send, renders, queues. Never talks to a provider:
 * that is the worker's job, after this has committed.
 */
export async function send(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    address: string;
    purpose: Purpose;
    template: string;
    variables?: Record<string, unknown> | undefined;
    defaultCountry?: string | undefined;
    at?: Date | undefined;
  },
): Promise<MessageRow> {
  const contact = normalize(input);

  const config = await getChannelConfig(tx, input.channel);
  if (!config) {
    throw new MessagingError(
      'channel_not_configured',
      409,
      `no provider configured for channel ${input.channel}`,
    );
  }

  const [template] = await tx<TemplateRow[]>`
    select * from templates
    where name = ${input.template} and channel = ${input.channel}
  `;
  if (!template) {
    throw new MessagingError('template_not_found', 404, `no template named ${input.template}`);
  }

  // can_send is the only door out, and it runs before anything is rendered.
  const verdict = await canSend(tx, {
    tenantId: input.tenantId,
    channel: input.channel,
    address: input.address,
    purpose: input.purpose,
    ...(input.at ? { at: input.at } : {}),
    ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
  });

  if (!verdict.allowed) {
    const reason = verdict.reason === 'rule' ? `rule:${verdict.rule?.name}` : verdict.reason;
    const row = await insertMessage(tx, {
      ...input,
      contactAddress: contact.address,
      region: contact.region,
      body: '',
      status: 'blocked',
      blockedReason: reason,
    });
    await emit(tx, {
      tenantId: input.tenantId,
      type: 'message.blocked',
      subjectType: 'message',
      subjectId: row.id,
      payload: { reason, channel: input.channel, purpose: input.purpose },
    });
    return row;
  }

  let body = await render(template.body, {
    ...(input.variables ?? {}),
    contact: { address: contact.address },
  });

  if (input.purpose === 'marketing') {
    const unsubscribe = config.unsubscribe_text?.trim();
    if (!unsubscribe) {
      throw new MessagingError(
        'unsubscribe_text_required',
        422,
        `channel ${input.channel} has no unsubscribe_text, which marketing messages require`,
      );
    }
    body = `${body}\n${unsubscribe}`;
  }

  const row = await insertMessage(tx, {
    ...input,
    contactAddress: contact.address,
    region: contact.region,
    body,
    status: 'queued',
  });

  await emit(tx, {
    tenantId: input.tenantId,
    type: 'message.queued',
    subjectType: 'message',
    subjectId: row.id,
    payload: { channel: input.channel, purpose: input.purpose, provider: config.provider },
  });

  await enqueue(tx, SEND_JOB, { messageId: row.id });

  return row;
}

async function insertMessage(
  tx: Tx,
  input: {
    tenantId: string;
    channel: Channel;
    contactAddress: string;
    region: string | null;
    purpose: Purpose;
    template: string;
    body: string;
    status: 'blocked' | 'queued';
    blockedReason?: string;
  },
): Promise<MessageRow> {
  const [row] = await tx<MessageRow[]>`
    insert into messages
      (tenant_id, channel, address, region, purpose, template_name, body, status, blocked_reason)
    values (${input.tenantId}, ${input.channel}, ${input.contactAddress}, ${input.region},
            ${input.purpose}, ${input.template}, ${input.body}, ${input.status},
            ${input.blockedReason ?? null})
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
