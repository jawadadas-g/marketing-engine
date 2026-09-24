import type { Tx } from '../../db/client.js';
import { canSend } from '../../spine/consent/index.js';
import { CHANNELS, normalize, type Channel, type Purpose } from '../../spine/contacts/normalize.js';
import { decide } from '../../spine/rules/index.js';

export type ContactInput = {
  phone?: string | undefined;
  email?: string | undefined;
  telegram?: string | undefined;
};

/** One address per channel. A phone serves both SMS and WhatsApp. */
export function addressFor(contact: ContactInput, channel: Channel): string | undefined {
  switch (channel) {
    case 'sms':
    case 'whatsapp':
      return contact.phone;
    case 'email':
      return contact.email;
    case 'telegram':
      return contact.telegram;
  }
}

export type Selection = {
  chosen?: { channel: Channel; address: string };
  /** The channels after the chosen one, to try if it fails for good. */
  fallback: Channel[];
  /** Why each candidate was not chosen, for the blocked event's payload. */
  reasons: Record<string, string>;
  /**
   * The first channel that passed suppression and consent and was held back
   * only by a sending_window rule. Set only when nothing was chosen: it is the
   * structured answer to "would this go out later?", so a caller never has to
   * parse `rule:<name>` out of `reasons`.
   */
  windowBlock?: WindowBlock;
};

export type WindowBlock = {
  channel: Channel;
  /** The address's region, which is what decides whose sending rules apply. */
  region: string | null;
  rule: { id: string; name: string };
};

/**
 * Decide which channel this intent goes out on.
 *
 * Suppression and consent are asked of every candidate first, because a rule
 * should be able to see which channels the contact actually agreed to. The
 * sending window is then applied only to the channel that wins, so a quiet hour
 * on SMS does not stop an email.
 */
export async function selectChannel(
  tx: Tx,
  input: {
    tenantId: string;
    contact: ContactInput;
    purpose: Purpose;
    preferred?: Channel | undefined;
    configuredChannels: Set<Channel>;
    at?: Date | undefined;
    defaultCountry?: string | undefined;
  },
): Promise<Selection> {
  const reasons: Record<string, string> = {};

  const available: Channel[] = [];
  for (const channel of CHANNELS) {
    const address = addressFor(input.contact, channel);
    if (!address) {
      reasons[channel] = 'no_address';
      continue;
    }
    if (!input.configuredChannels.has(channel)) {
      reasons[channel] = 'channel_not_configured';
      continue;
    }
    available.push(channel);
  }

  const consented: Record<string, boolean> = {};
  for (const channel of available) {
    const verdict = await canSend(tx, {
      tenantId: input.tenantId,
      channel,
      address: addressFor(input.contact, channel)!,
      purpose: input.purpose,
      checkRules: false,
      ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
    });
    consented[channel] = verdict.allowed;
    if (!verdict.allowed) reasons[channel] = verdict.reason;
  }

  const ordered = await orderFor(tx, input, available, consented);

  let windowBlock: WindowBlock | undefined;

  for (let i = 0; i < ordered.length; i += 1) {
    const channel = ordered[i]!;
    const address = addressFor(input.contact, channel)!;

    const verdict = await canSend(tx, {
      tenantId: input.tenantId,
      channel,
      address,
      purpose: input.purpose,
      ...(input.at ? { at: input.at } : {}),
      ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
    });

    if (verdict.allowed) {
      // The fallback order is what comes after the winner, minus anything the
      // contact has not consented to: consent will not have changed by the time
      // a fallback runs, but a quiet hour may well have passed, so a channel
      // held back only by the window stays in.
      const fallback = ordered.slice(i + 1).filter((c) => consented[c]);
      return { chosen: { channel, address }, fallback, reasons };
    }
    reasons[channel] = verdict.reason === 'rule' ? `rule:${verdict.rule?.name}` : verdict.reason;
    // canSend only answers `rule` after suppression and consent have passed,
    // and the only rules it evaluates are sending_window ones.
    if (verdict.reason === 'rule' && verdict.rule && !windowBlock) {
      windowBlock = { channel, region: regionOfAddress(channel, address, input.defaultCountry), rule: verdict.rule };
    }
  }

  return { fallback: [], reasons, ...(windowBlock ? { windowBlock } : {}) };
}

async function orderFor(
  tx: Tx,
  input: {
    tenantId: string;
    contact: ContactInput;
    purpose: Purpose;
    preferred?: Channel | undefined;
    defaultCountry?: string | undefined;
  },
  available: Channel[],
  consented: Record<string, boolean>,
): Promise<Channel[]> {
  // A named channel is the channel, not a hint. Rules decide only when the
  // caller did not. Without this the worker's fallback would ask the rules
  // again and be sent straight back to the channel that just failed.
  if (input.preferred) return available.filter((c) => c === input.preferred);

  const region = regionOf(input.contact, input.defaultCountry);

  const ruled = await decide<unknown>(tx, {
    kind: 'channel_selection',
    tenantId: input.tenantId,
    region,
    context: {
      purpose: input.purpose,
      region,
      preferred: input.preferred ?? null,
      available,
      consented: Object.fromEntries(CHANNELS.map((c) => [c, consented[c] ?? false])),
    },
  });

  const fromRule = Array.isArray(ruled.value) ? (ruled.value as unknown[]) : null;

  // No rule decided: the caller's preference first, then the default order.
  const order = fromRule
    ? fromRule.map(String)
    : [input.preferred, 'whatsapp', 'sms', 'email', 'telegram'].filter(Boolean).map(String);

  const seen = new Set<string>();
  return order.filter((c): c is Channel => {
    if (seen.has(c)) return false;
    seen.add(c);
    return available.includes(c as Channel);
  });
}

/**
 * The region a region-scoped rule is matched on. Only a phone implies one, so
 * a contact reachable solely by email or telegram has none and sees platform
 * and tenant rules only.
 */
function regionOf(contact: ContactInput, defaultCountry?: string): string | null {
  if (!contact.phone) return null;
  try {
    return normalize({
      channel: 'sms',
      address: contact.phone,
      ...(defaultCountry ? { defaultCountry } : {}),
    }).region;
  } catch {
    return null;
  }
}

function regionOfAddress(channel: Channel, address: string, defaultCountry?: string): string | null {
  try {
    return normalize({ channel, address, ...(defaultCountry ? { defaultCountry } : {}) }).region;
  } catch {
    return null;
  }
}
