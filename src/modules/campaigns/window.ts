import type { Tx } from '../../db/client.js';
import type { Channel, Purpose } from '../../spine/contacts/normalize.js';
import { preflight, type ContactInput } from '../messaging/index.js';

/** How far apart the times tried for a closed window are. A number to revisit. */
export const WINDOW_STEP_MINUTES = 15;

/** How far ahead a closed window is searched before giving up. A number to revisit. */
export const WINDOW_HORIZON_DAYS = 7;

/** Counts searches, so a test can see memoisation working without timing anything. */
export const windowStats = { searches: 0 };

/**
 * The first time after `from` that send() would let this intent out, trying
 * every 15-minute mark (on the clock, so 09:00 rather than 09:07) for up to
 * seven days. Null when no window opens in that time.
 *
 * It asks preflight, the same selection send() runs, at each time: nothing
 * here knows what a sending window looks like, only whether one is open.
 */
export async function nextSendingWindow(
  tx: Tx,
  input: {
    tenantId: string;
    contact: ContactInput;
    purpose: Purpose;
    channel?: Channel | undefined;
    from: Date;
  },
): Promise<Date | null> {
  windowStats.searches += 1;

  const step = WINDOW_STEP_MINUTES * 60_000;
  const horizon = input.from.getTime() + WINDOW_HORIZON_DAYS * 86_400_000;

  for (let t = Math.floor(input.from.getTime() / step) * step + step; t <= horizon; t += step) {
    const verdict = await preflight(tx, {
      tenantId: input.tenantId,
      contact: input.contact,
      purpose: input.purpose,
      ...(input.channel ? { channel: input.channel } : {}),
      at: new Date(t),
    });
    if (verdict.allowed) return new Date(t);
  }
  return null;
}
