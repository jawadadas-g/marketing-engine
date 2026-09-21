import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../env.js';

export type UnsubscribeClaim = { tenantId: string; channel: string; address: string };

function key(): string {
  return env().WEBHOOK_TOKEN;
}

function sign(claim: UnsubscribeClaim): string {
  return createHmac('sha256', key())
    .update(`${claim.tenantId}:${claim.channel}:${claim.address}`)
    .digest('hex');
}

/** A self-contained opt-out link: no table, the signature is the authority. */
export function unsubscribeToken(claim: UnsubscribeClaim): string {
  const payload = `${claim.tenantId}:${claim.channel}:${claim.address}:${sign(claim)}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function verifyUnsubscribeToken(token: string): UnsubscribeClaim | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  // The address is last but one; an email address has no colons, so a plain
  // split is enough — but rebuild it defensively anyway.
  const parts = decoded.split(':');
  if (parts.length < 4) return null;
  const mac = parts.pop()!;
  const [tenantId, channel, ...addressParts] = parts;
  if (!tenantId || !channel) return null;

  const claim = { tenantId, channel, address: addressParts.join(':') };
  const expected = sign(claim);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return claim;
}

export function unsubscribeUrlFor(tenantId: string, channel: string, address: string): string {
  const base = env().PUBLIC_BASE_URL.replace(/\/+$/, '');
  return `${base}/unsubscribe/${unsubscribeToken({ tenantId, channel, address })}`;
}
