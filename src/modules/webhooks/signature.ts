import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Standard Webhooks (standardwebhooks.com), so a client can verify us with an
 * off-the-shelf library instead of a bespoke snippet.
 *
 * The signed string is `<id>.<timestamp>.<body>`: the id stops one delivery's
 * signature being replayed as another, and the timestamp stops an old body
 * being replayed at all, provided the receiver checks it.
 */
export const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function signPayload(input: {
  secret: string;
  id: string;
  timestamp: number;
  body: string;
}): string {
  const mac = createHmac('sha256', input.secret)
    .update(`${input.id}.${input.timestamp}.${input.body}`)
    .digest('base64');
  return `v1,${mac}`;
}

/** The same check a receiver makes. Used by the tests and the e2e listener. */
export function verifyPayload(input: {
  secret: string;
  id: string;
  timestamp: number;
  body: string;
  signature: string;
  now?: number;
}): boolean {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - input.timestamp) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const expected = signPayload(input);
  // A signature header may carry several space-separated versions; any match wins.
  return input.signature
    .split(' ')
    .some((candidate) => equal(candidate.trim(), expected));
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
