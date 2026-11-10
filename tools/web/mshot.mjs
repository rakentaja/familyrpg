// Headless screenshots of the clip review page.
// node mshot.mjs <page.html> <outDir> [shot ...]   shot = single:<clip>[:skel][:travel] | grid[:skel] | mobile:<clip>
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
const [page, outDir, ...shots] = process.argv.slice(2);
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] });
const p = await b.newPage(); await p.setViewport({ width: 1280, height: 800 });
const errs = []; const logs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => (m.type() === 'error' ? errs : logs).push(m.text()));
await p.goto('file://' + path.resolve(page), { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction('window.SB_READY === true', { timeout: 180000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
for (const s of shots.length ? shots : ['single:walk', 'grid']) {
  const [kind, clip, ...flags] = s.split(':');
  if (kind === 'mobile') { // isMobile/hasTouch changes reload the page
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.waitForFunction('window.SB_READY === true', { timeout: 180000 });
  }
  await p.evaluate((k) => window.SB_MODE(k), kind === 'grid' || clip === 'grid' ? 'grid' : 'single');
  if (clip && kind !== 'grid' && clip !== 'grid') await p.evaluate((c) => window.SB_PLAY(c), clip);
  await p.evaluate((on) => window.SB_SKEL(on), flags.includes('skel') || clip === 'skel');
  if (flags.includes('travel')) await p.evaluate((c) => window.SB_ROOT(c, true), clip);
  await wait(2500);
  const f = path.join(outDir, `mx_${s.replace(/:/g, '_')}.png`);
  await p.screenshot({ path: f }); console.log('saved', f);
  if (kind === 'mobile') { await p.setViewport({ width: 1280, height: 800 }); await p.waitForFunction('window.SB_READY === true', { timeout: 180000 }); }
}
console.log('clips', JSON.stringify(await p.evaluate(() => window.SB_CLIPS())));
console.log('logs', JSON.stringify(logs.slice(0, 6)));
console.log('errors', JSON.stringify(errs.slice(0, 6))); await b.close();
