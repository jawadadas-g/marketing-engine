import { z } from 'zod';

/**
 * Conventions every operator list follows: newest first, cursor by the last
 * row's id, never an offset. An offset over a table that is being written to
 * skips and repeats rows; a cursor does not.
 */
export const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().max(100).optional(),
});

const WINDOWS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export const windowQuery = z.object({
  since: z.coerce.date().optional(),
  until: z.coerce.date().optional(),
  window: z.enum(['1h', '24h', '7d', '30d']).optional(),
});

export type Window = { since: Date; until: Date };

/** `window=24h` is shorthand for `since = now - 24h`. An explicit since wins. */
export function resolveWindow(
  input: z.infer<typeof windowQuery>,
  fallback: keyof typeof WINDOWS = '24h',
): Window {
  const until = input.until ?? new Date();
  const since =
    input.since ?? new Date(until.getTime() - (WINDOWS[input.window ?? fallback] ?? WINDOWS['24h']!));
  return { since, until };
}

export function page<T extends Record<string, unknown>>(
  items: readonly T[],
  limit: number,
): { items: readonly T[]; nextCursor: string | null } {
  // A full page means there is probably another; a short one means there is not.
  // The cursor is the last row's id, whatever the row's shape.
  const last = items[items.length - 1];
  const nextCursor = items.length === limit && last ? String(last['id']) : null;
  return { items, nextCursor };
}

/** A type filter of `message.*` means the prefix; anything else is exact. */
export function typeFilter(type: string | undefined): { exact?: string; prefix?: string } {
  if (!type) return {};
  return type.endsWith('*') ? { prefix: type.slice(0, -1) } : { exact: type };
}
