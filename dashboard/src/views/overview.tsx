import { api, type Overview } from '../api.js';
import { count } from '../format.js';
import { href } from '../router.js';
import { Badge, Card, Failed, Loading, Stamp, Stat, useAsync } from '../ui/index.js';

const WINDOWS = ['24h', '7d', '30d'];
const STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'blocked'] as const;

export function OverviewView({ window: w, onWindow }: { window: string; onWindow: (v: string) => void }) {
  const { state, loadedAt } = useAsync<Overview>(() => api.overview(w), [w], 10_000);

  return (
    <>
      <div class="head">
        <h2>Overview</h2>
        <div class="chips">
          {WINDOWS.map((option) => (
            <button
              key={option}
              class="chip"
              aria-pressed={option === w}
              onClick={() => onWindow(option)}
            >
              {option}
            </button>
          ))}
        </div>
        <Stamp at={loadedAt} />
      </div>

      {state.status === 'loading' ? <Loading what="the overview" /> : null}
      {state.status === 'error' ? <Failed error={state.error} what="the overview" /> : null}
      {state.status === 'ok' ? <Sections data={state.data} /> : null}
    </>
  );
}

function Sections({ data }: { data: Overview }) {
  return (
    <div class="cards">
      <Card title="messages">
        <div class="stat-row">
          {STATUSES.map((s) => (
            <Stat key={s} label={s} value={count(data.messages[s] ?? 0)} />
          ))}
        </div>
      </Card>

      <Card title="health">
        <div class="stat-row">
          <Stat label="database" value={<Badge value={data.health.db ? 'active' : 'failed'} />} />
          <Stat label="queue" value={<span style="font-size:13px">{data.health.boss}</span>} />
          <Stat label="version" value={<span style="font-size:13px">{data.health.version}</span>} />
        </div>
      </Card>

      <Card title="webhooks">
        <div class="stat-row">
          <Stat label="pending" value={count(data.webhooks.pending ?? 0)} />
          <Stat label="failed" value={count(data.webhooks.failed ?? 0)} />
        </div>
      </Card>

      <Card title="reservations">
        <div class="stat-row">
          <Stat label="open" value={count(data.reservations.open)} />
          <Stat label="expiring 15m" value={count(data.reservations.expiringWithin15m)} />
        </div>
      </Card>

      <Card title="discovery">
        <div class="stat-row">
          <Stat label="searches" value={count(data.discovery.searches)} />
          <Stat label="invites from search" value={count(data.discovery.invitesFromSearch)} />
        </div>
      </Card>

      <Card title="why messages were blocked" wide>
        {Object.keys(data.blockedReasons).length === 0 ? (
          <p class="muted">nothing blocked in this window</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>reason</th>
                <th class="num">count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.blockedReasons)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, n]) => (
                  <tr key={reason}>
                    <td>{reason}</td>
                    <td class="num">{count(n)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="queue" wide>
        <table>
          <thead>
            <tr>
              <th>job</th>
              <th class="num">waiting</th>
              <th class="num">active</th>
              <th class="num">retry</th>
              <th class="num">failed</th>
              <th class="num">completed in window</th>
            </tr>
          </thead>
          <tbody>
            {data.queue.map((q) => (
              <tr key={q.name}>
                <td class="mono">{q.name}</td>
                <td class="num">{count(q.created)}</td>
                <td class="num">{count(q.active)}</td>
                <td class="num">{count(q.retry)}</td>
                <td class="num">
                  {q.failed > 0 ? (
                    <a href={href('/queue', { name: q.name, state: 'failed' })}>{count(q.failed)}</a>
                  ) : (
                    <span class="zero">0</span>
                  )}
                </td>
                <td class="num">{count(q.completedInWindow)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="tenants" wide>
        <table>
          <thead>
            <tr>
              <th>tenant</th>
              <th class="num">sent</th>
              <th class="num">delivered</th>
              <th class="num">failed</th>
              <th class="num">blocked</th>
              <th class="num">invites</th>
              <th class="num">redemptions</th>
              <th class="num">webhook failures</th>
            </tr>
          </thead>
          <tbody>
            {[...data.tenants]
              .sort((a, b) => (b.messages.sent ?? 0) - (a.messages.sent ?? 0))
              .map((t) => (
                <tr key={t.tenantId}>
                  <td>
                    <a href={href(`/tenants/${t.tenantId}`)}>{t.tenantName}</a>
                  </td>
                  <td class="num">{count(t.messages.sent ?? 0)}</td>
                  <td class="num">{count(t.messages.delivered ?? 0)}</td>
                  <td class="num">{count(t.messages.failed ?? 0)}</td>
                  <td class="num">{count(t.messages.blocked ?? 0)}</td>
                  <td class="num">
                    {count(t.invites.sent)} / {count(t.invites.accepted)}
                  </td>
                  <td class="num">
                    {count(t.redemptions.reserved)} / {count(t.redemptions.settled)}
                  </td>
                  <td class="num">{count(t.webhookFailures)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
