import { db, withTenant } from '../../db/client.js';
import { emit } from '../../spine/events/index.js';
import { enqueueBatch, enqueueRun, getCampaign, type RunRow } from './campaigns.js';
import { finishRun } from './worker.js';

export const SWEEP_JOB = 'campaign.sweep';

/** How often the sweep runs, as a cron. A number to revisit. */
export const SWEEP_CRON = '*/5 * * * *';

/** An expanding run that has not moved for this long has lost its job. */
const EXPANDING_STALL_MS = 10 * 60_000;
/** A sending run with ready recipients that has not moved for this long has lost its batch. */
const SENDING_STALL_MS = 5 * 60_000;

type Candidate = RunRow & { campaign_status: string; ready: number; pending: number };

export type SweepAction = 'resume_expansion' | 'enqueue_batch' | 'finish';

/**
 * `campaign.sweep`: find runs whose job chain died and put them back on it.
 *
 * pg-boss retries a failing campaign job three times and then gives up, and
 * nothing else would ever re-enqueue it: the run would sit `expanding` or
 * `sending` for good, holding one of its tenant's running slots. This reads
 * only the engine's own columns, never pg-boss's tables.
 *
 * It reads across tenants as the owner, then does each run's work inside that
 * run's own tenant scope, so a sweep touching one tenant's run cannot write to
 * another's. Each run it touches gets `last_progress_at = now()`, which gives
 * the job it queued time to work and makes a second sweep a no-op.
 */
export async function sweepRuns(now: Date = new Date()): Promise<{ runId: string; action: SweepAction }[]> {
  const candidates = await db()<Candidate[]>`
    select r.*, c.status as campaign_status,
           (select count(*)::int from campaign_recipients p
            where p.run_id = r.id and p.state = 'pending'
              and (p.not_before is null or p.not_before <= ${now})) as ready,
           (select count(*)::int from campaign_recipients p
            where p.run_id = r.id and p.state = 'pending') as pending
    from campaign_runs r
    join campaigns c on c.id = r.campaign_id and c.tenant_id = r.tenant_id
    where r.status in ('expanding', 'sending')
  `;

  const touched: { runId: string; action: SweepAction }[] = [];

  for (const run of candidates) {
    const idle = now.getTime() - run.last_progress_at.getTime();

    let action: SweepAction | null = null;
    if (run.status === 'expanding') {
      if (idle > EXPANDING_STALL_MS && ['scheduled', 'running'].includes(run.campaign_status)) {
        action = 'resume_expansion';
      }
    } else if (run.campaign_status === 'running') {
      if (run.pending === 0) action = 'finish';
      else if (run.ready > 0 && idle > SENDING_STALL_MS) action = 'enqueue_batch';
    }
    if (!action) continue;

    const chosen = action;
    await withTenant(run.tenant_id, async (tx) => {
      const campaign = await getCampaign(tx, run.campaign_id);
      if (!campaign) return;

      if (chosen === 'resume_expansion') await enqueueRun(tx, campaign, run.run_no, now);
      else if (chosen === 'enqueue_batch') await enqueueBatch(tx, run);
      else await finishRun(tx, campaign, run.id);

      await tx`update campaign_runs set last_progress_at = now() where id = ${run.id}`;
      await emit(tx, {
        tenantId: run.tenant_id,
        type: 'campaign.run.recovered',
        subjectType: 'campaign',
        subjectId: run.campaign_id,
        payload: { runId: run.id, runNo: run.run_no, action: chosen },
      });
    });
    touched.push({ runId: run.id, action: chosen });
  }

  return touched;
}
