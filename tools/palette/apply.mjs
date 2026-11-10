// Palette-snap character GLBs: run tools/palette/snap.py on the base-colour texture, re-encode it as WebP and
// swap it into the GLB (meshopt + quantization kept as they were).
//
// For real (writes assets/characters/sb_<char>.glb in place):
//   node tools/palette/apply.mjs --strength 0.6 carol-singer coal-imp ...
//   node tools/palette/apply.mjs --strength 0.6 --all
// The first time, the untouched model is copied to assets/characters-source/sb_<char>_pre-palette.glb, and every
// later run snaps FROM that copy, so re-applying with another strength never compounds. --strength 0 restores it.
//
// Variants (assets untouched):
//   node tools/palette/apply.mjs --strength 0.5,0.8 --out-dir review/palette --all
//   -> review/palette/sb_<char>_s50.glb, review/palette/tex/sb_<char>_s50.webp
//
// Swap a ready-made image:
//   node tools/palette/apply.mjs --glb in.glb --tex snapped.png --out out.glb
//
// Options: --quality 86 (WebP), --blender <path>, any --wL/--temp/--l-mix/--keep/--desat are passed to snap.py.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const req = createRequire(path.join(REPO, 'tools/web/package.json')); // deps live in tools/web/node_modules
const load = async (m) => import(pathToFileURL(req.resolve(m)).href);
const { NodeIO } = await load('@gltf-transform/core');
const { ALL_EXTENSIONS } = await load('@gltf-transform/extensions');
const { MeshoptDecoder, MeshoptEncoder } = await load('meshoptimizer');
const sharp = (await load('sharp')).default;

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const flag = (k) => { const i = args.indexOf(k); return i >= 0 ? (args.splice(i, 1), true) : false; };
const quality = Number(opt('--quality', '86'));
const blender = opt('--blender', process.env.BLENDER || '/Applications/Blender.app/Contents/MacOS/Blender');
const passthru = [];
for (const k of ['--wL', '--temp', '--l-mix', '--keep', '--desat']) { const v = opt(k); if (v !== undefined) passthru.push(k, v); }
const glbIn = opt('--glb'), texIn = opt('--tex'), glbOut = opt('--out');
const strengthArg = opt('--strength');
const outDir = opt('--out-dir');
const all = flag('--all');

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const toWebp = (file) => sharp(file).webp({ quality, alphaQuality: 100, effort: 6, smartSubsample: true }).toBuffer();

async function swap(src, webp, dst) {
  const doc = await io.read(src);
  const mat = doc.getRoot().listMaterials().find((m) => m.getBaseColorTexture());
  if (!mat) throw new Error(`${src}: no base-colour texture`);
  mat.getBaseColorTexture().setImage(new Uint8Array(webp)).setMimeType('image/webp');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  await io.write(dst, doc);
}

function snap(src, strengths, dir) {
  execFileSync(blender, ['-b', '--factory-startup', '-P', path.join(HERE, 'snap.py'), '--',
    '--in', src, '--out-dir', dir, '--strengths', strengths.join(','), ...passthru], { stdio: ['ignore', 'pipe', 'inherit'] });
}

const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;

if (glbIn) {
  if (!texIn || !glbOut) { console.error('--glb needs --tex and --out'); process.exit(1); }
  await swap(glbIn, await toWebp(texIn), glbOut);
  console.log(`${glbOut}  ${kb(glbOut)}`);
  process.exit(0);
}

if (strengthArg === undefined) {
  console.error('usage: apply.mjs --strength 0.6 <char ...|--all> [--out-dir DIR] | --glb in.glb --tex img --out out.glb');
  process.exit(1);
}
const strengths = strengthArg.split(',').map(Number);
if (!outDir && strengths.length !== 1) { console.error('several strengths need --out-dir'); process.exit(1); }
const charDir = path.join(REPO, 'assets/characters');
const chars = all ? fs.readdirSync(charDir).filter((f) => /^sb_.*\.glb$/.test(f)).map((f) => f.slice(3, -4)).sort() : args;
if (!chars.length) { console.error('no characters given'); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'palette-'));
for (const c of chars) {
  const live = path.join(charDir, `sb_${c}.glb`);
  const backup = path.join(REPO, `assets/characters-source/sb_${c}_pre-palette.glb`);
  if (!fs.existsSync(live)) { console.error(`skip ${c}: ${live} missing`); continue; }
  // always snap from the untouched texture
  let src = live;
  if (outDir) { if (fs.existsSync(backup)) src = backup; }
  else { if (!fs.existsSync(backup)) fs.copyFileSync(live, backup); src = backup; }
  // the pre-palette copy only stands in for the texture; geometry/animations always come from the live model
  const tex = path.join(tmp, c); fs.mkdirSync(tex, { recursive: true });
  // snap.py names outputs after the input stem
  const stemSrc = path.join(tex, `sb_${c}.glb`); fs.copyFileSync(src, stemSrc);
  snap(stemSrc, strengths, tex);
  for (const s of strengths) {
    const tag = `s${String(Math.round(s * 100)).padStart(2, '0')}`;
    const webp = await toWebp(path.join(tex, `sb_${c}_${tag}.png`));
    if (outDir) {
      const dst = path.join(REPO, outDir, `sb_${c}_${tag}.glb`);
      fs.mkdirSync(path.join(REPO, outDir, 'tex'), { recursive: true });
      fs.writeFileSync(path.join(REPO, outDir, 'tex', `sb_${c}_${tag}.webp`), webp);
      await swap(live, webp, dst);
      console.log(`${c} ${tag}: ${path.relative(REPO, dst)}  ${kb(dst)}  (tex ${(webp.length / 1024).toFixed(0)} KB)`);
    } else {
      await swap(live, webp, live);
      console.log(`${c} ${tag}: ${path.relative(REPO, live)}  ${kb(live)}  (backup ${path.relative(REPO, backup)})`);
    }
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
