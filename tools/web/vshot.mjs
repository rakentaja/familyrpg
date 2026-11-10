import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage(); await p.setViewport({ width: 1200, height: 760 });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
await p.goto('http://localhost:8765/viewer.html', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction('window.SB_READY === true', { timeout: 180000 });
const shots = process.argv.slice(2);
for (const s of shots) {
  const [name, key] = s.split(':');
  await p.evaluate(n => window.SB_SELECT(n), name); await new Promise(r => setTimeout(r, 1500));
  if (key) await p.keyboard.press(key);
  await new Promise(r => setTimeout(r, 1200));
  await p.screenshot({ path: `v_${name}${key ? '_' + key : ''}.png` });
}
console.log('errors', JSON.stringify(errs.slice(0, 4))); await b.close();
