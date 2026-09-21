import { useRef, useState } from 'preact/hooks';
import { localTime } from '../format.js';

/**
 * A line chart, drawn by hand.
 *
 * Form: these are counts over time with several series, which is a line chart.
 * Colour: the validated categorical slots in fixed order, assigned to the
 * series by name so a filter that removes one never repaints the others.
 *
 * The legend is always present and each line is labelled at its end, which is
 * also what the light-mode contrast relief requires: three of the slots sit
 * under 3:1 on the light surface, so identity never rests on colour alone.
 */
export type Series = { key: string; points: [string, number][] };

const SLOTS = 8;

/** Fixed order, never cycled: a ninth series is not drawn. */
export function colourFor(index: number): string {
  return `var(--series-${(index % SLOTS) + 1})`;
}

type Layout = { width: number; height: number; pad: { t: number; r: number; b: number; l: number } };

const LAYOUT: Layout = { width: 860, height: 220, pad: { t: 10, r: 84, b: 22, l: 44 } };

export function LineChart({
  series,
  label,
}: {
  series: Series[];
  label: string;
}) {
  const [hover, setHover] = useState<{ x: number; i: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);

  const drawn = series.slice(0, SLOTS);
  const omitted = series.slice(SLOTS).map((s) => s.key);

  // Every series shares the API's bucket list, so the first one's x-axis is
  // the x-axis.
  const stamps = drawn[0]?.points.map(([t]) => t) ?? [];
  if (stamps.length === 0) return <div class="state">no data in this window</div>;

  const max = Math.max(1, ...drawn.flatMap((s) => s.points.map(([, n]) => n)));
  const { width, height, pad } = LAYOUT;
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;

  const x = (i: number) => pad.l + (stamps.length === 1 ? plotW / 2 : (i / (stamps.length - 1)) * plotW);
  const y = (n: number) => pad.t + plotH - (n / max) * plotH;

  const ticks = [0, Math.round(max / 2), max].filter((v, i, a) => a.indexOf(v) === i);

  // Direct labels only while they can be told apart. Past four they collide
  // into each other and the legend is what carries identity.
  const directLabels = drawn.length <= 4;
  const endLabels = directLabels ? declutter(drawn.map((s) => y(s.points[s.points.length - 1]?.[1] ?? 0))) : [];

  // A series of one or two buckets draws no visible line, so its points get
  // marks. Past a few dozen the marks would be noise.
  const showPoints = stamps.length <= 30;

  const onMove = (event: MouseEvent) => {
    const box = svg.current?.getBoundingClientRect();
    if (!box) return;
    const px = ((event.clientX - box.left) / box.width) * width;
    const i = Math.round(((px - pad.l) / plotW) * (stamps.length - 1));
    if (i < 0 || i >= stamps.length) return setHover(null);
    setHover({ x: x(i), i });
  };

  return (
    <div class="chart-wrap">
      <div class="legend">
        {drawn.map((s, i) => (
          <span class="item" key={s.key}>
            <span class="swatch" style={`background:${colourFor(i)}`} />
            {s.key}
          </span>
        ))}
      </div>

      <svg
        ref={svg}
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        role="img"
        aria-label={label}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.l}
              x2={width - pad.r}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--grid)"
              stroke-width="1"
            />
            <text x={pad.l - 6} y={y(t) + 3} text-anchor="end" font-size="10" fill="var(--ink-muted)">
              {t}
            </text>
          </g>
        ))}

        <line
          x1={pad.l}
          x2={width - pad.r}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--axis)"
          stroke-width="1"
        />

        {[0, Math.floor(stamps.length / 2), stamps.length - 1]
          .filter((v, i, a) => a.indexOf(v) === i)
          .map((i) => (
            <text
              key={i}
              x={x(i)}
              y={height - 6}
              text-anchor={i === 0 ? 'start' : i === stamps.length - 1 ? 'end' : 'middle'}
              font-size="10"
              fill="var(--ink-muted)"
            >
              {shortStamp(stamps[i]!)}
            </text>
          ))}

        {hover ? (
          <line
            x1={hover.x}
            x2={hover.x}
            y1={pad.t}
            y2={pad.t + plotH}
            stroke="var(--axis)"
            stroke-width="1"
          />
        ) : null}

        {drawn.map((s, si) => {
          const d = s.points
            .map(([, n], i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(n).toFixed(1)}`)
            .join(' ');
          const lastIndex = s.points.length - 1;
          const last = s.points[lastIndex];
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={colourFor(si)} stroke-width="2" stroke-linejoin="round" />
              {hover ? (
                <circle
                  cx={x(hover.i)}
                  cy={y(s.points[hover.i]?.[1] ?? 0)}
                  r="4"
                  fill={colourFor(si)}
                  stroke="var(--surface)"
                  stroke-width="2"
                />
              ) : null}
              {showPoints
                ? s.points.map(([stamp, n], i) => (
                    <circle
                      key={stamp}
                      cx={x(i)}
                      cy={y(n)}
                      r="4"
                      fill={colourFor(si)}
                      stroke="var(--surface)"
                      stroke-width="2"
                    />
                  ))
                : null}
              {directLabels && last ? (
                <text
                  x={width - pad.r + 6}
                  y={(endLabels[si] ?? y(last[1])) + 3}
                  font-size="10"
                  fill="var(--ink-2)"
                >
                  {s.key}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {hover ? (
        <div
          class="tip"
          style={`left:${Math.min(88, (hover.x / width) * 100)}%; top:0`}
        >
          <div class="k">{localTime(stamps[hover.i]!)}</div>
          {drawn.map((s, si) => (
            <div key={s.key}>
              <span class="swatch" style={`display:inline-block;width:8px;height:2px;background:${colourFor(si)};margin-right:5px`} />
              {s.key} <b>{s.points[hover.i]?.[1] ?? 0}</b>
            </div>
          ))}
        </div>
      ) : null}

      {omitted.length ? (
        <p class="muted" style="margin:4px 0 0;font-size:11px">
          {omitted.length} more series not drawn ({omitted.join(', ')}). The API returns every
          series; only {SLOTS} can be told apart by colour.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Push overlapping end-labels apart, keeping their order. Two series that end
 * on the same value would otherwise print on top of each other.
 */
function declutter(ys: number[], gap = 12): number[] {
  const order = ys.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  let previous = -Infinity;
  const placed = new Array<number>(ys.length);

  for (const { value, index } of order) {
    const next = Math.max(value, previous + gap);
    placed[index] = next;
    previous = next;
  }
  return placed;
}

function shortStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit' });
}
