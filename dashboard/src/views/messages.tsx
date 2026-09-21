import { useState } from 'preact/hooks';
import { api, type MessageDetail, type MessageRow } from '../api.js';
import { href } from '../router.js';
import { Badge, Card, Empty, Failed, Field, Loading, Pager, Select, Stamp, Text, Time, useAsync } from '../ui/index.js';

const STATUSES = ['blocked', 'queued', 'sent', 'delivered', 'read', 'failed'];
const CHANNELS = ['sms', 'whatsapp', 'email', 'telegram'];

export type MessageFilters = {
  tenantId: string;
  status: string;
  channel: string;
  provider: string;
  address: string;
  since: string;
  until: string;
};

export function MessagesView({
  filters,
  onFilters,
}: {
  filters: MessageFilters;
  onFilters: (next: MessageFilters) => void;
}) {
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const set = (patch: Partial<MessageFilters>) => {
    setCursor(undefined);
    onFilters({ ...filters, ...patch });
  };

  const page = useAsync(
    async () => {
      const result = await api.messages({ ...filters, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [JSON.stringify(filters), cursor],
  );

  return (
    <>
      <div class="head">
        <h2>Messages</h2>
        <Stamp at={page.loadedAt} />
      </div>

      <div class="filters">
        <Field label="tenant id">
          <Text value={filters.tenantId} placeholder="any" width={290} onChange={(v) => set({ tenantId: v })} />
        </Field>
        <Field label="status">
          <Select value={filters.status} options={STATUSES} onChange={(v) => set({ status: v })} />
        </Field>
        <Field label="channel">
          <Select value={filters.channel} options={CHANNELS} onChange={(v) => set({ channel: v })} />
        </Field>
        <Field label="provider">
          <Text value={filters.provider} placeholder="any" width={110} onChange={(v) => set({ provider: v })} />
        </Field>
        <Field label="address">
          <Text value={filters.address} placeholder="any" width={170} onChange={(v) => set({ address: v })} />
        </Field>
        <Field label="since">
          <Text value={filters.since} placeholder="ISO" width={170} onChange={(v) => set({ since: v })} />
        </Field>
        <Field label="until">
          <Text value={filters.until} placeholder="ISO" width={170} onChange={(v) => set({ until: v })} />
        </Field>
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="messages" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="messages" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="messages" /> : null}

        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>when</th>
                <th>tenant</th>
                <th>channel</th>
                <th>to</th>
                <th>status</th>
                <th>timeline</th>
                <th>company</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} class="clickable" onClick={() => { window.location.hash = href(`/messages/${m.id}`).slice(1); }}>
                  <td>
                    <Time iso={m.createdAt} relative />
                  </td>
                  <td>{m.tenantName}</td>
                  <td>{m.channel}</td>
                  <td class="mono wrap-any">{m.address}</td>
                  <td>
                    <Badge value={m.status} />
                    {m.blockedReason ? <div class="muted">{m.blockedReason}</div> : null}
                  </td>
                  <td class="muted">{m.timeline.map((t) => t.type.replace('message.', '')).join(' → ')}</td>
                  <td>{m.companyName ?? <span class="muted">—</span>}</td>
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

export function MessageDetailView({ id }: { id: string }) {
  const { state } = useAsync<MessageDetail>(() => api.message(id), [id]);

  if (state.status === 'loading') return <Loading what="the message" />;
  if (state.status === 'error') return <Failed error={state.error} what="the message" />;

  const { message: m, events, deliveryReports, fallbackChildren, parent } = state.data;

  return (
    <>
      <div class="head">
        <h2>Message</h2>
        <span class="mono muted">{m.id}</span>
      </div>

      <div class="cards">
        <Card title="message">
          <table>
            <tbody>
              <Row k="tenant">{m.tenantName}</Row>
              <Row k="channel">{m.channel}</Row>
              <Row k="to">
                <span class="mono">{m.address}</span>
              </Row>
              <Row k="purpose">{m.purpose}</Row>
              <Row k="template">{m.template}</Row>
              <Row k="status">
                <Badge value={m.status} />
              </Row>
              {m.blockedReason ? <Row k="blocked because">{m.blockedReason}</Row> : null}
              {m.error ? <Row k="error">{m.error}</Row> : null}
              <Row k="provider">{m.provider ?? '—'}</Row>
              <Row k="provider id">
                <span class="mono">{m.providerMessageId ?? '—'}</span>
              </Row>
              <Row k="company">{m.companyName ?? '—'}</Row>
              <Row k="created">
                <Time iso={m.createdAt} />
              </Row>
            </tbody>
          </table>
        </Card>

        <Card title="timeline">
          {events.length === 0 ? (
            <Empty what="events" />
          ) : (
            <table>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id}>
                    <td>{e.type}</td>
                    <td>
                      <Time iso={e.occurredAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {m.body ? (
          <Card title="body sent" wide>
            <pre class="raw">{m.body}</pre>
          </Card>
        ) : null}

        <Card title="delivery reports, as the provider sent them" wide>
          {deliveryReports.length === 0 ? (
            <Empty what="delivery reports" />
          ) : (
            <pre class="raw">{JSON.stringify(deliveryReports, null, 2)}</pre>
          )}
        </Card>

        {parent || fallbackChildren.length > 0 ? (
          <Card title="fallback" wide>
            {parent ? (
              <p>
                fell back from <a href={href(`/messages/${parent.id}`)}>{parent.channel}</a> (
                {parent.status})
              </p>
            ) : null}
            {fallbackChildren.map((child) => (
              <p key={child.id}>
                fell back to <a href={href(`/messages/${child.id}`)}>{child.channel}</a> (
                {child.status}
                {child.blockedReason ? `, ${child.blockedReason}` : ''})
              </p>
            ))}
          </Card>
        ) : null}
      </div>
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
