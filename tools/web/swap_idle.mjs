// Replace a character's embedded idle clip with a retargeted clip (default: the Mixamo happy idle).
// The previous embedded clip is kept in the file, renamed (default "idle_look").
//
//   node tools/web/swap_idle.mjs <char> [<char> ...] [--clip happy_idle] [--keep-as idle_look]
//
// Reads  assets/characters/sb_<char>.glb and assets/animations/sb_<char>_mx_<clip>.glb (tracks bind by node name),
// writes the model back in place (meshopt-compressed like before); a copy of the original goes to
// assets/characters-source/sb_<char>_pre-idle-swap.glb the first time.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const clipName = opt('--clip', 'happy_idle');
const keepAs = opt('--keep-as', 'idle_look');
const chars = args;
if (!chars.length) { console.error('usage: swap_idle.mjs <char> [...] [--clip happy_idle] [--keep-as idle_look]'); process.exit(1); }

await MeshoptDecoder.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

for (const c of chars) {
  const modelPath = path.join(REPO, `assets/characters/sb_${c}.glb`);
  const clipPath = path.join(REPO, `assets/animations/sb_${c}_mx_${clipName}.glb`);
  const backup = path.join(REPO, `assets/characters-source/sb_${c}_pre-idle-swap.glb`);
  if (!fs.existsSync(backup)) fs.copyFileSync(modelPath, backup);

  const doc = await io.read(modelPath);
  const src = await io.read(clipPath);
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const byName = new Map(root.listNodes().map((n) => [n.getName(), n]));

  // drop a previous swap result, rename the original idle
  for (const a of root.listAnimations()) {
    if (a.getName() === 'idle') { a.listSamplers().forEach((s) => { s.getInput()?.dispose(); s.getOutput()?.dispose(); }); a.dispose(); }
  }
  for (const a of root.listAnimations()) if (a.getName() !== keepAs) a.setName(keepAs);

  const anim = doc.createAnimation('idle');
  const srcAnim = src.getRoot().listAnimations()[0];
  let n = 0;
  for (const ch of srcAnim.listChannels()) {
    const node = byName.get(ch.getTargetNode().getName());
    if (!node) continue;
    const s = ch.getSampler();
    const copy = (acc) => doc.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice()).setBuffer(buffer);
    const sampler = doc.createAnimationSampler().setInput(copy(s.getInput())).setOutput(copy(s.getOutput()))
      .setInterpolation(s.getInterpolation());
    anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(node)
      .setTargetPath(ch.getTargetPath()).setSampler(sampler));
    n++;
  }
  // put the new idle first so loaders that play animations[0] get it: re-create the older clips after it
  for (const a of root.listAnimations()) {
    if (a === anim) continue;
    const moved = doc.createAnimation(a.getName());
    for (const ch of a.listChannels()) {
      const s = ch.getSampler();
      const ns = doc.createAnimationSampler().setInput(s.getInput()).setOutput(s.getOutput())
        .setInterpolation(s.getInterpolation());
      moved.addSampler(ns).addChannel(doc.createAnimationChannel().setTargetNode(ch.getTargetNode())
        .setTargetPath(ch.getTargetPath()).setSampler(ns));
    }
    a.dispose();
  }

  await io.write(modelPath, doc);
  console.log(`${c}: idle <- ${clipName} (${n} channels), old idle kept as "${keepAs}"`);
}
