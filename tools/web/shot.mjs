import puppeteer from 'puppeteer-core';
const [url, out, w='1400', h='850'] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); await p.setViewport({ width: +w, height: +h });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto(url, { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction('window.SB_READY === true', { timeout: 180000 }).catch(e => errs.push('not ready: ' + e.message));
await new Promise(r => setTimeout(r, 3000));
await p.screenshot({ path: out }); if (process.argv[6]) { await p.click('#bCast'); await new Promise(r=>setTimeout(r,2500)); await p.screenshot({ path: process.argv[6] }); } console.log('fit:', JSON.stringify(await p.evaluate('window.SB_FIT'))); console.log('errors:', JSON.stringify(errs.slice(0, 5))); await b.close();
