import { useEffect, useRef, useState } from 'preact/hooks';
import { api, type EventRow } from '../api.js';
import { openStream } from '../sse.js';
import { Badge, Card, Clock } from '../ui/index.js';

const CAP = 500;

type Row = Pick<EventRow, 'id' | 'type' | 'tenantId' | 'tenantName' | 'subjectType' | 'subjectId' | 'occurredAt'>;
type Connection = 'connecting' | 'open' | 'closed';

/**
 * The live feed. Filters go to the server as query parameters rather than being
 * applied here, so a filtered view is not a full firehose being thrown away in
 * the browser.
 */
export function LiveView({
  tenantId,
  type,
  onFilters,
  onDisconnected,
}: {
  tenantId: string;
  type: string;
  onFilters: (next: { tenantId: string; type: string }) => void;
  onDisconnected: (since: number | null) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [paused, setPaused] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [payload, setPayload] = useState<unknown>(null);

  // While paused, events are held rather than dropped: an operator pausing to
  // read something should not lose what happened meanwhile.
  const buffer = useRef<Row[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    setRows([]);
    buffer.current = [];
    setConnection('connecting');

    const stream = openStream(api.streamUrl({ tenantId, type }), {
      onOpen: () => {
        setConnection('open');
        onDisconnected(null);
      },
      onClosed: () => {
        setConnection('closed');
        onDisconnected(Date.now());
      },
      onFrame: (frame) => {
        let row: Row;
        try {
          row = JSON.parse(frame.data) as Row;
        } catch {
          return;
        }
        if (pausedRef.current) {
          buffer.current = [row, ...buffer.current].slice(0, CAP);
          return;
        }
        setRows((current) => [row, ...current].slice(0, CAP));
      },
    });

    return () => {
      stream.close();
      onDisconnected(null);
    };
  }, [tenantId, type]);

  const resume = () => {
    setRows((current) => [...buffer.current, ...current].slice(0, CAP));
    buffer.current = [];
    setPaused(false);
  };

  const open = async (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    setPayload(null);
    const { event } = await api.event(id);
    setPayload(event.payload);
  };

  return (
    <>
      <div class="head">
        <h2>Live</h2>
        <Badge value={connection === 'open' ? 'active' : connection === 'closed' ? 'failed' : 'created'} />
        <span class="muted">{rows.length} shown</span>
        <div class="right">
          {paused ? (
            <button class="primary" onClick={resume}>
              resume ({buffer.current.length} held)
            </button>
          ) : (
            <button onClick={() => setPaused(true)}>pause</button>
          )}
        </div>
      </div>

      <div class="filters">
        <label>
          tenant id
          <input
            value={tenantId}
            placeholder="any"
            style="width:290px"
            onChange={(e) => onFilters({ tenantId: (e.target as HTMLInputElement).value, type })}
          />
        </label>
        <label>
          type
          <input
            value={type}
            placeholder="message.*"
            style="width:160px"
            onChange={(e) => onFilters({ tenantId, type: (e.target as HTMLInputElement).value })}
          />
        </label>
      </div>

      <Card>
        {rows.length === 0 ? (
          <div class="state">waiting for events…</div>
        ) : (
          <div class="feed">
            {rows.map((row) => (
              <div key={row.id}>
                <div class="row" onClick={() => void open(row.id)}>
                  <span class="t">
                    <Clock iso={row.occurredAt} />
                  </span>
                  <span class="ty">{row.type}</span>
                  <span class="muted">
                    {row.tenantName ?? row.tenantId} · {row.subjectType ?? ''} {row.subjectId ?? ''}
                  </span>
                </div>
                {expanded === row.id ? (
                  <pre class="raw">{payload === null ? 'loading…' : JSON.stringify(payload, null, 2)}</pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
