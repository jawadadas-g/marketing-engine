import { useState } from 'preact/hooks';
import { api, type CompanyRow } from '../api.js';
import { Badge, Card, Empty, Failed, Field, Loading, Pager, Stamp, Text, Time, useAsync } from '../ui/index.js';

export function CompaniesView({
  q,
  country,
  onFilters,
}: {
  q: string;
  country: string;
  onFilters: (next: { q: string; country: string }) => void;
}) {
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const page = useAsync(
    async () => {
      const result = await api.companies({ q, country, cursor, limit: 100 });
      setRows((current) => (cursor ? [...current, ...result.items] : result.items));
      return result;
    },
    [q, country, cursor],
  );

  return (
    <>
      <div class="head">
        <h2>Companies</h2>
        <span class="muted">the shared prospect pool</span>
        <Stamp at={page.loadedAt} />
      </div>

      <div class="filters">
        <Field label="name">
          <Text
            value={q}
            placeholder="trigram search"
            width={220}
            onChange={(v) => { setCursor(undefined); onFilters({ q: v, country }); }}
          />
        </Field>
        <Field label="country">
          <Text value={country} placeholder="SA" width={60} onChange={(v) => { setCursor(undefined); onFilters({ q, country: v }); }} />
        </Field>
      </div>

      <Card>
        {page.state.status === 'loading' && rows.length === 0 ? <Loading what="companies" /> : null}
        {page.state.status === 'error' ? <Failed error={page.state.error} what="companies" /> : null}
        {page.state.status === 'ok' && rows.length === 0 ? <Empty what="companies" /> : null}

        {rows.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>name</th>
                <th>country</th>
                <th>buys</th>
                <th>sector</th>
                <th>city</th>
                <th>on platform</th>
                <th>added</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.country ?? <span class="muted">—</span>}</td>
                  <td class="muted">{c.buys?.join(', ') || '—'}</td>
                  <td class="muted">{c.sector ?? '—'}</td>
                  <td class="muted">{c.city ?? '—'}</td>
                  <td>{c.onPlatformRef ? <Badge value="accepted" /> : <span class="muted">prospect</span>}</td>
                  <td>
                    <Time iso={c.createdAt} relative />
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
