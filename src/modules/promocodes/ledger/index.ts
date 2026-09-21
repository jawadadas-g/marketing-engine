import { env } from '../../../env.js';
import { financeEngineLedger } from './finance-engine.js';
import { internalLedger } from './internal.js';
import type { Ledger } from './types.js';

export * from './types.js';
export { internalLedger } from './internal.js';

const REGISTRY = new Map<string, Ledger>([
  [internalLedger.name, internalLedger],
  [financeEngineLedger.name, financeEngineLedger],
]);

/** Read per call, so a test can swap it and a deployment can change it. */
export function activeLedger(): Ledger {
  const name = env().LEDGER.trim() || internalLedger.name;
  const ledger = REGISTRY.get(name);
  if (!ledger) {
    throw new Error(`LEDGER=${name} is not a known ledger (${[...REGISTRY.keys()].join(', ')})`);
  }
  return ledger;
}
