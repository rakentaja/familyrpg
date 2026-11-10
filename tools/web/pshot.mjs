// Headless screenshots of review/palette-review.html.
// node pshot.mjs <page.html> <outDir> [shot ...]
//   shot = grid[:raw][:yaw<deg>] | focus:<charIndex>[:raw][:yaw<deg>] | mobile
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
const [page, outDir, ...shots] = process.argv.slice(2);
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] });
const p = await b.newPage();
const W = Number(process.env.PW || 1600), H = Number(process.env.PH || 900);
await p.setViewport({ width: W, height: H, deviceScaleFactor: Number(process.env.DPR || 1) });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto('file://' + path.resolve(page), { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction('window.SB_READY === true', { timeout: 300000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
for (const s of shots.length ? shots : ['grid']) {
  const [kind, ...rest] = s.split(':');
  if (kind === 'mobile') {
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await p.waitForFunction('window.SB_READY === true', { timeout: 300000 });
  }
  const o = { raw: rest.includes('raw'), focus: kind === 'focus' ? Number(rest[0]) : -1, yawDeg: 0 };
  const y = rest.find((r) => r.startsWith('yaw')); if (y) o.yawDeg = Number(y.slice(3));
  await p.evaluate((o) => window.SB_SET(o), o);
  await wait(1500);
  const f = path.join(outDir, `pal_${s.replace(/:/g, '_')}.png`);
  await p.screenshot({ path: f, fullPage: true }); console.log('saved', f);
}
console.log('errors', JSON.stringify(errs.slice(0, 6))); await b.close();
