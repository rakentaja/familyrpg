// node reindeer_shot.mjs <page.html> <outDir> [clip:time:view[:skel] ...]
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';
const [page, outDir, ...shots] = process.argv.slice(2);
const exe = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find((p) => fs.existsSync(p));
const b = await puppeteer.launch({ executablePath: exe, headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'] });
const p = await b.newPage(); await p.setViewport({ width: 1100, height: 760 });
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
await p.goto('file://' + path.resolve(page), { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction('window.SB_READY === true', { timeout: 180000 });
fs.mkdirSync(outDir, { recursive: true });
for (const s of shots) {
  const [clip, t, view, skel] = s.split(':');
  await p.evaluate((c) => window.SB_PLAY(c), clip);
  await new Promise((r) => setTimeout(r, 400));
  await p.evaluate((v, k) => { window.SB_VIEW(v); window.SB_SKEL(k); }, view, skel === 'skel');
  const info = await p.evaluate((x) => window.SB_SEEK(x), +t);
  await new Promise((r) => setTimeout(r, 300));
  const f = path.join(outDir, `rd_${s.replace(/[:.]/g, '_')}.png`);
  await p.screenshot({ path: f }); console.log('saved', f, '|', info);
  await p.evaluate(() => document.getElementById('bPause').click()); // un-pause for next clip
}
console.log('info', JSON.stringify(await p.evaluate(() => window.SB_INFO())));
console.log('errors', JSON.stringify(errs.slice(0, 6))); await b.close();
