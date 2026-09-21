import { useState } from 'preact/hooks';
import { api, type Metrics } from '../api.js';
import { LineChart } from '../ui/chart.js';
import { Card, Failed, Loading, Stamp, useAsync } from '../ui/index.js';

/**
 * Three charts, each mapping one-to-one onto the metrics endpoint's parameters.
 * Nothing is aggregated here: the series the API returns are the series drawn.
 */
type Spec = {
  title: string;
  series: 'messages' | 'events' | 'redemptions';
  bucket: 'hour' | 'day';
  window: string;
  groupBy?: 'status' | 'channel' | 'type';
};

const CHARTS: Spec[] = [
  { title: 'messages by status, hourly', series: 'messages', bucket: 'hour', window: '7d', groupBy: 'status' },
  { title: 'events by type, daily', series: 'events', bucket: 'day', window: '30d', groupBy: 'type' },
  { title: 'redemptions by status, daily', series: 'redemptions', bucket: 'day', window: '30d', groupBy: 'status' },
];

export function MetricsView() {
  return (
    <>
      <div class="head">
        <h2>Metrics</h2>
      </div>
      <div class="cards">
        {CHARTS.map((spec) => (
          <Chart key={spec.title} spec={spec} />
        ))}
      </div>
    </>
  );
}

function Chart({ spec }: { spec: Spec }) {
  const [bucket, setBucket] = useState(spec.bucket);
  const [window, setWindow] = useState(spec.window);

  const { state, loadedAt } = useAsync<Metrics>(
    () =>
      api.metrics({
        series: spec.series,
        bucket,
        window,
        ...(spec.groupBy ? { groupBy: spec.groupBy } : {}),
      }),
    [spec.series, bucket, window],
  );

  return (
    <Card wide>
      <div class="head" style="margin-bottom:6px">
        <h3 style="margin:0;font-size:12px;text-transform:uppercase;letter-spacing:0.06em;color:var(--ink-muted)">
          {spec.title}
        </h3>
        <div class="chips">
          {(['hour', 'day'] as const).map((b) => (
            <button key={b} class="chip" aria-pressed={b === bucket} onClick={() => setBucket(b)}>
              {b}
            </button>
          ))}
          {['24h', '7d', '30d'].map((w) => (
            <button key={w} class="chip" aria-pressed={w === window} onClick={() => setWindow(w)}>
              {w}
            </button>
          ))}
        </div>
        <Stamp at={loadedAt} />
      </div>

      {state.status === 'loading' ? <Loading what={spec.title} /> : null}
      {state.status === 'error' ? <Failed error={state.error} what={spec.title} /> : null}
      {state.status === 'ok' ? <LineChart series={state.data.series} label={spec.title} /> : null}
    </Card>
  );
}
