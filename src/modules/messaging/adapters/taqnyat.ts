import type {
  ChannelAdapter,
  CredentialCheck,
  DeliveryReport,
  ProviderConfig,
  SendInput,
  SendResult,
  WebhookRequest,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.taqnyat.sa';

type TaqnyatConfig = { token?: unknown; baseUrl?: unknown };

function settings(config: ProviderConfig): { token: string; baseUrl: string } {
  const { token, baseUrl } = config as TaqnyatConfig;
  if (typeof token !== 'string' || !token) throw new Error('taqnyat: config.token is required');
  return {
    token,
    baseUrl: (typeof baseUrl === 'string' && baseUrl ? baseUrl : DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    ),
  };
}

/** Taqnyat wants recipients as numbers, so E.164 without the leading `+`. */
function recipient(to: string): number {
  return Number(to.replace(/^\+/, ''));
}

type SendResponse = {
  statusCode?: number;
  messageId?: unknown;
  rejected?: unknown;
};

export const taqnyatAdapter: ChannelAdapter = {
  provider: 'taqnyat',
  channel: 'sms',

  async send(input: SendInput): Promise<SendResult> {
    const { token, baseUrl } = settings(input.config);

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        recipients: [recipient(input.to)],
        body: input.body,
        sender: input.sender,
      }),
    });

    const text = await res.text();
    if (res.status !== 201) {
      // Taqnyat reports a sender problem as `Number(s) is empty or incorrect`,
      // which points at the wrong field. Verified live 2026-09-20: a sender
      // that `/v1/messages/senders` lists as active can still be rejected for
      // sending, and the 400 names the recipient. Check the sender first.
      throw new Error(`taqnyat: send failed with ${res.status}: ${text}`);
    }

    let payload: SendResponse;
    try {
      payload = JSON.parse(text) as SendResponse;
    } catch {
      throw new Error(`taqnyat: send returned unparseable body: ${text}`);
    }

    const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
    if (rejected.some((r) => String(r) === String(recipient(input.to)))) {
      throw new Error(`taqnyat: recipient rejected: ${text}`);
    }
    if (payload.messageId === undefined || payload.messageId === null) {
      throw new Error(`taqnyat: send returned no messageId: ${text}`);
    }

    return { providerMessageId: String(payload.messageId), raw: payload };
  },

  async validateCredentials(config: ProviderConfig, sender: string): Promise<CredentialCheck> {
    let settled: { token: string; baseUrl: string };
    try {
      settled = settings(config);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }

    let res: Response;
    try {
      res = await fetch(`${settled.baseUrl}/v1/messages/senders`, {
        headers: { Authorization: `Bearer ${settled.token}` },
      });
    } catch (err) {
      return { ok: false, reason: `could not reach taqnyat: ${(err as Error).message}` };
    }

    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'bad token' };
    if (!res.ok) return { ok: false, reason: `taqnyat returned ${res.status}` };

    const payload = (await res.json().catch(() => null)) as unknown;
    const senders = findSenders(payload);
    const match = senders.find((s) => s.name === sender);
    if (!match) return { ok: false, reason: `sender ${sender} is not on this account` };
    if (match.status.toLowerCase() !== 'active') {
      return { ok: false, reason: `sender ${sender} is ${match.status}, not active` };
    }
    return { ok: true };
  },

  // TODO(step 4): Taqnyat's delivery-report callback is not in their OpenAPI
  // spec, so this is deliberately permissive. Paste a real callback body from
  // the live test into this file and tighten the mapping to match it.
  parseWebhook(req: WebhookRequest): DeliveryReport[] {
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return [];

    const id = body['messageId'] ?? body['id'];
    const status = body['status'];
    if (id === undefined || id === null || typeof status !== 'string') return [];

    return [{ providerMessageId: String(id), status: mapStatus(status), raw: body }];
  },
};

function mapStatus(status: string): DeliveryReport['status'] {
  switch (status.toLowerCase()) {
    case 'delivered':
      return 'delivered';
    case 'failed':
    case 'undelivered':
    case 'rejected':
      return 'failed';
    default:
      return 'unknown';
  }
}

/** The senders list may come back bare or wrapped; accept either. */
function findSenders(payload: unknown): { name: string; status: string }[] {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { senders?: unknown })?.senders)
      ? ((payload as { senders: unknown[] }).senders)
      : [];

  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const name = row['sender'] ?? row['name'] ?? row['senderName'];
    const status = row['status'] ?? row['state'];
    if (typeof name !== 'string') return [];
    return [{ name, status: typeof status === 'string' ? status : '' }];
  });
}
