import { buildApp } from './app.js';

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? '0.0.0.0';

const app = buildApp();

app
  .listen({ port: PORT, host: HOST })
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`styx kernel api listening on ${HOST}:${PORT}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
