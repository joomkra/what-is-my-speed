// Regenerates docs/screenshots/*.png from demo data.
//
//   npm run screenshots
//
// Needs Google Chrome or Chromium (set CHROME_PATH if it isn't /usr/bin/google-chrome).
// Uses a throw-away database with fictional servers, a dummy speedtest binary (so no real
// test can run), and fake network details, so nothing about this machine ends up in the images.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs', 'screenshots');
const chrome = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const port = Number(process.env.SCREENSHOT_PORT) || 3199;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wims-demo-'));
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), SPEEDTEST_BIN: '/bin/false', AUTH_PASSWORD: '' };
execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/demo-seed.mjs'], { cwd: root, env, stdio: 'inherit' });

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], { cwd: root, env, stdio: 'ignore' });
const cleanup = () => { server.kill(); fs.rmSync(dataDir, { recursive: true, force: true }); };
process.on('exit', cleanup);

for (let i = 0; i < 50; i++) {
  try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* starting */ }
  await sleep(200);
}

const FAKE_NETWORK = {
  hostname: 'what-is-my-speed',
  inContainer: true, // as if run with host networking, so the VPN interface is visible
  interfaces: [
    { name: 'eth0', internal: false, defaultRoute: true, mac: '02:42:ac:11:00:02', addresses: [{ family: 'IPv4', address: '172.17.0.2', cidr: '172.17.0.2/16' }] },
    { name: 'wg0', internal: false, defaultRoute: false, mac: null, addresses: [{ family: 'IPv4', address: '10.8.0.2', cidr: '10.8.0.2/24' }] },
    { name: 'lo', internal: true, defaultRoute: false, mac: null, addresses: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8' }, { family: 'IPv6', address: '::1', cidr: '::1/128' }] },
  ],
  lastTest: { ts: Date.now() - 6 * 60e3, externalIp: '203.0.113.42', isp: 'Example Fiber Co.', interface: 'eth0', internalIp: '172.17.0.2', isVpn: false },
};

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'] });

async function open(prefs, urlPath = '/', height = 960, ready = '#profileRows tr, #profileGrid .pcard') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', (req) => (req.url().endsWith('/api/network')
    ? req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(FAKE_NETWORK) })
    : req.continue()));
  await page.evaluateOnNewDocument((p) => { for (const [k, v] of Object.entries(p)) localStorage.setItem(k, v); }, prefs);
  await page.goto(base + urlPath, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(ready, { timeout: 15000 });
  await page.evaluate(() => document.fonts.ready);
  await sleep(1800); // charts animate, version check answers
  return page;
}
const unstick = (p) => p.addStyleTag({ content: 'header.top{position:static !important}' });
const cardOf = async (p, sel) => (await p.$(sel)).evaluateHandle((el) => el.closest('.card'));

// theme is stored raw; the other keys are JSON
const light = { theme: 'light', range: '"7d"', chartMode: '"overview"', selectedProfiles: '[]' };
const dark = { ...light, theme: 'dark', range: '"24h"' };

let p = await open(light);
await p.screenshot({ path: `${outDir}/01-dashboard.png` });
await unstick(p);
const card = await cardOf(p, '#measRows');
const box = await card.boundingBox();
const scrollY = await p.evaluate(() => window.scrollY);
await p.screenshot({ path: `${outDir}/04-measurements.png`, clip: { x: box.x, y: box.y + scrollY, width: box.width, height: Math.min(box.height, 980) }, captureBeyondViewport: true });
await p.close();

p = await open({ ...light, chartMode: '"server"', chartMetric: '"download_mbps"' });
await unstick(p);
await (await cardOf(p, '#historyChart')).screenshot({ path: `${outDir}/02-history-by-server.png` });
await p.close();

p = await open(dark);
await p.screenshot({ path: `${outDir}/03-dashboard-dark.png` });
await p.close();

p = await open(light, '/#profiles');
await p.screenshot({ path: `${outDir}/05-profiles.png` });
await p.close();

// editor for "VPN tunnel": rotate strategy + its own thresholds; taller window so it all fits
p = await open(light, '/#profiles', 1720);
await (await p.$$('[data-edit]'))[2].click();
await p.waitForSelector('.modal');
await sleep(600);
await p.screenshot({ path: `${outDir}/06-profile-editor.png` });
await p.close();

p = await open(light, '/#settings', 1180, '.net-summary');
await p.screenshot({ path: `${outDir}/07-settings.png` });
await p.close();

await browser.close();
console.log(`Screenshots written to ${path.relative(root, outDir)}/`);
process.exit(0);
