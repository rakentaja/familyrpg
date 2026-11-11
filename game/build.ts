// Build the game into game/dist (static site for GitHub Pages).
//   bun build.ts            → dist/
//   bun build.ts --serve    → build, then serve dist/ on http://localhost:5173 (and on your LAN for phone testing)
import { $ } from 'bun';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const GAME = import.meta.dir;
const REPO = resolve(GAME, '..');
const DIST = join(GAME, 'dist');
const serve = process.argv.includes('--serve');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// 1. bundle
const res = await Bun.build({
  entrypoints: [join(GAME, 'src/main.ts')],
  outdir: DIST, naming: 'app.[hash].js', minify: true, target: 'browser', sourcemap: 'linked',
});
if (!res.success) { for (const l of res.logs) console.error(l); process.exit(1); }
const appFile = res.outputs.find((o) => o.kind === 'entry-point')!.path.split('/').pop()!;

// 2. static files (index.html gets the hashed bundle name)
cpSync(join(GAME, 'public'), DIST, { recursive: true });
const html = readFileSync(join(GAME, 'index.html'), 'utf8').replace('%APP%', appFile);
writeFileSync(join(DIST, 'index.html'), html);
cpSync(join(GAME, 'packs'), join(DIST, 'packs'), { recursive: true });

// 3. game assets referenced by the pack
const pack = JSON.parse(readFileSync(join(GAME, 'packs/sleighbound.json'), 'utf8'));
const urls = new Set<string>();
for (const m of Object.values<any>(pack.models)) {
  urls.add(m.url);
  for (const u of Object.values<string>(m.anim ?? {})) if (u !== '@model') urls.add(u);
}
let bytes = 0;
for (const u of urls) {
  const src = join(REPO, u);
  if (!existsSync(src)) { console.warn('missing asset', u); continue; }
  const dst = join(DIST, u);
  mkdirSync(join(dst, '..'), { recursive: true });
  cpSync(src, dst); bytes += statSync(src).size;
}

// 4. service worker precache list + version
const files: string[] = [];
const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p.slice(DIST.length + 1)); } };
walk(DIST);
const shell = files.filter((f) => !f.startsWith('assets/') && !f.startsWith('ai/') && !f.endsWith('.map') && f !== 'sw.js');   // ai/: the optional helper model, fetched only when turned on
const assets = files.filter((f) => f.startsWith('assets/'));
const version = createHash('sha1').update(files.join('|') + appFile).digest('hex').slice(0, 10);
const sw = readFileSync(join(GAME, 'public/sw.js'), 'utf8')
  .replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(['./', ...shell])).replace('__ASSETS__', JSON.stringify(assets));
writeFileSync(join(DIST, 'sw.js'), sw);
writeFileSync(join(DIST, '.nojekyll'), '');
console.log(`dist: ${appFile}, ${urls.size} assets (${(bytes / 1e6).toFixed(1)} MB), sw ${version}`);

if (serve) {
  const port = 5173;
  Bun.serve({
    port, hostname: '0.0.0.0',
    async fetch(req) {
      let p = decodeURIComponent(new URL(req.url).pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = Bun.file(join(DIST, p));
      return (await f.exists()) ? new Response(f) : new Response('not found', { status: 404 });
    },
  });
  const ip = (await $`ipconfig getifaddr en0`.nothrow().text()).trim();
  console.log(`serving http://localhost:${port}/` + (ip ? `  ·  phone on same Wi-Fi: http://${ip}:${port}/` : ''));
}
