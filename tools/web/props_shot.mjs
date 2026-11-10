// Headless screenshots of review/props-review.html.
// node props_shot.mjs <page.html> <outDir> [shot ...]   shot = overview | group:<name> | focus:<prop> | mobile
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
const [page, outDir, ...shots] = process.argv.slice(2);
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); await p.setViewport({ width: 1600, height: 1000 });
const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto('file://' + path.resolve(page), { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction('window.SB_READY === true', { timeout: 240000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
const list = shots.length ? shots : ['overview', ...(await p.evaluate(() => window.SB_GROUPS())).map((g) => 'group:' + g)];
for (const s of list) {
  const [kind, arg] = s.split(/:(.*)/s);
  if (kind === 'mobile') { await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 }); await p.evaluate(() => window.SB_OVERVIEW()); }
  else if (kind === 'overview') await p.evaluate(() => window.SB_OVERVIEW());
  else if (kind === 'group') await p.evaluate((g) => window.SB_GROUP(g), arg);
  else if (kind === 'focus') await p.evaluate((n) => window.SB_FOCUS(n), arg);
  await wait(1500);
  const f = path.join(outDir, `props_${s.replace(/[^a-z0-9_-]+/gi, '_')}.png`);
  await p.screenshot({ path: f }); console.log('saved', f);
  if (kind === 'mobile') await p.setViewport({ width: 1600, height: 1000 });
}
console.log('stats', JSON.stringify(await p.evaluate(() => window.SB_STATS)));
console.log('errors', JSON.stringify(errs.slice(0, 6))); await b.close();
