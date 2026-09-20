import { fakeAdapter } from './fake.js';
import { taqnyatAdapter } from './taqnyat.js';
import type { ChannelAdapter } from './types.js';

/**
 * provider name to adapter. Nothing outside this folder imports a provider
 * file; everything else asks for an adapter by name.
 */
const REGISTRY: Record<string, ChannelAdapter> = {
  [fakeAdapter.provider]: fakeAdapter,
  [taqnyatAdapter.provider]: taqnyatAdapter,
};

export function adapterFor(provider: string): ChannelAdapter | undefined {
  return REGISTRY[provider];
}

export function knownProviders(): string[] {
  return Object.keys(REGISTRY);
}

export type * from './types.js';
