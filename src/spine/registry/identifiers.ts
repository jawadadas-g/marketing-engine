import { normalize } from '../contacts/normalize.js';

export const IDENTIFIER_TYPES = ['cr', 'vat', 'domain', 'phone', 'email'] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];

/**
 * Strong identifiers belong to exactly one company, so two records sharing one
 * are the same company and get merged. Weak ones link but never merge: a phone
 * number or a shared mailbox moves between companies over time.
 */
export const STRONG_TYPES: readonly IdentifierType[] = ['cr', 'vat', 'domain'];

export function isStrong(type: IdentifierType): boolean {
  return STRONG_TYPES.includes(type);
}

/** Domains that identify a mailbox provider, not a company. */
const FREE_MAIL = new Set([
  'gmail.com',
  'hotmail.com',
  'outlook.com',
  'yahoo.com',
  'icloud.com',
  'live.com',
  'msn.com',
  'protonmail.com',
]);

/** The marketplace's own domain identifies the marketplace, not a counterparty. */
function ownDomain(): string | undefined {
  return process.env.PLATFORM_DOMAIN?.trim().toLowerCase() || undefined;
}

export function isUselessDomain(domain: string): boolean {
  return FREE_MAIL.has(domain) || domain === ownDomain();
}

export type RawIdentifier = { type: string; value: string };
export type Identifier = { type: IdentifierType; value: string };

export type NormalizedIdentifiers = {
  identifiers: Identifier[];
  /** Inputs that could not be made into an identifier, with why. */
  rejected: { type: string; value: string; reason: string }[];
};

/**
 * Turn raw identifiers into the canonical forms the registry stores and
 * matches on. Pure: no database, no network. An email also yields its domain,
 * which is the strong identifier hiding inside a weak one.
 */
export function normalizeIdentifiers(
  raw: RawIdentifier[],
  opts: { defaultCountry?: string | undefined } = {},
): NormalizedIdentifiers {
  const identifiers: Identifier[] = [];
  const rejected: NormalizedIdentifiers['rejected'] = [];

  const add = (type: IdentifierType, value: string) => {
    if (!identifiers.some((i) => i.type === type && i.value === value)) {
      identifiers.push({ type, value });
    }
  };

  for (const entry of raw) {
    const type = entry.type?.trim().toLowerCase();
    const value = entry.value?.trim() ?? '';
    if (!value) continue;

    switch (type) {
      case 'cr':
      case 'vat': {
        const digits = value.replace(/\D/g, '');
        if (!digits) {
          rejected.push({ type, value, reason: 'no digits' });
          break;
        }
        add(type, digits);
        break;
      }

      case 'domain': {
        const domain = normalizeDomain(value);
        if (!domain) {
          rejected.push({ type, value, reason: 'not a domain' });
          break;
        }
        if (isUselessDomain(domain)) {
          rejected.push({ type, value, reason: 'identifies nobody' });
          break;
        }
        add('domain', domain);
        break;
      }

      case 'phone': {
        try {
          const contact = normalize({
            channel: 'sms',
            address: value,
            ...(opts.defaultCountry ? { defaultCountry: opts.defaultCountry } : {}),
          });
          add('phone', contact.address);
        } catch {
          rejected.push({ type, value, reason: 'not a valid phone number' });
        }
        break;
      }

      case 'email': {
        const email = value.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          rejected.push({ type, value, reason: 'not a valid email address' });
          break;
        }
        add('email', email);

        const domain = email.slice(email.indexOf('@') + 1);
        if (!isUselessDomain(domain)) add('domain', domain);
        break;
      }

      default:
        rejected.push({ type: type ?? '', value, reason: 'unknown identifier type' });
    }
  }

  return { identifiers, rejected };
}

/** Strip scheme, credentials, www., port and path down to the bare host. */
export function normalizeDomain(value: string): string | null {
  let host = value.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  host = host.replace(/^[^/@]*@/, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = host.split(':')[0] ?? '';
  host = host.replace(/^www\./, '');
  host = host.replace(/\.$/, '');

  if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
  return host;
}
