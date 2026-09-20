import type { CompanyFacts, CompanyLookup } from './types.js';

const seeded = new Map<string, CompanyFacts>();

export function seedFakeLookup(cr: string, facts: Omit<CompanyFacts, 'raw'> & { raw?: unknown }): void {
  seeded.set(cr, { ...facts, raw: facts.raw ?? { seeded: true } });
}

export function resetFakeLookup(): void {
  seeded.clear();
}

export const fakeLookup: CompanyLookup = {
  provider: 'fake',
  async byCr(cr: string): Promise<CompanyFacts | null> {
    return seeded.get(cr) ?? null;
  },
};
