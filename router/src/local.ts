import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handler, type HandlerRequest } from './handler.js';
import { ensureSchema } from './db.js';

const PORT = Number(process.env.ROUTER_PORT ?? 8787);
// Webhook sinks require HTTPS; CockroachDB's changefeed hits this endpoint
// directly (insecure_tls_skip_verify=true on the sink URL for a self-signed
// local cert). Plain HTTP still works for router/src/handler.test.ts and
// for a bridge-process fallback.
const TLS_CERT_FILE = process.env.ROUTER_TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.ROUTER_TLS_KEY_FILE;

function requestListener(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    void (async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const request: HandlerRequest = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        body,
      };
      try {
        const result = await handler(request);
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(result.body);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('router handler error', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    })();
  });
}

async function main(): Promise<void> {
  await ensureSchema();

  const server =
    TLS_CERT_FILE && TLS_KEY_FILE
      ? createHttpsServer({ cert: readFileSync(TLS_CERT_FILE), key: readFileSync(TLS_KEY_FILE) }, requestListener)
      : createHttpServer(requestListener);

  server.listen(PORT, () => {
    const scheme = TLS_CERT_FILE && TLS_KEY_FILE ? 'https' : 'http';
    // eslint-disable-next-line no-console
    console.log(
      `styx router listening on ${scheme}://0.0.0.0:${PORT}, forwarding wake-ups to ${process.env.WAKE_URL ?? 'http://localhost:7171/wake'}`,
    );
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
