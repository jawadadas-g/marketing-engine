import { basicFinder } from './basic.js';
import type { Finder } from './types.js';

export * from './types.js';
export { basicFinder } from './basic.js';

const REGISTRY = new Map<string, Finder>([[basicFinder.name, basicFinder]]);

/**
 * Add an algorithm: write the file, register it here, set FINDER. Nothing else
 * in the engine knows which one is running.
 */
export function registerFinder(finder: Finder): void {
  REGISTRY.set(finder.name, finder);
}

export function activeFinder(): Finder {
  // Read per call rather than at import, so the choice can change without a
  // restart and a test can swap it.
  const name = process.env.FINDER?.trim() || basicFinder.name;
  const finder = REGISTRY.get(name);
  if (!finder) {
    throw new Error(`FINDER=${name} is not a registered finder (${[...REGISTRY.keys()].join(', ')})`);
  }
  return finder;
}
