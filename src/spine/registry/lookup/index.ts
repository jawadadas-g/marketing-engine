import { wathqLookup } from './wathq.js';
import type { CompanyLookup } from './types.js';

export * from './types.js';
export { fakeLookup, resetFakeLookup, seedFakeLookup } from './fake.js';
export { wathqLookup } from './wathq.js';

let override: CompanyLookup | null | undefined;
let announced = false;

/**
 * The active lookup, or null when none is configured. Enrichment is optional
 * everywhere: with no key the registry simply stores what it was given.
 */
export function companyLookup(): CompanyLookup | null {
  if (override !== undefined) return override;

  const enabled = Boolean(process.env.WATHQ_API_KEY);
  if (!announced) {
    announced = true;
    console.log(
      enabled
        ? 'registry: company lookup enabled (wathq)'
        : 'registry: company lookup disabled (no WATHQ_API_KEY)',
    );
  }
  return enabled ? wathqLookup : null;
}

/** Test seam: pass a lookup to use, null to disable, undefined to fall back to env. */
export function setCompanyLookup(lookup: CompanyLookup | null | undefined): void {
  override = lookup;
}
