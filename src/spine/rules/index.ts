import jsonLogic from 'json-logic-js';
import type { Tx } from '../../db/client.js';

export type RuleScope = 'platform' | 'region' | 'tenant';

export type RuleRow = {
  id: string;
  scope: RuleScope;
  region: string | null;
  tenant_id: string | null;
  kind: string;
  name: string;
  document: unknown;
  enabled: boolean;
  created_at: Date;
};

export type RuleRef = { id: string; name: string; scope: RuleScope };

export type EvaluateInput = {
  kind: string;
  tenantId: string;
  region: string | null;
  context: Record<string, unknown>;
};

export type EvaluateResult = { denied: boolean; byRule?: RuleRef };

/**
 * Run every enabled rule of `kind` against `context`, in scope order:
 * platform, then the contact's region, then the tenant's own. A rule document
 * that evaluates truthy is a deny, and the first one wins — so a tenant can
 * add restrictions but never lift a platform or region one.
 *
 * json-logic lives behind this function; nothing outside this folder knows the
 * documents are json-logic.
 */
export async function evaluate(tx: Tx, input: EvaluateInput): Promise<EvaluateResult> {
  const rules = await load(tx, input);

  for (const rule of rules) {
    let denied: boolean;
    try {
      denied = jsonLogic.apply(rule.document as never, input.context) === true;
    } catch (err) {
      // A broken document must not quietly allow the whole call, and must not
      // take down every other rule either. Skip it and keep going.
      console.error(`rules: ${input.kind} rule ${rule.id} (${rule.name}) threw, skipping`, err);
      continue;
    }
    if (denied) {
      return { denied: true, byRule: { id: rule.id, name: rule.name, scope: rule.scope } };
    }
  }

  return { denied: false };
}

export type DecideInput = EvaluateInput;
export type DecideResult<T> = { value: T | null; byRule?: RuleRef };

/**
 * Like evaluate, but for rule kinds that answer with a value rather than a
 * verdict: the first rule producing something other than null wins. Scope
 * order is the same, so a tenant rule is consulted only when platform and
 * region rules declined to decide.
 */
export async function decide<T>(tx: Tx, input: DecideInput): Promise<DecideResult<T>> {
  const rules = await load(tx, input);

  for (const rule of rules) {
    let value: unknown;
    try {
      value = jsonLogic.apply(rule.document as never, input.context);
    } catch (err) {
      console.error(`rules: ${input.kind} rule ${rule.id} (${rule.name}) threw, skipping`, err);
      continue;
    }
    if (value !== null && value !== undefined) {
      return { value: value as T, byRule: { id: rule.id, name: rule.name, scope: rule.scope } };
    }
  }

  return { value: null };
}

function load(tx: Tx, input: EvaluateInput): Promise<RuleRow[]> {
  return tx<RuleRow[]>`
    select * from rules
    where kind = ${input.kind}
      and enabled
      and (
        scope = 'platform'
        or (scope = 'region' and region = ${input.region})
        or (scope = 'tenant' and tenant_id = ${input.tenantId})
      )
    order by case scope when 'platform' then 0 when 'region' then 1 else 2 end,
             created_at,
             id
  `;
}

/** Rules this tenant may see: platform, region and its own. */
export async function listForTenant(tx: Tx): Promise<RuleRow[]> {
  return tx<RuleRow[]>`
    select * from rules
    order by case scope when 'platform' then 0 when 'region' then 1 else 2 end,
             created_at,
             id
  `;
}

export async function createTenantRule(
  tx: Tx,
  input: { tenantId: string; kind: string; name: string; document: unknown },
): Promise<RuleRow> {
  const [row] = await tx<RuleRow[]>`
    insert into rules (scope, tenant_id, kind, name, document)
    values ('tenant', ${input.tenantId}, ${input.kind}, ${input.name},
            ${tx.json(input.document as never)})
    returning *
  `;
  if (!row) throw new Error('rules.createTenantRule inserted no row');
  return row;
}

/** Deletes only the tenant's own rule; the RLS policy blocks anything else. */
export async function deleteTenantRule(tx: Tx, id: string): Promise<boolean> {
  const deleted = await tx`delete from rules where id = ${id}`;
  return deleted.count > 0;
}
