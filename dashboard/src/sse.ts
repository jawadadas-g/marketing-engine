/**
 * A Server-Sent Events reader over fetch.
 *
 * `EventSource` would reconnect for free, but it can only deliver frames whose
 * `event:` name you already listen for — and the engine names every frame after
 * its event type. Using it would mean keeping a copy of the engine's event
 * types in the browser, which would silently drop any type added later.
 *
 * So: read the stream, parse the frames, and do the reconnect by hand. The
 * reconnect sends `Last-Event-ID`, which the engine answers by replaying what
 * was missed before going live.
 */
export type SseFrame = { id: string | null; event: string; data: string };

export type SseHandle = { close: () => void };

export function openStream(
  url: string,
  handlers: {
    onFrame: (frame: SseFrame) => void;
    onOpen?: () => void;
    onClosed?: () => void;
  },
): SseHandle {
  const controller = new AbortController();
  let lastEventId: string | null = null;
  let stopped = false;
  let retryMs = 1000;

  const run = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await fetch(url, {
          headers: {
            Accept: 'text/event-stream',
            ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
          },
          signal: controller.signal,
        });

        if (!res.ok || !res.body) throw new Error(`stream answered ${res.status}`);

        handlers.onOpen?.();
        retryMs = 1000;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Frames are separated by a blank line.
          let split = buffer.indexOf('\n\n');
          while (split !== -1) {
            const raw = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const frame = parseFrame(raw);
            if (frame) {
              if (frame.id) lastEventId = frame.id;
              handlers.onFrame(frame);
            }
            split = buffer.indexOf('\n\n');
          }
        }
      } catch {
        if (stopped) return;
      }

      handlers.onClosed?.();
      if (stopped) return;

      // Back off, but never so far that a dashboard looks dead for minutes.
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 15_000);
    }
  };

  void run();

  return {
    close: () => {
      stopped = true;
      controller.abort();
    },
  };
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | null = null;
  let event = 'message';
  const data: string[] = [];

  for (const line of raw.split('\n')) {
    // A line starting with a colon is a comment; the heartbeat is one.
    if (line.startsWith(':') || line === '') continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');

    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}
