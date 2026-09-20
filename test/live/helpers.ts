import { withTenant } from '../../src/db/client.js';
import {
  storeChannelConfig,
  upsertTemplate,
  validateChannelConfig,
} from '../../src/modules/messaging/index.js';
import type { Channel } from '../../src/spine/contacts/normalize.js';
import { TENANT_A } from '../helpers.js';

/** Configure a real provider and a template for it, the way the API would. */
export async function configureLive(input: {
  channel: Channel;
  provider: string;
  sender: string;
  config: Record<string, unknown>;
  body: string;
  subject?: string;
  providerRef?: Record<string, unknown>;
}): Promise<void> {
  await validateChannelConfig({
    channel: input.channel,
    provider: input.provider,
    sender: input.sender,
    config: input.config,
  });

  await withTenant(TENANT_A, (tx) =>
    storeChannelConfig(tx, {
      tenantId: TENANT_A,
      channel: input.channel,
      provider: input.provider,
      sender: input.sender,
      config: input.config,
    }),
  );

  await withTenant(TENANT_A, (tx) =>
    upsertTemplate(tx, {
      tenantId: TENANT_A,
      name: 'live',
      channel: input.channel,
      body: input.body,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.providerRef ? { providerRef: input.providerRef } : {}),
    }),
  );
}
