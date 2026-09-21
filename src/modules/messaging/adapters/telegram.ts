import { timingSafeEqual } from 'node:crypto';
import { env } from '../../../env.js';
import type {
  ChannelAdapter,
  CredentialCheck,
  ProviderConfig,
  ProviderEvent,
  SendInput,
  SendResult,
  WebhookRequest,
} from './types.js';
import { WebhookAuthError } from './types.js';

function botToken(config: ProviderConfig): string {
  const { botToken: token } = config as { botToken?: unknown };
  if (typeof token !== 'string' || !token) throw new Error('telegram: config.botToken is required');
  return token;
}

export const telegramAdapter: ChannelAdapter = {
  provider: 'telegram',
  channel: 'telegram',

  /** The address is a chat_id: the user must have started the bot first. */
  async send(input: SendInput): Promise<SendResult> {
    const token = botToken(input.config);

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: input.to, text: input.body }),
    });

    const text = await res.text();
    if (!res.ok) {
      // 403 "bot was blocked by the user" arrives here; the worker's final
      // attempt turns it into a failed message and a fallback if there is one.
      throw new Error(`telegram: send failed with ${res.status}: ${text}`);
    }

    const payload = JSON.parse(text) as { ok?: boolean; result?: { message_id?: unknown } };
    const id = payload.result?.message_id;
    if (!payload.ok || id === undefined) {
      throw new Error(`telegram: send returned no message_id: ${text}`);
    }
    return { providerMessageId: String(id), raw: payload };
  },

  async validateCredentials(config: ProviderConfig): Promise<CredentialCheck> {
    let token: string;
    try {
      token = botToken(config);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      return payload?.ok === true
        ? { ok: true }
        : { ok: false, reason: `telegram rejected the bot token (${res.status})` };
    } catch (err) {
      return { ok: false, reason: `could not reach telegram: ${(err as Error).message}` };
    }
  },

  /**
   * Telegram has no delivery reports; the callback only carries inbound
   * messages. Its shared secret is the one set with setWebhook, and a caller
   * who gets it wrong is told nothing.
   */
  parseWebhook(req: WebhookRequest): ProviderEvent[] {
    const expected = env().WEBHOOK_TOKEN;
    const given = req.headers['x-telegram-bot-api-secret-token'] ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookAuthError(404, 'telegram: bad secret token');
    }

    const message = (req.body as { message?: Record<string, unknown> } | null)?.message;
    if (!message) return [];

    const chat = message['chat'] as { id?: unknown } | undefined;
    const text = message['text'];
    if (chat?.id === undefined || typeof text !== 'string') return [];

    return [{ kind: 'inbound', address: String(chat.id), text, raw: message }];
  },
};
