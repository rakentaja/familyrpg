// Game-ready export of a Meshy character that was NOT palette-processed before:
//   node tools/web/optimize_char.mjs <name> --idle <glb with the idle clip>
// 1. assets/characters-source/sb_<name>_idle.glb -> assets/characters/sb_<name>.glb: 1K WebP texture, meshopt+quantize,
//    its embedded clip replaced by `idle` taken from --idle (clips bind by node name).
// 2. every assets/animations/sb_<name>_*.glb (Meshy clips carry a full mesh + texture) is stripped to skeleton + clip.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { meshopt, prune, dedup, quantize, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const i = args.indexOf('--idle'); const idleFile = i >= 0 ? args.splice(i, 2)[1] : null;
const name = args[0];
if (!name || !idleFile) { console.error('usage: optimize_char.mjs <name> --idle <file.glb>'); process.exit(1); }

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

function copyClip(doc, src, name) {
  const root = doc.getRoot(), buffer = root.listBuffers()[0];
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));
  const anim = doc.createAnimation(name);
  const srcAnim = src.getRoot().listAnimations()[0];
  const copy = (acc) => doc.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice()).setBuffer(buffer);
  let n = 0;
  for (const ch of srcAnim.listChannels()) {
    const node = byName.get(ch.getTargetNode().getName()); if (!node) continue;
    const s = ch.getSampler();
    const sampler = doc.createAnimationSampler().setInput(copy(s.getInput())).setOutput(copy(s.getOutput())).setInterpolation(s.getInterpolation());
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(ch.getTargetPath()).setSampler(sampler)); n++;
  }
  return n;
}

// ---- model
const doc = await io.read(path.join(REPO, `assets/characters-source/sb_${name}_idle.glb`));
for (const a of doc.getRoot().listAnimations()) { a.listSamplers().forEach((s) => { s.getInput()?.dispose(); s.getOutput()?.dispose(); }); a.dispose(); }
const n = copyClip(doc, await io.read(path.resolve(idleFile)), 'idle');
await doc.transform(
  textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 86 }),
  dedup(), prune(), quantize(), meshopt({ encoder: MeshoptEncoder, level: 'high' }));
const out = path.join(REPO, `assets/characters/sb_${name}.glb`);
await io.write(out, doc);
console.log(`${name}: model ${(fs.statSync(out).size / 1024).toFixed(0)} KB, idle ${n} channels`);

// ---- clips
const dir = path.join(REPO, 'assets/animations');
for (const f of fs.readdirSync(dir).filter((x) => x.startsWith(`sb_${name}_`) && x.endsWith('.glb') && !x.includes('_mx_'))) {
  const d = await io.read(path.join(dir, f));
  const root = d.getRoot();
  for (const nd of root.listNodes()) { if (nd.getMesh()) nd.setMesh(null); if (nd.getSkin()) nd.setSkin(null); }
  await d.transform(prune({ keepLeaves: true }));
  for (const m of root.listMeshes()) m.dispose();
  await d.transform(prune({ keepLeaves: true }));
  await io.write(path.join(dir, f), d);
  console.log(f, (fs.statSync(path.join(dir, f)).size / 1024).toFixed(0), 'KB', root.listAnimations()[0]?.listChannels().length, 'channels');
}
