import { getApiKey } from './client';

const API_BASE = import.meta.env.VITE_API_URL ?? '';
const RECONNECT_MS = 250;

export interface SseFrame {
  id?: string;
  event: string;
  data: string;
}

/**
 * Hand-rolled SSE client over fetch(), not the native EventSource.
 *
 * EventSource cannot set custom request headers, and every kernel route
 * except /v1/health requires a Bearer token (kernel/src/api/app.ts's
 * onRequest hook has no exemption for /v1/events). Since kernel/ is out of
 * bounds for this task, the workaround lives entirely here: fetch with an
 * Authorization header, read the body as a stream, and parse the SSE
 * text/event-stream framing by hand. Reconnects with a fixed backoff
 * (opencode's pattern uses a generation counter; a fixed 250ms delay covers
 * a demo without that bookkeeping).
 */
export function subscribeToEvents(
  onFrame: (frame: SseFrame) => void,
  opts: { since?: string } = {},
): () => void {
  let closed = false;
  let controller: AbortController | null = null;

  async function connect(): Promise<void> {
    if (closed) return;
    controller = new AbortController();
    const qs = opts.since ? `?since=${encodeURIComponent(opts.since)}` : '';
    try {
      const key = getApiKey();
      const headers: Record<string, string> = { Accept: 'text/event-stream' };
      if (key) headers.Authorization = `Bearer ${key}`;

      const res = await fetch(`${API_BASE}/v1/events${qs}`, { headers, signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`SSE connect failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const frame = parseFrame(rawFrame);
          if (frame) onFrame(frame);
        }
      }
    } catch (err) {
      if (closed || (err instanceof DOMException && err.name === 'AbortError')) return;
    }
    if (!closed) setTimeout(connect, RECONNECT_MS);
  }

  connect();

  return () => {
    closed = true;
    controller?.abort();
  };
}

function parseFrame(raw: string): SseFrame | null {
  let id: string | undefined;
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat comment
    if (line.startsWith('id:')) id = line.slice(3).trim();
    else if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;
  return { id, event, data: dataLines.join('\n') };
}
