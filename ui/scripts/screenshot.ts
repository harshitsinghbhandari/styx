// Live-proof capture: opens the running dev console in headless Chromium
// and saves docs/console.png once the DAG and ticker have real rows.
// Not part of the app bundle; devDependency-only per the task brief
// ("playwright as a devDependency solely for the screenshot is acceptable").
import { chromium } from 'playwright';

const url = process.env.SCREENSHOT_URL ?? 'http://localhost:5173';
const out = process.env.SCREENSHOT_OUT ?? new URL('../docs/console.png', import.meta.url).pathname;

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // Not 'networkidle': the app holds an open SSE fetch stream forever
  // (api/sse.ts), so the network never goes idle by design.
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForSelector('.commitment-node', { timeout: 20000 });
  await page.waitForSelector('.ticker-row', { timeout: 20000 });
  await page.waitForTimeout(600); // let dagre settle + fitView animate out
  await page.screenshot({ path: out });
  await browser.close();
  // eslint-disable-next-line no-console
  console.log(`screenshot saved to ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
