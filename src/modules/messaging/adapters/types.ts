import type { Channel } from '../../../spine/contacts/normalize.js';

/** Whatever a provider needs to authenticate. Shape is the adapter's business. */
export type ProviderConfig = Record<string, unknown>;

export type SendInput = {
  config: ProviderConfig;
  /** The engine's own message id, for correlation. Adapters may ignore it. */
  messageId: string;
  /** E.164 for phones; the adapter reshapes it if its API wants something else. */
  to: string;
  body: string;
  sender: string;
};

export type SendResult = { providerMessageId: string; raw: unknown };

export type DeliveryReport = {
  providerMessageId: string;
  status: 'delivered' | 'failed' | 'unknown';
  raw: unknown;
};

export type WebhookRequest = { headers: Record<string, string>; body: unknown };

export type CredentialCheck = { ok: true } | { ok: false; reason: string };

/**
 * One file per provider. Adding a channel or a second vendor is a new file
 * implementing this and one line in the registry — nothing else changes.
 */
export interface ChannelAdapter {
  readonly provider: string;
  readonly channel: Channel;
  send(input: SendInput): Promise<SendResult>;
  parseWebhook(req: WebhookRequest): DeliveryReport[];
  validateCredentials(config: ProviderConfig, sender: string): Promise<CredentialCheck>;
}
