import type { Channel } from '../../../spine/contacts/normalize.js';
import { emailSmtpAdapter } from './email-smtp.js';
import { fakeAdapterFor } from './fake.js';
import { taqnyatAdapter } from './taqnyat.js';
import { telegramAdapter } from './telegram.js';
import { whatsappMetaAdapter } from './whatsapp-meta.js';
import type { ChannelAdapter } from './types.js';

const CHANNELS: Channel[] = ['sms', 'whatsapp', 'email', 'telegram'];

/**
 * (provider, channel) to adapter. A provider name is not unique on its own:
 * `fake` serves all four channels. Nothing outside this folder imports a
 * provider file; everything else asks for an adapter by name.
 */
const REGISTRY = new Map<string, ChannelAdapter>();

function register(adapter: ChannelAdapter): void {
  REGISTRY.set(`${adapter.provider}:${adapter.channel}`, adapter);
}

register(taqnyatAdapter);
register(whatsappMetaAdapter);
register(emailSmtpAdapter);
register(telegramAdapter);
for (const channel of CHANNELS) register(fakeAdapterFor(channel));

export function adapterFor(provider: string, channel: Channel): ChannelAdapter | undefined {
  return REGISTRY.get(`${provider}:${channel}`);
}

/** Every adapter registered under a provider name, across channels. */
export function adaptersForProvider(provider: string): ChannelAdapter[] {
  return [...REGISTRY.values()].filter((a) => a.provider === provider);
}

export function knownProviders(): string[] {
  return [...new Set([...REGISTRY.values()].map((a) => a.provider))];
}

export * from './types.js';
