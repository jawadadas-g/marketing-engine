import type { Channel } from '../../../spine/contacts/normalize.js';
import type { ChannelAdapter, ProviderEvent, SendInput, SendResult, WebhookRequest } from './types.js';

export type FakeCall = {
  channel: Channel;
  to: string;
  body: string;
  sender: string;
  subject?: string | undefined;
  providerRef?: unknown;
  variables?: Record<string, unknown> | undefined;
  unsubscribeUrl?: string | undefined;
};

const calls: FakeCall[] = [];
const failures = new Map<Channel, Error>();

/** Every send the fake adapters have been asked to make, in order. */
export function fakeCalls(channel?: Channel): readonly FakeCall[] {
  return channel ? calls.filter((c) => c.channel === channel) : calls;
}

export function resetFake(): void {
  calls.length = 0;
  failures.clear();
}

/** Make one channel's sends throw, to watch another channel pick it up. */
export function failFakeSends(channel: Channel, error: Error | null): void {
  if (error) failures.set(channel, error);
  else failures.delete(channel);
}

/**
 * The adapter CI and local development run against, one per channel. It never
 * talks to anyone: send records the call and hands back a deterministic id.
 */
export function fakeAdapterFor(channel: Channel): ChannelAdapter {
  return {
    provider: 'fake',
    channel,

    async send(input: SendInput): Promise<SendResult> {
      const failure = failures.get(channel);
      if (failure) throw failure;
      calls.push({
        channel,
        to: input.to,
        body: input.body,
        sender: input.sender,
        subject: input.subject,
        providerRef: input.providerRef,
        variables: input.variables,
        unsubscribeUrl: input.unsubscribeUrl,
      });
      return { providerMessageId: `fake-${input.messageId}`, raw: { ok: true } };
    },

    parseWebhook(req: WebhookRequest): ProviderEvent[] {
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body !== 'object') return [];

      if (typeof body['from'] === 'string' && typeof body['text'] === 'string') {
        return [{ kind: 'inbound', address: body['from'], text: body['text'], raw: body }];
      }

      const id = body['id'];
      const status = body['status'];
      if (typeof id !== 'string' || typeof status !== 'string') return [];
      const known = ['delivered', 'read', 'failed'] as const;
      return [
        {
          kind: 'status',
          providerMessageId: id,
          status: known.find((s) => s === status) ?? 'unknown',
          raw: body,
        },
      ];
    },

    async validateCredentials(config) {
      return config['token'] === 'bad' ? { ok: false, reason: 'bad token' } : { ok: true };
    },
  };
}
