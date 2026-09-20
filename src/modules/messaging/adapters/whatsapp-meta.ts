import { createHmac, timingSafeEqual } from 'node:crypto';
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

const DEFAULT_API_VERSION = 'v21.0';

type MetaConfig = {
  accessToken?: unknown;
  phoneNumberId?: unknown;
  appSecret?: unknown;
  apiVersion?: unknown;
};

type TemplateRef = { name?: unknown; language?: unknown; params?: unknown };

function settings(config: ProviderConfig) {
  const { accessToken, phoneNumberId, appSecret, apiVersion } = config as MetaConfig;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('whatsapp-meta: config.accessToken is required');
  }
  if (typeof phoneNumberId !== 'string' || !phoneNumberId) {
    throw new Error('whatsapp-meta: config.phoneNumberId is required');
  }
  return {
    accessToken,
    phoneNumberId,
    appSecret: typeof appSecret === 'string' ? appSecret : '',
    apiVersion:
      typeof apiVersion === 'string' && apiVersion ? apiVersion : DEFAULT_API_VERSION,
  };
}

export const whatsappMetaAdapter: ChannelAdapter = {
  provider: 'whatsapp-meta',
  channel: 'whatsapp',
  webhookNeedsConfig: true,

  /**
   * Meta accepts only approved templates for business-initiated messages, so
   * the rendered Liquid body is not what goes out. The template row's
   * provider_ref names the approved template and the order its positional body
   * parameters are filled in.
   */
  async send(input: SendInput): Promise<SendResult> {
    const { accessToken, phoneNumberId, apiVersion } = settings(input.config);
    const ref = (input.providerRef ?? null) as TemplateRef | null;
    if (!ref || typeof ref.name !== 'string') {
      throw new Error('whatsapp-meta: template has no provider_ref.name');
    }

    const order = Array.isArray(ref.params) ? (ref.params as unknown[]) : [];
    const variables = input.variables ?? {};
    const parameters = order.map((key) => ({
      type: 'text',
      text: String(variables[String(key)] ?? ''),
    }));

    const res = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: input.to.replace(/^\+/, ''),
          type: 'template',
          template: {
            name: ref.name,
            language: { code: typeof ref.language === 'string' ? ref.language : 'en' },
            ...(parameters.length
              ? { components: [{ type: 'body', parameters }] }
              : {}),
          },
        }),
      },
    );

    const text = await res.text();
    if (!res.ok) throw new Error(`whatsapp-meta: send failed with ${res.status}: ${text}`);

    const payload = JSON.parse(text) as { messages?: { id?: unknown }[] };
    const id = payload.messages?.[0]?.id;
    if (typeof id !== 'string') {
      throw new Error(`whatsapp-meta: send returned no message id: ${text}`);
    }
    return { providerMessageId: id, raw: payload };
  },

  /** `sender` here is only a display name, so there is nothing to check it against. */
  async validateCredentials(config: ProviderConfig): Promise<CredentialCheck> {
    let settled: ReturnType<typeof settings>;
    try {
      settled = settings(config);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/${settled.apiVersion}/${settled.phoneNumberId}`,
        { headers: { Authorization: `Bearer ${settled.accessToken}` } },
      );
      if (res.ok) return { ok: true };
      return { ok: false, reason: `meta returned ${res.status}: ${await res.text()}` };
    } catch (err) {
      return { ok: false, reason: `could not reach meta: ${(err as Error).message}` };
    }
  },

  /** Which tenant a callback is for, before any of its secrets are available. */
  tenantHint(req: WebhookRequest) {
    const id = phoneNumberIdOf(req.body);
    return id ? { configKey: 'phoneNumberId', value: id } : undefined;
  },

  parseWebhook(req: WebhookRequest): ProviderEvent[] {
    verifySignature(req);

    const body = req.body as { entry?: unknown } | null;
    const entries = Array.isArray(body?.entry) ? body.entry : [];
    const events: ProviderEvent[] = [];

    for (const entry of entries) {
      const changes = Array.isArray((entry as { changes?: unknown }).changes)
        ? ((entry as { changes: unknown[] }).changes)
        : [];

      for (const change of changes) {
        const value = (change as { value?: Record<string, unknown> }).value ?? {};

        for (const status of asArray(value['statuses'])) {
          const row = status as { id?: unknown; status?: unknown };
          if (typeof row.id !== 'string' || typeof row.status !== 'string') continue;
          // `sent` is Meta acknowledging its own accept; we already recorded that.
          if (row.status === 'sent') continue;
          const mapped =
            row.status === 'delivered' || row.status === 'read' || row.status === 'failed'
              ? row.status
              : 'unknown';
          events.push({ kind: 'status', providerMessageId: row.id, status: mapped, raw: row });
        }

        for (const message of asArray(value['messages'])) {
          const row = message as { from?: unknown; text?: { body?: unknown } };
          if (typeof row.from !== 'string') continue;
          const text = typeof row.text?.body === 'string' ? row.text.body : '';
          events.push({ kind: 'inbound', address: `+${row.from}`, text, raw: row });
        }
      }
    }

    return events;
  },
};

export function phoneNumberIdOf(body: unknown): string | undefined {
  const entries = asArray((body as { entry?: unknown })?.entry);
  for (const entry of entries) {
    for (const change of asArray((entry as { changes?: unknown }).changes)) {
      const value = (change as { value?: Record<string, unknown> }).value ?? {};
      const metadata = value['metadata'] as { phone_number_id?: unknown } | undefined;
      if (typeof metadata?.phone_number_id === 'string') return metadata.phone_number_id;
    }
  }
  return undefined;
}

/**
 * A wrong signature is not a malformed body: someone is posting to this URL who
 * should not be, and they get told so. This is the one place a provider gets a
 * 4xx from us.
 */
function verifySignature(req: WebhookRequest): void {
  const appSecret = (req.config as MetaConfig | undefined)?.appSecret;
  if (typeof appSecret !== 'string' || !appSecret) {
    throw new WebhookAuthError(401, 'whatsapp-meta: no appSecret configured to verify against');
  }

  const header = req.headers['x-hub-signature-256'] ?? '';
  const expected = `sha256=${createHmac('sha256', appSecret).update(req.rawBody).digest('hex')}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookAuthError(401, 'whatsapp-meta: bad signature');
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
