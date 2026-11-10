import * as THREE from 'three';
const INK = 0x2a2328;
// ---------- toon + hatch material ----------
export const grad = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 170, 170, 170, 255, 255, 255, 255, 255]), 3, 1);
grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
export const hatchUniforms = { uHatch: { value: 1 }, uRes: { value: new THREE.Vector2(1, 1) } };

export function toonify(src) {
  const m = new THREE.MeshToonMaterial({
    color: src.color ? src.color.clone() : new THREE.Color(1, 1, 1),
    map: src.map || null, gradientMap: grad,
    emissive: src.emissive ? src.emissive.clone() : new THREE.Color(0), emissiveMap: src.emissiveMap || null,
    transparent: src.transparent, alphaTest: src.alphaTest || 0, side: src.side,
  });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uHatch = hatchUniforms.uHatch;
    sh.fragmentShader = 'uniform float uHatch;\n' + sh.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
       float lum = dot(gl_FragColor.rgb, vec3(0.299,0.587,0.114));
       vec2 p = gl_FragCoord.xy;
       float h1 = step(0.82, fract((p.x + p.y) * 0.16));
       float h2 = step(0.82, fract((p.x - p.y) * 0.16));
       float shade = smoothstep(0.62, 0.32, lum);
       float dark  = smoothstep(0.40, 0.18, lum);
       float hatch = max(h1 * shade, h2 * dark) * uHatch;
       gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.165,0.137,0.157), hatch * 0.55);`);
  };
  return m;
}
const outlineMat = (w) => {
  const m = new THREE.MeshBasicMaterial({ color: INK, side: THREE.BackSide });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>',
      `#include <begin_vertex>\n transformed += normalize(normal) * ${w.toFixed(4)};`);
  };
  return m;
};
export const OUTLINE = { thin: outlineMat(0.012), med: outlineMat(0.02) };
export const outlines = [];

export function stylize(root, width = 'thin') {
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  for (const o of meshes) {
    o.castShadow = o.receiveShadow = true;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    o.material = Array.isArray(o.material) ? mats.map(toonify) : toonify(mats[0]);
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    const line = o.isSkinnedMesh ? new THREE.SkinnedMesh(o.geometry, OUTLINE[width]) : new THREE.Mesh(o.geometry, OUTLINE[width]);
    if (o.isSkinnedMesh) line.bind(o.skeleton, o.bindMatrix);
    line.castShadow = false; line.raycast = () => {};
    o.add(line); outlines.push(line);
  }
}

