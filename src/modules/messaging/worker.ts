import { db } from '../../db/client.js';
import { emit } from '../../spine/events/index.js';
import { adapterFor } from './adapters/index.js';
import { openConfig, type ChannelConfigRow, type MessageRow } from './index.js';

/**
 * Send one queued message. Runs as the owning role, not withTenant: the worker
 * has no JWT, and it writes the status columns the API role cannot.
 *
 * Throws on provider failure so pg-boss retries. `finalAttempt` says this was
 * the last one, so the message is marked failed before the error propagates.
 */
export async function processSend(
  messageId: string,
  opts: { finalAttempt?: boolean } = {},
): Promise<void> {
  const [message] = await db()<MessageRow[]>`
    select * from messages where id = ${messageId}
  `;
  // The job commits with its message row, so a job without one is a bug.
  if (!message) throw new Error(`message ${messageId} has a job but no row`);
  if (message.status !== 'queued') return;

  const [config] = await db()<ChannelConfigRow[]>`
    select * from tenant_channel_configs
    where tenant_id = ${message.tenant_id} and channel = ${message.channel}
  `;
  if (!config) {
    await markFailed(message, `no provider configured for channel ${message.channel}`);
    return;
  }

  const adapter = adapterFor(config.provider);
  if (!adapter) {
    // Retrying will not conjure an adapter, so fail now rather than three times.
    await markFailed(message, `no adapter for provider ${config.provider}`);
    return;
  }

  let result: { providerMessageId: string; raw: unknown };
  try {
    result = await adapter.send({
      config: openConfig(config),
      messageId: message.id,
      to: message.address,
      body: message.body,
      sender: config.sender,
    });
  } catch (err) {
    if (opts.finalAttempt) await markFailed(message, (err as Error).message);
    throw err;
  }

  await db().begin(async (tx) => {
    await tx`
      update messages
      set status = 'sent', provider = ${config.provider},
          provider_message_id = ${result.providerMessageId}, updated_at = now()
      where id = ${message.id}
    `;
    await emit(tx, {
      tenantId: message.tenant_id,
      type: 'message.sent',
      subjectType: 'message',
      subjectId: message.id,
      payload: {
        provider: config.provider,
        providerMessageId: result.providerMessageId,
        channel: message.channel,
      },
    });
  });
}

async function markFailed(message: MessageRow, error: string): Promise<void> {
  await db().begin(async (tx) => {
    await tx`
      update messages set status = 'failed', error = ${error}, updated_at = now()
      where id = ${message.id}
    `;
    await emit(tx, {
      tenantId: message.tenant_id,
      type: 'message.failed',
      subjectType: 'message',
      subjectId: message.id,
      payload: { error, channel: message.channel },
    });
  });
}

/**
 * Apply one delivery report. Runs as the owning role: a provider callback
 * carries no tenant, so the message row is what identifies the tenant.
 *
 * A report we cannot match is logged and dropped. Never answer a provider with
 * a 4xx for a body we do not understand — they retry it forever.
 */
export async function applyDeliveryReport(input: {
  provider: string;
  providerMessageId: string;
  status: 'delivered' | 'failed' | 'unknown';
  raw: unknown;
}): Promise<void> {
  if (input.status === 'unknown') {
    console.warn(
      `webhook: ${input.provider} reported an unrecognised status for ${input.providerMessageId}`,
      input.raw,
    );
    return;
  }

  const [message] = await db()<MessageRow[]>`
    select * from messages
    where provider = ${input.provider} and provider_message_id = ${input.providerMessageId}
  `;
  if (!message) {
    console.warn(
      `webhook: ${input.provider} reported unknown message ${input.providerMessageId}`,
      input.raw,
    );
    return;
  }

  await db().begin(async (tx) => {
    await tx`
      update messages set status = ${input.status}, updated_at = now()
      where id = ${message.id}
    `;
    await emit(tx, {
      tenantId: message.tenant_id,
      type: input.status === 'delivered' ? 'message.delivered' : 'message.failed',
      subjectType: 'message',
      subjectId: message.id,
      payload: { provider: input.provider, providerMessageId: input.providerMessageId },
    });
  });
}
