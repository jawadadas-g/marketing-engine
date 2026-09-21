/**
 * Money is integers in the currency's minor unit. Nothing here is ever a
 * float, and no discount is ever lost or invented by rounding: a split that
 * does not divide evenly puts the remainder on the first funder.
 */

export type Discount = {
  type: 'percent' | 'fixed';
  /** Basis points for percent (1000 = 10%), minor units for fixed. */
  value: number;
  maxDiscount?: number | undefined;
  minSubtotal?: number | undefined;
};

export type Cart = {
  currency: string;
  subtotal: number;
  items: {
    sku?: string | undefined;
    category?: string | undefined;
    qty: number;
    unitPrice: number;
  }[];
};

export type Funder = { party: string; share: number };

export type ComputeResult =
  | { ok: true; amount: number }
  | { ok: false; reason: 'currency_mismatch' | 'min_subtotal' };

const BASIS_POINTS = 10_000;

/** Pure: what this code is worth against this cart, or why it is worth nothing. */
export function compute(
  promo: { currency: string; discount: Discount },
  cart: Cart,
): ComputeResult {
  if (promo.currency !== cart.currency) return { ok: false, reason: 'currency_mismatch' };
  if (promo.discount.minSubtotal && cart.subtotal < promo.discount.minSubtotal) {
    return { ok: false, reason: 'min_subtotal' };
  }

  const raw =
    promo.discount.type === 'percent'
      ? Math.floor((cart.subtotal * promo.discount.value) / BASIS_POINTS)
      : promo.discount.value;

  let amount = raw;
  if (promo.discount.maxDiscount !== undefined) {
    amount = Math.min(amount, promo.discount.maxDiscount);
  }
  // A discount can never exceed the cart it is discounting.
  amount = Math.min(amount, cart.subtotal);

  return { ok: true, amount: Math.max(0, Math.floor(amount)) };
}

/**
 * Split an amount between funders by share. Each part is rounded, and whatever
 * the rounding left over goes on the first funder, so the parts always sum to
 * exactly the amount.
 */
export function split(amount: number, funders: Funder[]): { party: string; amount: number }[] {
  if (funders.length === 0) throw new Error('a promocode needs at least one funder');

  const parts = funders.map((f) => ({ party: f.party, amount: Math.round(amount * f.share) }));
  const drift = amount - parts.reduce((sum, p) => sum + p.amount, 0);
  parts[0]!.amount += drift;

  return parts;
}

/** Split a settlement across holds in proportion to what each one is holding. */
export function proportion(
  total: number,
  holds: { holdRef: string; amount: number }[],
): { holdRef: string; amount: number }[] {
  const held = holds.reduce((sum, h) => sum + h.amount, 0);
  if (held === 0) return holds.map((h) => ({ holdRef: h.holdRef, amount: 0 }));

  const parts = holds.map((h) => ({
    holdRef: h.holdRef,
    amount: Math.round((total * h.amount) / held),
  }));
  const drift = total - parts.reduce((sum, p) => sum + p.amount, 0);
  parts[0]!.amount += drift;

  return parts;
}

export function fundersAreValid(funders: Funder[]): boolean {
  if (funders.length === 0) return false;
  if (funders.some((f) => !f.party || f.share < 0 || f.share > 1)) return false;
  const total = funders.reduce((sum, f) => sum + f.share, 0);
  return Math.abs(total - 1) < 1e-6;
}
