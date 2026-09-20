import type {
  ChannelAdapter,
  DeliveryReport,
  SendInput,
  SendResult,
  WebhookRequest,
} from './types.js';

export type FakeCall = { to: string; body: string; sender: string };

const calls: FakeCall[] = [];
let failure: Error | null = null;

/** Every send the fake adapter has been asked to make, in order. */
export function fakeCalls(): readonly FakeCall[] {
  return calls;
}

export function resetFake(): void {
  calls.length = 0;
  failure = null;
}

/** Make the next sends throw, to exercise the retry and failure path. */
export function failFakeSends(error: Error | null): void {
  failure = error;
}

/**
 * The adapter CI and local development run against. It never talks to anyone;
 * `send` just records the call and hands back a deterministic id.
 */
export const fakeAdapter: ChannelAdapter = {
  provider: 'fake',
  channel: 'sms',

  async send(input: SendInput): Promise<SendResult> {
    if (failure) throw failure;
    calls.push({ to: input.to, body: input.body, sender: input.sender });
    return { providerMessageId: `fake-${input.messageId}`, raw: { ok: true } };
  },

  parseWebhook(req: WebhookRequest): DeliveryReport[] {
    const body = req.body as { id?: unknown; status?: unknown } | null;
    if (!body || typeof body.id !== 'string' || typeof body.status !== 'string') return [];
    const status =
      body.status === 'delivered' || body.status === 'failed' ? body.status : 'unknown';
    return [{ providerMessageId: body.id, status, raw: body }];
  },

  async validateCredentials(config) {
    return config['token'] === 'bad' ? { ok: false, reason: 'bad token' } : { ok: true };
  },
};
