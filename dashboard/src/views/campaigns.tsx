import { useState } from 'preact/hooks';
import { api, type CampaignDetail, type CampaignRow, type CampaignRun, type RecipientRow } from '../api.js';
import { count } from '../format.js';
import { href } from '../router.js';
import {
  Badge,
  Card,
  Empty,
  Failed,
  Field,
  Loading,
  Pager,
  Progress,
  Select,
  Stamp,
  Text,
  Time,
  useAsync,
} from '../ui/index.js';

const STATUSES = ['draft', 'scheduled', 'running', 'paused', 'done', 'cancelled', 'failed'];
const RECIPIENT_STATES = ['pending', 'queued', 'blocked', 'skipped'];

export function CampaignsView({
  tenantId,
  status,
  onFilters,
}: {
  tenantId: string;
  status: string;
  onFilters: (next: { tenantId: string; status: string }) => void;
}) {
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const set = (patch: Partial<{ tenantId: string; status: string }>) => {
    setCursor(undefined);
    onFilters({ tenantId, status, ...patch });
  };

  // Polled: a running campaign's counts move while you watch.
  const page = useAsync(
    async () => {
      const result = await api.campaigns({ tenantId, status, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [tenantId, status, cursor],
    cursor ? undefined : 5_000,
  );

  return (
    <>
      <div class="head">
        <h2>Campaigns</h2>
        <Stamp at={page.loadedAt} />
      </div>

      <div class="filters">
        <Field label="tenant id">
          <Text value={tenantId} placeholder="any" width={290} onChange={(v) => set({ tenantId: v })} />
        </Field>
        <Field label="status">
          <Select value={status} options={STATUSES} onChange={(v) => set({ status: v })} />
        </Field>
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="campaigns" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="campaigns" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="campaigns" /> : null}

        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>campaign</th>
                <th>tenant</th>
                <th>status</th>
                <th>next run</th>
                <th>last run</th>
                <th class="num">queued</th>
                <th class="num">blocked</th>
                <th class="num">skipped</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  class="clickable"
                  onClick={() => {
                    window.location.hash = href(`/campaigns/${c.id}`).slice(1);
                  }}
                >
                  <td>
                    {c.name}
                    <div class="muted">
                      {c.audienceName} · {c.purpose}
                      {c.recurrence ? ` · ${c.recurrence.cron}` : ''}
                    </div>
                  </td>
                  <td>{c.tenantName}</td>
                  <td>
                    <Badge value={c.status} />
                  </td>
                  <td>
                    <Time iso={c.nextRunAt} relative />
                  </td>
                  <td>
                    {c.lastRun ? (
                      <>
                        #{c.lastRun.runNo} <Badge value={c.lastRun.status} />
                        <div>
                          <RunProgress run={c.lastRun} />
                        </div>
                      </>
                    ) : (
                      <span class="muted">—</span>
                    )}
                  </td>
                  <td class="num">{count(c.lastRun?.queued)}</td>
                  <td class="num">{count(c.lastRun?.blocked)}</td>
                  <td class="num">{count(c.lastRun?.skipped)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}

        <Pager
          cursor={page.state.status === 'ok' ? page.state.data.nextCursor : null}
          onMore={() => setCursor(page.state.status === 'ok' ? (page.state.data.nextCursor ?? undefined) : undefined)}
        />
      </Card>
    </>
  );
}

/** Recipients the run has decided, out of the audience it snapshotted. */
function RunProgress({ run }: { run: CampaignRun }) {
  return <Progress done={run.queued + run.blocked + run.skipped} total={run.audienceSize} />;
}

export function CampaignDetailView({ id }: { id: string }) {
  const { state, loadedAt } = useAsync<CampaignDetail>(() => api.campaign(id), [id], 5_000);
  const [runId, setRunId] = useState<string | null>(null);
  const [recipientState, setRecipientState] = useState('');

  if (state.status === 'loading') return <Loading what="the campaign" />;
  if (state.status === 'error') return <Failed error={state.error} what="the campaign" />;

  const { campaign: c, runs } = state.data;
  const selected = runs.find((r) => r.id === runId) ?? runs[0] ?? null;

  return (
    <>
      <div class="head">
        <h2>{c.name}</h2>
        <Badge value={c.status} />
        <span class="mono muted">{c.id}</span>
        <Stamp at={loadedAt} />
      </div>

      <div class="cards">
        <Card title="campaign">
          <table>
            <tbody>
              <Row k="tenant">
                <a href={href(`/tenants/${c.tenantId}`)}>{c.tenantName}</a>
              </Row>
              <Row k="audience">
                {c.audienceName} <span class="muted">({c.audienceKind})</span>
              </Row>
              <Row k="template">{c.template}</Row>
              <Row k="channel">{c.channel ?? <span class="muted">chosen per recipient</span>}</Row>
              <Row k="purpose">{c.purpose}</Row>
              <Row k="throttle">{c.throttlePerMinute} / minute</Row>
              <Row k="schedule">
                {c.recurrence ? (
                  <span class="mono">
                    {c.recurrence.cron} ({c.timezone})
                    {c.recurrence.maxRuns ? `, at most ${c.recurrence.maxRuns} runs` : ''}
                  </span>
                ) : (
                  <>one-shot</>
                )}
              </Row>
              <Row k="next run">
                <Time iso={c.nextRunAt} />
              </Row>
              <Row k="created">
                <Time iso={c.createdAt} />
              </Row>
            </tbody>
          </table>
        </Card>

        <Card title="runs" wide>
          {runs.length === 0 ? (
            <Empty what="runs yet" />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>run</th>
                  <th>status</th>
                  <th>started</th>
                  <th>finished</th>
                  <th>progress</th>
                  <th class="num">queued</th>
                  <th class="num">blocked</th>
                  <th class="num">skipped</th>
                  <th class="num">pending</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    class="clickable"
                    aria-selected={selected?.id === r.id ? 'true' : undefined}
                    onClick={() => setRunId(r.id)}
                  >
                    <td>#{r.runNo}</td>
                    <td>
                      <Badge value={r.status} />
                      {r.error ? <div class="muted">{r.error}</div> : null}
                    </td>
                    <td>
                      <Time iso={r.startedAt} />
                    </td>
                    <td>
                      <Time iso={r.finishedAt} />
                    </td>
                    <td>
                      <RunProgress run={r} />
                    </td>
                    <td class="num">{count(r.queued)}</td>
                    <td class="num">{count(r.blocked)}</td>
                    <td class="num">{count(r.skipped)}</td>
                    <td class="num">{count(r.pending)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {selected ? (
          <Card title={`recipients of run #${selected.runNo}`} wide>
            <div class="filters">
              <Field label="state">
                <Select value={recipientState} options={RECIPIENT_STATES} onChange={setRecipientState} />
              </Field>
            </div>
            <Recipients key={`${selected.id}:${recipientState}`} campaignId={c.id} runId={selected.id} state={recipientState} />
          </Card>
        ) : null}
      </div>
    </>
  );
}

function Recipients({ campaignId, runId, state: filter }: { campaignId: string; runId: string; state: string }) {
  const [rows, setRows] = useState<RecipientRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const page = useAsync(
    async () => {
      const result = await api.recipients(campaignId, runId, { state: filter, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [campaignId, runId, filter, cursor],
  );

  return (
    <>
      {page.state.status === 'loading' && rows.length === 0 ? <Loading what="recipients" /> : null}
      {page.state.status === 'error' ? <Failed error={page.state.error} what="recipients" /> : null}
      {page.state.status === 'ok' && rows.length === 0 ? <Empty what="recipients" /> : null}

      {rows.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>contact</th>
              <th>address</th>
              <th>state</th>
              <th>why</th>
              <th>message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.name ?? <span class="muted">—</span>}</td>
                <td class="mono wrap-any">{r.phone ?? r.email ?? r.telegram}</td>
                <td>
                  <Badge value={r.state} />
                </td>
                <td>{r.reason ?? <span class="muted">—</span>}</td>
                <td>
                  {r.messageId ? (
                    <a href={href(`/messages/${r.messageId}`)}>
                      {r.channel} · {r.messageStatus}
                    </a>
                  ) : (
                    <span class="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <Pager
        cursor={page.state.status === 'ok' ? page.state.data.nextCursor : null}
        onMore={() => setCursor(page.state.status === 'ok' ? (page.state.data.nextCursor ?? undefined) : undefined)}
      />
    </>
  );
}

function Row({ k, children }: { k: string; children: preact.ComponentChildren }) {
  return (
    <tr>
      <td class="muted" style="width:120px">
        {k}
      </td>
      <td>{children}</td>
    </tr>
  );
}
