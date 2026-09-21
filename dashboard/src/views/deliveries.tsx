import { useState } from 'preact/hooks';
import { api, type DeliveryRow } from '../api.js';
import { Badge, Card, Empty, Failed, Field, Loading, Pager, Select, Stamp, Time, useAsync } from '../ui/index.js';

const STATUSES = ['pending', 'delivered', 'failed'];

export function DeliveriesView({
  status,
  onStatus,
}: {
  status: string;
  onStatus: (v: string) => void;
}) {
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);

  const page = useAsync(
    async () => {
      const result = await api.deliveries({ status, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [status, cursor],
  );

  const replay = async (id: string) => {
    setBusy(id);
    try {
      const { delivery } = await api.replayDelivery(id);
      setRows((current) => current.map((row) => (row.id === id ? { ...row, ...delivery } : row)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div class="head">
        <h2>Webhook deliveries</h2>
        <Stamp at={page.loadedAt} />
      </div>

      <div class="filters">
        <Field label="status">
          <Select value={status} options={STATUSES} onChange={(v) => { setCursor(undefined); onStatus(v); }} />
        </Field>
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="deliveries" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="deliveries" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="deliveries" /> : null}

        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>tenant</th>
                <th>event</th>
                <th>endpoint</th>
                <th>status</th>
                <th class="num">attempt</th>
                <th>last error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Time iso={d.createdAt} relative />
                  </td>
                  <td>{d.tenantName ?? <span class="muted">platform</span>}</td>
                  <td>{d.eventType}</td>
                  <td class="mono wrap-any">{d.url}</td>
                  <td>
                    <Badge value={d.status} />
                  </td>
                  <td class="num">{d.attempt}</td>
                  <td class="muted wrap-any">
                    {d.lastError ?? (d.lastStatusCode ? `HTTP ${d.lastStatusCode}` : '—')}
                  </td>
                  <td>
                    {d.status === 'failed' ? (
                      <button class="primary" disabled={busy === d.id} onClick={() => void replay(d.id)}>
                        {busy === d.id ? 'replaying…' : 'replay'}
                      </button>
                    ) : null}
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
      </Card>
    </>
  );
}
