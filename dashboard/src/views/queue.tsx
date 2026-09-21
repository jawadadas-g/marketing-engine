import { useState } from 'preact/hooks';
import { api, type JobRow, type ScheduleRow } from '../api.js';
import { cronToText } from '../format.js';
import { Badge, Card, Empty, Failed, Field, Loading, Pager, Select, Stamp, Text, Time, useAsync } from '../ui/index.js';

const STATES = ['created', 'active', 'retry', 'completed', 'cancelled', 'failed'];

export function QueueView({
  name,
  state: jobState,
  onFilters,
}: {
  name: string;
  state: string;
  onFilters: (next: { name: string; state: string }) => void;
}) {
  const [pages, setPages] = useState<JobRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const jobs = useAsync(
    async () => {
      const page = await api.jobs({ name, state: jobState, cursor, limit: 100 });
      setPages((current) => (cursor ? [...current, ...page.items] : page.items));
      return page;
    },
    [name, jobState, cursor],
  );

  const schedules = useAsync<{ schedules: ScheduleRow[] }>(() => api.schedules(), []);

  const retry = async (id: string) => {
    setBusy(id);
    try {
      await api.retryJob(id);
      const { job } = await api.job(id);
      setPages((current) => current.map((row) => (row.id === id ? job : row)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div class="head">
        <h2>Queue</h2>
        <Stamp at={jobs.loadedAt} />
      </div>

      <div class="filters">
        <Field label="job">
          <Text value={name} placeholder="any" onChange={(v) => { setCursor(undefined); onFilters({ name: v, state: jobState }); }} />
        </Field>
        <Field label="state">
          <Select value={jobState} options={STATES} onChange={(v) => { setCursor(undefined); onFilters({ name, state: v }); }} />
        </Field>
      </div>

      <Card>
        {jobs.state.status === 'loading' && pages.length === 0 ? <Loading what="jobs" /> : null}
        {jobs.state.status === 'error' ? <Failed error={jobs.state.error} what="jobs" /> : null}
        {jobs.state.status === 'ok' && pages.length === 0 ? <Empty what="jobs" /> : null}

        {pages.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>job</th>
                <th>state</th>
                <th class="num">try</th>
                <th>tenant</th>
                <th>created</th>
                <th>completed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pages.map((job) => (
                <>
                  <tr key={job.id} class="clickable" onClick={() => setExpanded(expanded === job.id ? null : job.id)}>
                    <td class="mono">{job.name}</td>
                    <td>
                      <Badge value={job.state} />
                    </td>
                    <td class="num">
                      {job.retryCount}/{job.retryLimit}
                    </td>
                    <td>{job.tenantName ?? <span class="muted">—</span>}</td>
                    <td>
                      <Time iso={job.createdOn} relative />
                    </td>
                    <td>
                      <Time iso={job.completedOn} relative />
                    </td>
                    <td>
                      {job.state === 'failed' ? (
                        <button
                          class="primary"
                          disabled={busy === job.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            void retry(job.id);
                          }}
                        >
                          {busy === job.id ? 'retrying…' : 'retry'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                  {expanded === job.id ? (
                    <tr key={`${job.id}-detail`}>
                      <td colSpan={7}>
                        <pre class="raw">
                          {JSON.stringify({ data: job.data, output: job.output }, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
            </tbody>
          </table>
        ) : null}

        <Pager
          cursor={jobs.state.status === 'ok' ? jobs.state.data.nextCursor : null}
          onMore={() => setCursor(jobs.state.status === 'ok' ? (jobs.state.data.nextCursor ?? undefined) : undefined)}
        />
      </Card>

      <div style="margin-top:12px">
        <Card title="schedules">
          {schedules.state.status === 'ok' ? (
            <table>
              <thead>
                <tr>
                  <th>name</th>
                  <th>cron</th>
                  <th>runs</th>
                  <th>last run</th>
                  <th>outcome</th>
                </tr>
              </thead>
              <tbody>
                {schedules.state.data.schedules.map((s) => (
                  <tr key={s.name}>
                    <td class="mono">{s.name}</td>
                    <td class="mono">{s.cron}</td>
                    <td class="muted">{cronToText(s.cron)}</td>
                    <td>
                      <Time iso={s.lastCompletedOn} relative />
                    </td>
                    <td>
                      <Badge value={s.lastState} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : schedules.state.status === 'error' ? (
            <Failed error={schedules.state.error} what="schedules" />
          ) : (
            <Loading what="schedules" />
          )}
        </Card>
      </div>
    </>
  );
}
