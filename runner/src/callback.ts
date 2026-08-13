// The agent-executor half of the AO "ao pipeline done/fail" analogue
// (research/ao-pipelines.md section on settle signals): an agent stage
// settles itself by POSTing here instead of the engine polling a process
// exit code. One tiny endpoint, plain node:http, no framework: this is a
// single route hit by trusted in-fleet agents on localhost, not a public
// API, so it does not need Fastify's auth/validation machinery the kernel
// API has.
import { createServer, type Server } from 'node:http';
import type { Engine } from './engine.js';

export interface CallbackServer {
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}

const SIGNAL_PATH = /^\/v1\/runs\/([^/]+)\/stages\/([^/]+)\/signal$/;

export function startCallbackServer(engine: Engine, port = 0): Promise<CallbackServer> {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url) {
      res.writeHead(404).end();
      return;
    }
    const match = req.url.match(SIGNAL_PATH);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const [, runId, stage] = match;

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        try {
          if (runId !== engine.runId) {
            res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unknown run' }));
            return;
          }
          const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
          await engine.signalStage(stage, { done: Boolean(body.done), reason: typeof body.reason === 'string' ? body.reason : undefined });
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
        }
      })();
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
