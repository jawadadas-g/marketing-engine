import type { Tx } from '../../../db/client.js';
import { normalizeName } from '../../../spine/registry/index.js';
import type { Candidate, Finder, FinderQuery } from './types.js';

/**
 * THE PLACEHOLDER. This is not a matching algorithm and is not meant to be
 * one: it is an AND of exact filters, so every row it returns matched
 * everything that was asked and scores 1.0.
 *
 * It exists so the endpoints, the invite loop and the finder_runs log are real
 * and exercised end to end while the actual ranking is still undecided. The
 * score is computed from matched-fields-over-asked-fields rather than
 * hardcoded to 1, so the shape a real finder returns is already being
 * exercised by callers and tests.
 *
 * What the interface guarantees, and what this upholds: no merged-away
 * company, no company already on the marketplace, never more than `limit`.
 */
export const basicFinder: Finder = {
  name: 'basic',

  async find(tx: Tx, tenantId: string, query: FinderQuery): Promise<Candidate[]> {
    void tenantId; // the pool is shared; nothing here is tenant-specific yet

    const text = query.text ? normalizeName(query.text) : null;
    const buys = query.buys?.length ? query.buys : null;
    const excluded = query.excludeCompanyIds?.length ? query.excludeCompanyIds : null;

    const rows = await tx<{ id: string }[]>`
      select c.id
      from companies c
      left join company_profiles p on p.company_id = c.id
      where c.merged_into is null
        and c.on_platform_ref is null
        and (${buys}::text[] is null or p.buys && ${buys}::text[])
        and (${query.sector ?? null}::text is null or p.sector = ${query.sector ?? null})
        and (${query.city ?? null}::text is null or p.city = ${query.city ?? null})
        and (${query.country ?? null}::text is null or c.country = ${query.country ?? null})
        and (${text}::text is null or c.name_normalized % ${text}::text)
        and (${excluded}::uuid[] is null or c.id <> all(${excluded}::uuid[]))
      order by c.created_at desc
      limit ${query.limit}
    `;

    const asked = askedFields(query);
    return rows.map((row) => {
      // Every filter is an AND, so a row that came back matched all of them.
      // Divided out rather than written as 1, so the fraction a real finder
      // returns is the same shape callers already handle.
      const matched = asked;
      return {
        companyId: row.id,
        score: asked.length === 0 ? 1 : matched.length / asked.length,
        reasons: matched,
      };
    });
  },
};

/** The fields the caller actually asked about, as reasons. */
function askedFields(query: FinderQuery): string[] {
  const reasons: string[] = [];
  if (query.buys?.length) reasons.push(`buys: ${query.buys.join(', ')}`);
  if (query.sector) reasons.push(`sector: ${query.sector}`);
  if (query.city) reasons.push(`city: ${query.city}`);
  if (query.country) reasons.push(`country: ${query.country}`);
  if (query.text) reasons.push(`name matches: ${query.text}`);
  return reasons;
}
