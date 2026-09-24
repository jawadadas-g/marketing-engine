/**
 * Campaigns: stored contacts, named audiences, and sends to an audience later.
 *
 * A campaign is a scheduler and a recipient list, nothing more. Every
 * recipient goes out through messaging.send(), so consent, rules, channel
 * selection, templates, fallback and the event log apply exactly as they do
 * to a single send.
 */
export * from './audiences.js';
export * from './campaigns.js';
export * from './contacts.js';
export { CronError, nextOccurrence, parseCron } from './cron.js';
export { CampaignError } from './errors.js';
export {
  POISON_ATTEMPTS,
  processBatch,
  runCampaign,
  type BatchJob,
  type BatchOutcome,
  type RunJob,
} from './worker.js';
export { SWEEP_CRON, SWEEP_JOB, sweepRuns, type SweepAction } from './sweep.js';
export { WINDOW_HORIZON_DAYS, WINDOW_STEP_MINUTES, windowStats } from './window.js';
