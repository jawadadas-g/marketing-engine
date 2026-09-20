import type { CompanyFacts, CompanyLookup } from './types.js';

const DEFAULT_BASE_URL = 'https://api.wathq.sa';

/**
 * Wathq's Commercial Registration API, as a platform-level connector.
 *
 * UNVERIFIED RESPONSE MAPPING. Wathq publishes its request contract but keeps
 * the response schema behind the developer portal, and the API answers 401 to
 * an unauthenticated probe, so no field name below has been checked against a
 * real response. Rather than invent a mapping, this reads only field names that
 * are unambiguous if present and puts the whole payload in `raw` regardless —
 * the source row therefore keeps everything even when the mapping finds
 * nothing.
 *
 * Before relying on this: make one real call with a key, look at the body, and
 * replace `factsFrom` with the actual field names. The `raw` on any `lookup`
 * source row already written is enough to do that retrospectively.
 */
export const wathqLookup: CompanyLookup = {
  provider: 'wathq',

  async byCr(cr: string): Promise<CompanyFacts | null> {
    const apiKey = process.env.WATHQ_API_KEY;
    if (!apiKey) return null;

    const baseUrl = (process.env.WATHQ_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');

    let res: Response;
    try {
      res = await fetch(`${baseUrl}/v5/commercialregistration/info/${encodeURIComponent(cr)}`, {
        headers: { apiKey, Accept: 'application/json' },
      });
    } catch (err) {
      console.warn(`wathq: lookup for ${cr} could not reach the API`, err);
      return null;
    }

    if (!res.ok) {
      console.warn(`wathq: lookup for ${cr} returned ${res.status}`);
      return null;
    }

    const raw = (await res.json().catch(() => null)) as unknown;
    if (!raw || typeof raw !== 'object') return null;

    return factsFrom(raw);
  },
};

function factsFrom(raw: unknown): CompanyFacts | null {
  const body = raw as Record<string, unknown>;

  const name = firstString(body, ['crName', 'name', 'businessName', 'tradeName']);
  if (!name) {
    // The payload is kept even so: whoever checks the mapping needs it.
    console.warn('wathq: response carried no recognisable name field; keeping raw only');
    return null;
  }

  return {
    name,
    nameEn: firstString(body, ['crNameEn', 'nameEn', 'englishName']),
    status: firstString(body, ['status', 'crStatus']),
    city: firstString(body, ['city', 'crCity']),
    raw,
  };
}

function firstString(body: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>)['name'];
      if (typeof nested === 'string' && nested.trim()) return nested.trim();
    }
  }
  return undefined;
}
