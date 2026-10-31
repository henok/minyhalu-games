// Four big maps in a warm, cel-shaded "summer afternoon" style:
// gradient skies, blobby swaying trees, detailed little houses, palm trees,
// street lamps, drifting clouds, butterflies and rolling hills on the horizon.
// Every map returns { solids, colliders, seekerSpawn, hiderSpawns, bounds, animate }

import * as THREE from 'three';
import { toonMat, toonVertexMat } from './avatar.js';
import { makeProp } from './models.js';

export const MAPS = {
  village: { name: '🏘️ Summer Village', desc: 'A sunny street with houses, palm trees and gardens' },
  jungle: { name: '🌴 Jungle', desc: 'Vine-draped giants, palms, a smoking volcano, and dark caves' },
  backyard: { name: '🏡 Sunny Garden', desc: 'Bushes, a hedge maze and a cosy shed to sneak into' },
  warehouse: { name: '📦 Crate Yard', desc: 'Climb honey-wood crates, hide in the old containers' },
  forest: { name: '🌾 Golden Meadow', desc: 'Tall golden grass to lie down in, logs and warm rocks' },
};

// paint a vertical color gradient into a geometry's vertex colors
function gradientize(geo, bottom, top, minY = null, maxY = null) {
  geo.computeBoundingBox();
  const lo = minY ?? geo.boundingBox.min.y;
  const hi = maxY ?? geo.boundingBox.max.y;
  const cb = new THREE.Color(bottom), ct = new THREE.Color(top);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - lo) / (hi - lo || 1)));
    const c = cb.clone().lerp(ct, t);
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geo;
}

function gradMesh(geo, bottom, top, opts = {}) {
  gradientize(geo, bottom, top, opts.minY, opts.maxY);
  const mesh = new THREE.Mesh(geo, toonVertexMat());
  mesh.userData.camoColor = opts.camo || bottom;
  return mesh;
}

// seeded RNG: every player in a room generates the IDENTICAL map (scattered
// trees, palm leans, tufts...) — which also lets the server's robot players
// use the host's collision data safely
let rng = Math.random;
function seededRandom(seed) {
  let s = (seed >>> 0) || 7;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ---- shared GPU resources: one geometry/material per LOOK, not per mesh ----
// (big maps would otherwise allocate thousands of tiny buffers)
const matCache = new Map();
function toonMatC(color) {
  let m = matCache.get(color);
  if (!m) { m = toonMat(color); matCache.set(color, m); }
  return m;
}
let tvMat = null;
const toonVertexMatC = () => (tvMat ||= toonVertexMat());
const gradGeoCache = new Map();
function gradUnitGeo(kind, lo, hi) {
  const key = kind + lo + hi;
  if (!gradGeoCache.has(key)) {
    let g;
    if (kind === 'sphere') g = new THREE.SphereGeometry(1, 10, 8);
    else if (kind === 'dodeca') g = new THREE.DodecahedronGeometry(1);
    else { g = new THREE.ConeGeometry(0.09, 1, 5); g.translate(0, 0.5, 0); } // grass blade
    gradientize(g, lo, hi);
    gradGeoCache.set(key, g);
  }
  return gradGeoCache.get(key);
}
// a gradient blob (tree canopy, bush...) built from the shared unit sphere
function gradBlob(lo, hi, r, squashY = 0.88) {
  const m = new THREE.Mesh(gradUnitGeo('sphere', lo, hi), toonVertexMatC());
  m.scale.set(r, r * squashY, r);
  m.userData.camoColor = lo;
  return m;
}
function gradRock(lo, hi, s) {
  const m = new THREE.Mesh(gradUnitGeo('dodeca', lo, hi), toonVertexMatC());
  m.scale.setScalar(s);
  m.userData.camoColor = lo;
  return m;
}

// a butterfly wing with gracefully curved, two-lobed edges — and gently
// cupped in 3D like a real wing (shared by every butterfly on every map)
let wingGeoCache = null;
function butterflyWingGeo() {
  if (wingGeoCache) return wingGeoCache;
  const sh = new THREE.Shape();
  sh.moveTo(0, 0.02);
  sh.quadraticCurveTo(0.10, 0.17, 0.24, 0.14);    // forewing: sweeping leading edge
  sh.quadraticCurveTo(0.33, 0.10, 0.26, 0.01);    // rounded outer tip
  sh.quadraticCurveTo(0.21, -0.03, 0.12, -0.03);  // soft notch between the lobes
  sh.quadraticCurveTo(0.20, -0.11, 0.12, -0.18);  // trailing hindwing lobe
  sh.quadraticCurveTo(0.03, -0.20, 0.005, -0.06); // sweep back to the body
  sh.lineTo(0, 0.02);
  const g = new THREE.ShapeGeometry(sh, 12);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const wx = p.getX(i);
    p.setZ(i, wx * wx * 0.5); // the cupping
  }
  g.computeVertexNormals();
  wingGeoCache = g;
  return g;
}

class Builder {
  constructor(scene, bounds) {
    this.scene = scene;
    this.bounds = bounds;
    this.solids = [];     // meshes bullets can hit / camo can sample
    this.colliders = [];  // {minX,maxX,minZ,maxZ,top} walk-blockers / climbables
    this.animated = [];   // {kind, obj, ...} updated every frame
    this.tufts = [];      // deferred: baked into a few InstancedMeshes at the end
    this.flowers = [];
    this.vines = [];      // deferred hanging vines (two draw calls total)
  }
  place(mesh, { solid = true, cast = true, receive = true } = {}) {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.scene.add(mesh);
    if (solid) this.solids.push(mesh);
    return mesh;
  }
  collideBox(x, z, w, d, top, base = 0) {
    // base = the collider's bottom: things above head height can be walked under
    this.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top, base });
  }
  box(x, z, w, h, d, color, { collide = true, y = 0, solid = true, rotY = 0 } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMatC(color));
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.y = rotY;
    this.place(mesh, { solid });
    if (collide) {
      const half = rotY ? Math.max(w, d) : 0;
      this.collideBox(x, z, half || w, half || d, y + h, y);
    }
    return mesh;
  }
  cylinder(x, z, r, h, color, { collide = true, y = 0, r2 = null, tilt = 0 } = {}) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r2 ?? r, h, 10), toonMatC(color));
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.z = tilt;
    this.place(mesh);
    if (collide) this.colliders.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, top: y + h, base: y });
    return mesh;
  }

  // --- sky, light, ground ---
  sky(top, horizon) {
    const R = Math.min(450, Math.max(240, this.bounds * 3));
    const geo = new THREE.SphereGeometry(R, 24, 12);
    gradientize(geo, horizon, top, R * 0.03, R * 0.85);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false }));
    this.scene.add(mesh);
    this.scene.background = new THREE.Color(horizon);
    // on massive maps the fog is also the draw-distance budget: the far side
    // of the map melts into haze instead of costing GPU time
    this.scene.fog = new THREE.Fog(horizon, Math.min(70, this.bounds * 0.6), Math.min(320, Math.max(150, this.bounds * 1.6)));
  }
  lights({ sunColor = '#ffdfae', sunPos = [26, 40, 16], sunI = 2.8, sky = '#fff3d8', ground = '#93a862', ambI = 1.5 }) {
    const sun = new THREE.DirectionalLight(sunColor, sunI);
    sun.position.set(...sunPos);
    sun.castShadow = true;
    // a tight shadow box that FOLLOWS the player: sharp shadows at any map
    // size, and a quarter of the texture memory of one giant map-wide shadow
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 300 });
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.scene.add(new THREE.HemisphereLight(sky, ground, ambI));
    this.sun = sun;
    this.sunOffset = new THREE.Vector3(...sunPos).normalize().multiplyScalar(110);
  }
  ground(inner, outer) {
    const size = this.bounds * 2.6;
    const geo = new THREE.CircleGeometry(size, 48);
    const ci = new THREE.Color(inner), co = new THREE.Color(outer);
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const t = Math.min(1, Math.hypot(pos.getX(i), pos.getY(i)) / size);
      const c = ci.clone().lerp(co, t * t);
      colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, toonVertexMat());
    mesh.rotation.x = -Math.PI / 2;
    mesh.userData.camoColor = inner;
    this.place(mesh, { cast: false });
  }

  // --- vegetation ---
  tree(x, z, s = 1, lo = '#79a04f', hi = '#d7e478') {
    const tilt = (rng() - 0.5) * 0.12;
    this.cylinder(x, z, 0.22 * s, 2.3 * s, '#8a6642', { r2: 0.34 * s, tilt, collide: false });
    this.colliders.push({ minX: x - 0.4 * s, maxX: x + 0.4 * s, minZ: z - 0.4 * s, maxZ: z + 0.4 * s, top: 99 });
    const blobs = [
      [0, 3.1 * s, 0, 1.5 * s],
      [0.9 * s, 2.6 * s, 0.3 * s, 1.0 * s],
      [-0.8 * s, 2.7 * s, -0.4 * s, 0.9 * s],
    ];
    for (const [bx, by, bz, br] of blobs) {
      const blob = gradBlob(lo, hi, br);
      blob.position.set(x + bx + tilt * 2, by, z + bz);
      this.place(blob);
      this.animated.push({ kind: 'sway', obj: blob, phase: x + z + by, amp: 0.02 });
    }
  }
  palm(x, z, s = 1) {
    const g = new THREE.Group();
    const lean = (rng() - 0.5) * 0.55;
    const trunkMat = toonMatC('#b3946a');
    let px = 0, py = 0;
    for (let i = 0; i < 5; i++) {
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(0.13 * s * (1 - i * 0.08), 0.17 * s * (1 - i * 0.08), 0.95 * s, 8),
        trunkMat
      );
      seg.position.set(px, py + 0.45 * s, 0);
      seg.rotation.z = -lean * 0.35 * (i / 4);
      seg.castShadow = true;
      g.add(seg);
      this.solids.push(seg);
      py += 0.86 * s;
      px += lean * 0.16 * s * (i + 1) / 3;
    }
    const crown = new THREE.Group();
    crown.position.set(px, py + 0.05 * s, 0);
    const frondMat = toonMatC('#4e8a4e');
    for (let i = 0; i < 7; i++) {
      const geo = new THREE.SphereGeometry(1, 8, 4);
      geo.scale(1.25 * s, 0.07 * s, 0.34 * s);
      geo.translate(1.1 * s, 0, 0);
      geo.rotateZ(-0.42);
      const frond = new THREE.Mesh(geo, frondMat);
      frond.rotation.y = (i / 7) * Math.PI * 2 + 0.3;
      frond.castShadow = true;
      crown.add(frond);
      this.solids.push(frond);
    }
    const cocoMat = toonMatC('#7a5230');
    for (const [cx, cz] of [[0.16 * s, 0.1 * s], [-0.12 * s, 0.14 * s], [0.05 * s, -0.16 * s]]) {
      const coco = new THREE.Mesh(new THREE.SphereGeometry(0.13 * s, 7, 6), cocoMat);
      coco.position.set(cx, -0.12 * s, cz);
      crown.add(coco);
    }
    g.add(crown);
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.colliders.push({ minX: x - 0.35 * s, maxX: x + 0.35 * s, minZ: z - 0.35 * s, maxZ: z + 0.35 * s, top: 99 });
    this.animated.push({ kind: 'sway', obj: crown, phase: x * 2, amp: 0.05 });
  }
  bush(x, z, s = 1, lo = '#6d8c4c', hi = '#a9c46b') {
    const blob = gradBlob(lo, hi, 0.9 * s, 0.73);
    blob.scale.x *= 1.1; blob.scale.z *= 1.1;
    blob.position.set(x, 0.62 * s, z);
    this.place(blob);
    const puff = gradBlob(lo, hi, 0.55 * s, 1);
    puff.position.set(x + 0.5 * s, 0.5 * s, z - 0.3 * s);
    this.place(puff);
    this.colliders.push({ minX: x - 0.6 * s, maxX: x + 0.6 * s, minZ: z - 0.6 * s, maxZ: z + 0.6 * s, top: 1.1 * s });
    this.animated.push({ kind: 'sway', obj: blob, phase: x * 3, amp: 0.015 });
  }
  // grass and flowers are deferred and baked into a handful of InstancedMeshes —
  // hundreds of tufts become 1-2 draw calls instead of 1000+
  tuft(x, z, s = 1, lo = '#87a552', hi = '#d6cf7c') {
    this.tufts.push({ x, z, s, lo, hi });
  }
  flower(x, z, color) {
    this.flowers.push({ x, z, color });
  }
  buildDecor() {
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    const p3 = new THREE.Vector3(), s3 = new THREE.Vector3();
    // --- grass blades, grouped by palette ---
    const palettes = new Map();
    for (const t of this.tufts) {
      const k = t.lo + t.hi;
      if (!palettes.has(k)) palettes.set(k, { lo: t.lo, hi: t.hi, blades: [] });
      const g = palettes.get(k);
      const n = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        g.blades.push({
          x: t.x + (rng() - 0.5) * 0.5 * t.s,
          z: t.z + (rng() - 0.5) * 0.5 * t.s,
          h: (0.55 + rng() * 0.5) * t.s,
          s: t.s,
          rz: (rng() - 0.5) * 0.25,
          ry: rng() * Math.PI,
        });
      }
    }
    for (const g of palettes.values()) {
      const im = new THREE.InstancedMesh(gradUnitGeo('blade', g.lo, g.hi), toonVertexMatC(), g.blades.length);
      g.blades.forEach((b, i) => {
        e.set(0, b.ry, b.rz);
        q.setFromEuler(e);
        m4.compose(p3.set(b.x, 0, b.z), q, s3.set(b.s, b.h, b.s));
        im.setMatrixAt(i, m4);
      });
      im.castShadow = false;
      im.receiveShadow = true;
      this.scene.add(im);
    }
    // --- flowers: one instanced stem mesh + one instanced head mesh ---
    if (this.flowers.length) {
      const stemGeo = new THREE.CylinderGeometry(0.015, 0.02, 0.3);
      stemGeo.translate(0, 0.15, 0);
      const stems = new THREE.InstancedMesh(stemGeo, toonMatC('#7a9a4e'), this.flowers.length);
      const headGeo = new THREE.SphereGeometry(0.07, 8, 6);
      headGeo.translate(0, 0.33, 0);
      const heads = new THREE.InstancedMesh(headGeo, toonMatC('#ffffff'), this.flowers.length);
      const col = new THREE.Color();
      this.flowers.forEach((f, i) => {
        m4.makeTranslation(f.x, 0, f.z);
        stems.setMatrixAt(i, m4);
        heads.setMatrixAt(i, m4);
        heads.setColorAt(i, col.set(f.color));
      });
      if (heads.instanceColor) heads.instanceColor.needsUpdate = true;
      stems.castShadow = false;
      heads.castShadow = false;
      this.scene.add(stems, heads);
    }
    // --- hanging vines: every vine on the map in just two draw calls ---
    if (this.vines.length) {
      const vineGeo = new THREE.CylinderGeometry(0.022, 0.04, 1, 5);
      vineGeo.translate(0, -0.5, 0); // hang from the origin downward
      const vines = new THREE.InstancedMesh(vineGeo, toonMatC('#3d5a2f'), this.vines.length);
      const leaves = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), toonMatC('#4f7a3c'), this.vines.length * 2);
      const qi = new THREE.Quaternion(); // vines hang plumb
      let li = 0;
      this.vines.forEach((v, i) => {
        m4.compose(p3.set(v.x, v.topY, v.z), qi, s3.set(1, v.len, 1));
        vines.setMatrixAt(i, m4);
        for (const f of [0.55, 1]) { // a leaf cluster mid-way and at the tip
          e.set((rng() - 0.5) * 0.9, rng() * Math.PI, (rng() - 0.5) * 0.9);
          q.setFromEuler(e);
          m4.compose(
            p3.set(v.x + (rng() - 0.5) * 0.1, v.topY - v.len * f, v.z + (rng() - 0.5) * 0.1),
            q,
            s3.set(0.26, 0.09, 0.16)
          );
          leaves.setMatrixAt(li++, m4);
        }
      });
      vines.castShadow = false;
      leaves.castShadow = false;
      this.scene.add(vines, leaves);
    }
  }

  // --- architecture ---
  house(x, z, facing, opts = {}) {
    // axis-aligned only (facing 0, PI, +-PI/2) so colliders stay tight
    const { w = 7, d = 6, h = 3.1, wall = '#dcb9ae', roof = '#c95a4a', awning = '#e0824f' } = opts;
    const g = new THREE.Group();
    const add = (mesh) => {
      mesh.castShadow = true; mesh.receiveShadow = true;
      g.add(mesh); this.solids.push(mesh);
      return mesh;
    };
    const body = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMatC(wall)));
    body.position.y = h / 2;
    // pyramid roof with a little overhang
    const roofGeo = new THREE.ConeGeometry(0.74, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofM = add(new THREE.Mesh(roofGeo, toonMatC(roof)));
    roofM.scale.set(w * 1.08, h * 0.55, d * 1.08);
    roofM.position.y = h + h * 0.272;
    const chim = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.2, 0.5), toonMatC(wall)));
    chim.position.set(w * 0.28, h + h * 0.4, -d * 0.18);
    // windows + door + awning
    const winMat = toonMatC('#9fb9cf');
    const frameMat = toonMatC('#f4ead2');
    const win = (wx, wy, wz, ww, wh, rot = 0) => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(ww + 0.2, wh + 0.2, 0.12), frameMat);
      f.position.set(wx, wy, wz); f.rotation.y = rot; add(f);
      const glass = new THREE.Mesh(new THREE.BoxGeometry(ww, wh, 0.16), winMat);
      glass.position.set(wx, wy, wz); glass.rotation.y = rot; add(glass);
    };
    win(-w * 0.26, h * 0.62, d / 2, 1.15, 0.85);
    win(w * 0.26, h * 0.62, d / 2, 1.15, 0.85);
    win(-w / 2, h * 0.6, -d * 0.15, 1.05, 0.8, Math.PI / 2);
    win(w / 2, h * 0.6, d * 0.15, 1.05, 0.8, Math.PI / 2);
    const door = add(new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.9, 0.16), toonMatC('#8a6642')));
    door.position.set(0, 0.95, d / 2);
    const awn = add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 1.1), toonMatC(awning)));
    awn.position.set(0, 2.2, d / 2 + 0.5);
    awn.rotation.x = 0.18;
    g.position.set(x, 0, z);
    g.rotation.y = facing;
    this.scene.add(g);
    const swapped = Math.abs(Math.sin(facing)) > 0.5;
    this.collideBox(x, z, (swapped ? d : w) + 0.2, (swapped ? w : d) + 0.2, h + 1);
  }
  hut(x, z, { w = 5.5, d = 5, h = 2.6, wall = '#efe3c2', roof = '#cf7351', door = 'S' } = {}) {
    // a little room you can actually walk into and hide in
    const t = 0.3, gap = 1.6;
    const segW = (w - gap) / 2, segD = (d - gap) / 2;
    if (door === 'S') {
      this.box(x - (gap + segW) / 2, z + d / 2, segW, h, t, wall);
      this.box(x + (gap + segW) / 2, z + d / 2, segW, h, t, wall);
    } else this.box(x, z + d / 2, w, h, t, wall);
    if (door === 'N') {
      this.box(x - (gap + segW) / 2, z - d / 2, segW, h, t, wall);
      this.box(x + (gap + segW) / 2, z - d / 2, segW, h, t, wall);
    } else this.box(x, z - d / 2, w, h, t, wall);
    if (door === 'E') {
      this.box(x + w / 2, z - (gap + segD) / 2, t, h, segD, wall);
      this.box(x + w / 2, z + (gap + segD) / 2, t, h, segD, wall);
    } else this.box(x + w / 2, z, t, h, d, wall);
    if (door === 'W') {
      this.box(x - w / 2, z - (gap + segD) / 2, t, h, segD, wall);
      this.box(x - w / 2, z + (gap + segD) / 2, t, h, segD, wall);
    } else this.box(x - w / 2, z, t, h, d, wall);
    const roofGeo = new THREE.ConeGeometry(0.74, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofM = new THREE.Mesh(roofGeo, toonMatC(roof));
    roofM.scale.set(w * 1.15, h * 0.5, d * 1.15);
    roofM.position.set(x, h + h * 0.25, z);
    this.place(roofM);
  }
  cave(x, z, s = 1.4) {
    // rocky shelter with a dark inside, entrance on the +z side
    const rock = (rx, rz, rr) => {
      const m = gradRock('#6b6257', '#968b78', rr);
      m.position.set(x + rx, rr * 0.7, z + rz);
      this.place(m);
    };
    rock(-2.2 * s, 0.3 * s, 1.6 * s);
    rock(2.2 * s, 0.3 * s, 1.6 * s);
    rock(0, -2.2 * s, 1.9 * s);
    const top = gradRock('#5f574d', '#8a8070', 1);
    top.position.set(x, 2.9 * s, z - 0.5 * s);
    top.scale.set(3.25 * s, 1.43 * s, 2.99 * s);
    this.place(top);
    // three walls collide; the front stays open so you can slip in
    this.collideBox(x - 2.2 * s, z + 0.3 * s, 2.4 * s, 2.6 * s, 99);
    this.collideBox(x + 2.2 * s, z + 0.3 * s, 2.4 * s, 2.6 * s, 99);
    this.collideBox(x, z - 2.2 * s, 3 * s, 2.4 * s, 99);
  }
  bigTree(x, z, s = 1) {
    // jungle giant: flared roots, thick trunk, huge canopy
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.55 * s, 0.8 * s, 6.5 * s, 10), toonMatC('#6e4f32'));
    trunk.position.set(x, 3.25 * s, z);
    this.place(trunk);
    this.colliders.push({ minX: x - 0.8 * s, maxX: x + 0.8 * s, minZ: z - 0.8 * s, maxZ: z + 0.8 * s, top: 99 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.3 * s, 1.6 * s, 6), toonMatC('#6e4f32'));
      root.position.set(x + Math.cos(a) * 0.85 * s, 0.5 * s, z + Math.sin(a) * 0.85 * s);
      root.rotation.z = Math.cos(a) * 0.5;
      root.rotation.x = -Math.sin(a) * 0.5;
      this.place(root);
    }
    for (const [bx, by, bz, br] of [[0, 7 * s, 0, 3.2 * s], [2 * s, 6 * s, 0.8 * s, 2.2 * s], [-1.8 * s, 6.3 * s, -0.9 * s, 2.4 * s]]) {
      const blob = gradBlob('#3f6b35', '#7fae57', br, 0.8);
      blob.position.set(x + bx, by, z + bz);
      this.place(blob);
      this.animated.push({ kind: 'sway', obj: blob, phase: x + by, amp: 0.015 });
    }
    // vines hanging from under the canopy
    const nV = 2 + Math.floor(rng() * 3);
    for (let v = 0; v < nV; v++) {
      const a = rng() * Math.PI * 2;
      const rr = (0.9 + rng() * 2.1) * s;
      this.vines.push({
        x: x + Math.cos(a) * rr,
        z: z + Math.sin(a) * rr,
        topY: (5.4 + rng() * 1.4) * s,
        len: (2.2 + rng() * 2.6) * s,
      });
    }
  }
  bigHouse(x, z, style = {}) {
    // a real two-story house: walk in the door, climb the stairs, look out
    // the open upstairs windows, hide behind the furniture
    const { wall = '#efe0bd', roof = '#e0824f', awning = '#c9564a' } = style;
    const w = 10, d = 8, t = 0.3, h1 = 3;          // footprint + ground floor height
    const fl = 3.0;                                 // second floor slab sits at y=3.0..3.3
    // ---- ground floor walls (door on the +z side) ----
    this.box(x - 2.9, z + d / 2, 4.2, h1, t, wall);              // south, left of door
    this.box(x + 2.9, z + d / 2, 4.2, h1, t, wall);              // south, right of door
    this.box(x, z + d / 2, 1.6, 0.8, t, wall, { y: 2.2 });       // door header (walk under!)
    this.box(x, z - d / 2, w, h1, t, wall);                      // north
    this.box(x - w / 2, z, t, h1, d, wall);                      // west
    this.box(x + w / 2, z, t, h1, d, wall);                      // east
    // decorative ground-floor windows on the north face
    for (const wx of [-2.6, 2.6]) {
      const glass = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 0.16), toonMatC('#9fb9cf'));
      glass.position.set(x + wx, 1.8, z - d / 2 - 0.05);
      this.place(glass);
    }
    // awning over the door
    const awn = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 1.1), toonMatC(awning));
    awn.position.set(x, 2.45, z + d / 2 + 0.5);
    awn.rotation.x = 0.18;
    this.place(awn);
    // ---- staircase along the west wall (8 steps, 0.4 rise each) ----
    for (let i = 1; i <= 8; i++) {
      this.box(x - w / 2 + 0.9, z - d / 2 + 0.25 + i * 0.5, 1.4, 0.4 * i, 0.5, '#c99a63');
    }
    // ---- second floor slab, with the stairwell left open ----
    this.box(x + 0.8, z, w - 1.6, 0.3, d, '#d3a870', { y: fl });                       // main slab
    this.box(x - w / 2 + 0.8, z + d / 2 - 1.75, 1.6, 0.3, 3.5, '#d3a870', { y: fl }); // west strip past the stairwell
    // ---- upstairs: waist-high parapet + roof band = big open windows all around ----
    for (const [px, pz, pw, pd] of [
      [x, z + d / 2, w, t], [x, z - d / 2, w, t], [x - w / 2, z, t, d], [x + w / 2, z, t, d],
    ]) {
      this.box(px, pz, pw, 0.9, pd, wall, { y: fl + 0.3 });   // parapet — lean over and look out
      this.box(px, pz, pw, 0.5, pd, wall, { y: fl + 2.2 });   // band under the roof
    }
    for (const [cx, cz] of [[x - w / 2, z - d / 2], [x + w / 2, z - d / 2], [x - w / 2, z + d / 2], [x + w / 2, z + d / 2]]) {
      this.box(cx, cz, 0.5, 2.4, 0.5, wall, { y: fl + 0.3 }); // corner posts
    }
    // ---- roof ----
    const roofGeo = new THREE.ConeGeometry(0.74, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofM = new THREE.Mesh(roofGeo, toonMatC(roof));
    roofM.scale.set(w * 1.12, 2.0, d * 1.12);
    roofM.position.set(x, fl + 2.7 + 1.0, z);
    this.place(roofM);
    // ---- furniture to blend in with (chair/plant/lamp disguises fit right in) ----
    const decor = (kind, dx, dz, y = 0) => {
      const p = makeProp(kind);
      p.position.set(x + dx, y, z + dz);
      this.scene.add(p);
      p.traverse(o => { if (o.isMesh) this.solids.push(o); });
    };
    decor('chair', 2.6, -1.2);
    decor('chair', 3.4, 1.6);
    decor('plant', -3.2, 2.8);
    decor('lamp', 4.1, -2.9);
    decor('plant', 2.2, 2.2, fl + 0.3);  // one upstairs
    decor('lamp', -2.6, -2.6, fl + 0.3);
  }
  lamp(x, z, side = 1) {
    const mat = toonMatC('#5a6152');
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 4.4, 8), mat);
    pole.position.set(x, 2.2, z);
    this.place(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.08, 0.08), mat);
    arm.position.set(x + side * 0.5, 4.35, z);
    this.place(arm, { solid: false });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), new THREE.MeshBasicMaterial({ color: '#fff2c4', toneMapped: false }));
    head.position.set(x + side * 1.0, 4.27, z);
    this.scene.add(head);
    this.colliders.push({ minX: x - 0.15, maxX: x + 0.15, minZ: z - 0.15, maxZ: z + 0.15, top: 99 });
  }
  hill(x, z, r, color) {
    // rolling hills outside the walls, for the horizon
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), toonMatC(color));
    m.position.set(x, -r * 0.62, z);
    m.scale.y = 0.6;
    m.castShadow = false;
    m.receiveShadow = true;
    this.scene.add(m);
  }
  flat(x, z, w, d, color, y = 0.02) {
    // road / path pieces: flat, no collision
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), toonMatC(color));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    this.scene.add(m);
    return m;
  }

  // --- weather + critters ---
  cloud(x, y, z, s = 1) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: '#fffdf4', fog: false, toneMapped: false });
    for (const [cx, cy, cz, cr] of [[0, 0, 0, 2.6], [2.2, 0.3, 0.4, 1.9], [-2.1, 0.2, -0.3, 1.7], [0.5, 0.9, 0.2, 1.6]]) {
      const puff = new THREE.Mesh(new THREE.SphereGeometry(cr * s, 9, 7), mat);
      puff.position.set(cx * s, cy * s, cz * s);
      puff.scale.y = 0.55;
      g.add(puff);
    }
    g.position.set(x, y, z);
    this.scene.add(g);
    this.animated.push({ kind: 'drift', obj: g, speed: 0.25 + rng() * 0.35, limit: this.bounds * 4 });
  }
  butterfly(cx, cz, color = '#f2b6c9', s = 1, { baseY = 1.1, sp = null, flap = 14 } = {}) {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const wingR = new THREE.Mesh(butterflyWingGeo(), mat);
    const wingL = new THREE.Mesh(butterflyWingGeo(), mat);
    wingL.scale.x = -1;
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.016, 0.15, 2, 6), toonMatC('#3a3426'));
    g.add(wingR, wingL, body);
    g.scale.setScalar(s);
    g.rotation.x = -0.6;
    this.scene.add(g);
    this.animated.push({
      kind: 'butterfly', obj: g, wingR, wingL, baseY, flap,
      cx, cz, r: 2.5 + rng() * 3, sp: sp ?? (0.25 + rng() * 0.3), phase: rng() * 9,
    });
  }
  bug(cx, cz) {
    // a busy little bee: quick, low, and blurry-winged
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.055, 7, 5), toonMatC('#d9a43b'));
    body.scale.set(1, 0.8, 1.4);
    const wingMat = new THREE.MeshBasicMaterial({ color: '#fffdf4', transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const wGeo = new THREE.CircleGeometry(0.05, 6);
    wGeo.translate(0.05, 0.02, 0);
    const wingR = new THREE.Mesh(wGeo, wingMat);
    const wingL = new THREE.Mesh(wGeo.clone(), wingMat);
    wingL.scale.x = -1;
    g.add(body, wingR, wingL);
    this.scene.add(g);
    this.animated.push({
      kind: 'butterfly', obj: g, wingR, wingL, baseY: 0.7 + rng() * 0.6, flap: 42,
      cx, cz, r: 1 + rng() * 1.8, sp: 0.8 + rng() * 0.6, phase: rng() * 9,
    });
  }
  volcano(x, z, s = 1) {
    // a smoking giant on the horizon — fog-proof so it looms through the haze
    const H = 85 * s;
    const bodyGeo = new THREE.CylinderGeometry(13 * s, 58 * s, H, 22, 3);
    gradientize(bodyGeo, '#5d6b4e', '#4a3a33'); // jungly skirts, scorched summit
    const bodyMat = toonVertexMat();
    bodyMat.fog = false;
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.set(x, H / 2 - 4 * s, z);
    body.castShadow = false;
    body.receiveShadow = false;
    this.scene.add(body);
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(13.6 * s, 14.4 * s, 2.4 * s, 22, 1, true),
      new THREE.MeshBasicMaterial({ color: '#ff6a2a', toneMapped: false, fog: false, side: THREE.DoubleSide })
    );
    rim.position.set(x, H - 4.6 * s, z);
    this.scene.add(rim);
    const lava = new THREE.Mesh(
      new THREE.CircleGeometry(13.2 * s, 22),
      new THREE.MeshBasicMaterial({ color: '#ffb13d', toneMapped: false, fog: false })
    );
    lava.rotation.x = -Math.PI / 2;
    lava.position.set(x, H - 3.5 * s, z);
    this.scene.add(lava);
    for (let i = 0; i < 4; i++) { // lazy smoke puffs drifting up from the crater
      const puff = new THREE.Mesh(
        new THREE.SphereGeometry(6 * s, 9, 7),
        new THREE.MeshBasicMaterial({ color: '#8f8a84', transparent: true, opacity: 0.55, fog: false, toneMapped: false })
      );
      this.scene.add(puff);
      this.animated.push({
        kind: 'smoke', obj: puff, x, z, baseY: H - 2 * s, rise: 36 * s,
        speed: 0.035 + rng() * 0.02, offset: i / 4, drift: (rng() - 0.5) * 10 * s,
      });
    }
  }
  fence(height, color) {
    const size = this.bounds, t = 0.35;
    this.box(0, -size, size * 2, height, t, color);
    this.box(0, size, size * 2, height, t, color);
    this.box(-size, 0, t, height, size * 2, color);
    this.box(size, 0, t, height, size * 2, color);
  }
  sprinkle(count, fn, exclude = 6) {
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      const r = exclude + rng() * (this.bounds - exclude - 2);
      fn(Math.cos(a) * r, Math.sin(a) * r);
    }
  }
  makeAnimate() {
    const animated = this.animated;
    return (t, dt) => {
      for (const a of animated) {
        if (a.kind === 'sway') {
          a.obj.rotation.z = Math.sin(t * 1.3 + a.phase) * a.amp;
          a.obj.rotation.x = Math.cos(t * 1.1 + a.phase) * a.amp * 0.6;
        } else if (a.kind === 'drift') {
          a.obj.position.x += a.speed * dt;
          if (a.obj.position.x > a.limit) a.obj.position.x = -a.limit;
        } else if (a.kind === 'butterfly') {
          const s = t * a.sp + a.phase;
          a.obj.position.set(a.cx + Math.cos(s) * a.r, (a.baseY ?? 1.1) + Math.sin(t * 1.7 + a.phase) * 0.4, a.cz + Math.sin(s * 1.33) * a.r);
          const flap = 0.5 + Math.sin(t * (a.flap ?? 14) + a.phase) * 0.55;
          a.wingR.rotation.y = -flap;
          a.wingL.rotation.y = flap;
          a.obj.rotation.z = Math.cos(s) * 0.3;
        } else if (a.kind === 'smoke') {
          const ph = (t * a.speed + a.offset) % 1;
          a.obj.position.set(a.x + a.drift * ph, a.baseY + ph * a.rise, a.z);
          a.obj.scale.setScalar(0.5 + ph * 1.6);
          a.obj.material.opacity = 0.55 * (1 - ph * ph);
        }
      }
    };
  }
}

function ringSpawns(cx, cz, r, n = 12) {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return [cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r];
  });
}

function finish(builder, spawn, spawns = null) {
  builder.buildDecor(); // bake deferred grass/flowers into instanced meshes
  return {
    solids: builder.solids,
    colliders: builder.colliders,
    seekerSpawn: spawn,
    hiderSpawns: spawns || ringSpawns(0, 0, builder.bounds * 0.55),
    bounds: builder.bounds,
    animate: builder.makeAnimate(),
    sun: builder.sun,
    sunOffset: builder.sunOffset,
  };
}

const FLOWER_COLORS = ['#f2f0e4', '#f2b6c9', '#eab54e', '#c9a3e0'];
const HOUSE_STYLES = [
  { wall: '#dcb3ab', roof: '#c9564a', awning: '#e0824f' },
  { wall: '#efe0bd', roof: '#e0824f', awning: '#c9564a' },
  { wall: '#d9c2cf', roof: '#a86a6a', awning: '#8aa864' },
  { wall: '#e6d1a8', roof: '#8aa864', awning: '#c9564a' },
  { wall: '#d3c3de', roof: '#7f8fb3', awning: '#eab54e' },
];

export function buildMap(id, scene, seed = null) {
  rng = seed == null ? Math.random : seededRandom(seed);
  if (id === 'village') return buildVillage(scene);
  if (id === 'jungle') return buildJungle(scene);
  if (id === 'warehouse') return buildCrateYard(scene);
  if (id === 'forest') return buildMeadow(scene);
  return buildGarden(scene);
}

// ---------- 🌴 Jungle ----------
function buildJungle(scene) {
  const bounds = 128;
  const b = new Builder(scene, bounds);
  b.sky('#8fc3e0', '#d9e8b8');
  b.lights({ sunColor: '#ffedb8', sunI: 2.4, sky: '#e8f3d0', ground: '#41603f', ambI: 1.35 });
  b.ground('#5f8a4a', '#3a5c34');
  b.fence(3, '#4a6b3a');
  scene.fog = new THREE.Fog('#c2d8a8', 40, 175); // deep, close jungle haze
  // giant trees with flared roots and huge canopies
  const giants = [[-20, -16, 1.1], [16, -24, 1.3], [28, 12, 1], [-8, 22, 1.2], [-34, 6, 1], [8, 40, 1.1], [-28, -38, 1.2], [40, -10, 1.1], [-44, 28, 1], [22, -46, 1], [44, 34, 1.2], [-14, -2, 0.9]];
  giants.forEach(([x, z, s]) => b.bigTree(x, z, s));
  b.bigTree(-48, -12, 1); b.bigTree(50, 18, 1.1); b.bigTree(-6, -50, 1.2); b.bigTree(34, 48, 1);
  b.sprinkle(85, (x, z) => b.tree(x, z, 0.9 + rng() * 0.5, '#4a7040', '#8fb85f'), 12);
  // palms poking through the understorey
  for (let i = 0; i < 18; i++) {
    const a = rng() * Math.PI * 2, r = 10 + rng() * (bounds - 14);
    b.palm(Math.cos(a) * r, Math.sin(a) * r, 0.9 + rng() * 0.6);
  }
  // dense, dark undergrowth
  b.sprinkle(55, (x, z) => b.bush(x, z, 0.9 + rng() * 0.7, '#324d2a', '#4f7a3c'), 8);
  // caves to hide inside!
  b.cave(-30, -26, 1.4);
  b.cave(26, 28, 1.5);
  b.cave(38, -34, 1.3);
  b.cave(-44, 36, 1.4);
  // ferns, big drooping leaves, fallen logs, mossy rocks, mushrooms
  b.sprinkle(650, (x, z) => b.tuft(x, z, 1.7, '#3f6b35', '#87b45f'));
  b.sprinkle(130, (x, z) => b.tuft(x, z, 2.1 + rng(), '#2f5229', '#6fa14e')); // broad-leaf clumps
  for (const [x, z, rot] of [[-6, -20, 0.5], [18, 4, 1.4], [-22, 18, 2.0], [34, 22, 0.8], [-38, -12, 1.7], [4, -38, 0.3]]) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.7, 5.5, 9), toonMatC('#5f4426'));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rot;
    log.position.set(x, 0.65, z);
    b.place(log);
    b.colliders.push({ minX: x - 2.2, maxX: x + 2.2, minZ: z - 2.2, maxZ: z + 2.2, top: 1.3 });
  }
  for (const [x, z, s] of [[10, 14, 1.4], [-16, 34, 1.2], [32, -18, 1.5], [-42, -30, 1.3], [46, 8, 1.2], [-4, 48, 1.4]]) {
    const rock = gradRock('#6b6257', '#968b78', 1.1 * s);
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s });
  }
  b.sprinkle(30, (x, z) => {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.3), toonMatC('#e8dcc0'));
    stem.position.set(x, 0.15, z);
    b.place(stem, { solid: false, cast: false });
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 9, 7), toonMatC('#c9564a'));
    cap.scale.y = 0.6;
    cap.position.set(x, 0.34, z);
    b.place(cap, { solid: false });
  });
  // tropical blooms everywhere
  const TROPICAL = ['#f2543d', '#ff8c42', '#ffd166', '#f2b6c9', '#c9a3e0'];
  b.sprinkle(180, (x, z) => b.flower(x, z, TROPICAL[Math.floor(rng() * TROPICAL.length)]));
  // --- outskirts: the deep jungle ---
  for (let i = 0; i < 30; i++) {
    const a = rng() * Math.PI * 2, r = 60 + rng() * 58;
    b.bigTree(Math.cos(a) * r, Math.sin(a) * r, 0.9 + rng() * 0.5);
  }
  b.cave(-84, -60, 1.5); b.cave(70, 84, 1.4); b.cave(98, -30, 1.3);
  for (let i = 0; i < 8; i++) {
    const a = rng() * Math.PI * 2, r = 62 + rng() * 55;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.7, 5.5, 9), toonMatC('#5f4426'));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rng() * 3;
    log.position.set(x, 0.65, z);
    b.place(log);
    b.colliders.push({ minX: x - 2.2, maxX: x + 2.2, minZ: z - 2.2, maxZ: z + 2.2, top: 1.3, base: 0 });
  }
  for (let i = 0; i < 10; i++) {
    const a = rng() * Math.PI * 2, r = 62 + rng() * 55, s = 1 + rng();
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rock = gradRock('#6b6257', '#968b78', 1.1 * s);
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s, base: 0 });
  }
  // the volcano looming beyond the east wall, smoking away
  b.volcano(bounds + 95, -bounds * 0.35, 1.5);
  b.hill(bounds + 22, 60, 34, '#54774a'); b.hill(-bounds - 20, -20, 30, '#4c6f44'); b.hill(6, bounds + 24, 32, '#5b7f50');
  b.cloud(-30, 56, 20, 1.2); b.cloud(35, 62, -30, 1.4); b.cloud(0, 58, 55, 1);
  // clouds of big curved-wing butterflies, plus busy little bees near the blooms
  const BFLY = ['#f2b6c9', '#eab54e', '#8fd4f2', '#c9a3e0', '#ff8c42', '#f2f0e4', '#7fd49a', '#f2543d'];
  for (let i = 0; i < 16; i++) {
    const a = rng() * Math.PI * 2, r = 8 + rng() * bounds * 0.8;
    b.butterfly(Math.cos(a) * r, Math.sin(a) * r, BFLY[i % BFLY.length], 0.9 + rng() * 0.9);
  }
  for (let i = 0; i < 10; i++) {
    const a = rng() * Math.PI * 2, r = 8 + rng() * bounds * 0.7;
    b.bug(Math.cos(a) * r, Math.sin(a) * r);
  }
  const spawns = [
    [0, 0, -60], [0, 0, 60], [-52, 0, 16], [52, 0, -12], [-24, 0, -60], [28, 0, 60],
    [-72, 0, -16], [72, 0, 12], [-40, 0, 68], [40, 0, -64], [-80, 0, 40], [88, 0, -44],
    [-100, 0, -20], [100, 0, 30], [20, 0, -100], [-30, 0, 100],
  ];
  return finish(b, [0, 0, 0], spawns);
}

// ---------- 🏘️ Summer Village ----------
function buildVillage(scene) {
  const bounds = 120;
  const b = new Builder(scene, bounds);
  b.sky('#7ec3ec', '#fdeec6');
  b.lights({});
  b.ground('#a9cb74', '#7fa653');
  b.fence(1.7, '#d5cab2');

  // the street: asphalt, sidewalks, center dashes, crosswalks
  const road = b.flat(0, 0, 9, bounds * 2, '#b9bec4');
  road.userData.camoColor = '#b9bec4';
  b.solids.push(road);
  b.flat(-5.6, 0, 1.6, bounds * 2, '#dccfa8', 0.015);
  b.flat(5.6, 0, 1.6, bounds * 2, '#dccfa8', 0.015);
  for (let z = -bounds + 6; z < bounds - 4; z += 6) {
    if (Math.abs(z - 10) < 4 || Math.abs(z + 30) < 4 || Math.abs(z - 70) < 4 || Math.abs(z + 80) < 4) continue; // keep crosswalks clear
    b.flat(0, z, 0.35, 2.4, '#f2ecd7', 0.03);
  }
  for (const cz of [10, -30, 70, -80]) {
    for (let x = -3.3; x <= 3.3; x += 1.1) b.flat(x, cz, 0.75, 3.4, '#f2ecd7', 0.03);
  }

  // houses along the street (fronts face the road)
  const L = [[-12.5, -40, 0], [-13, -22, 1], [-12.5, -4, 2], [-13, 16, 3], [-12.5, 34, 4]];
  const R = [[12.5, -32, 1], [13, -14, 4], [12.5, 6, 0], [13, 24, 2], [12.5, 42, 1]];
  for (const [x, z, s] of L) b.house(x, z, Math.PI / 2, { ...HOUSE_STYLES[s], w: 6.5 + (s % 3), d: 5.5 + ((s + 1) % 2) });
  for (const [x, z, s] of R) b.house(x, z, -Math.PI / 2, { ...HOUSE_STYLES[s], w: 6.5 + ((s + 1) % 3), d: 5.5 + (s % 2) });
  // outskirt homes further along the (now much longer) road
  for (const [z, side, s] of [[-100, 1, 0], [-84, -1, 3], [-64, 1, 2], [58, -1, 4], [76, 1, 1], [96, -1, 0]]) {
    b.house(side * (12 + (s % 2) * 1.5), z, side > 0 ? -Math.PI / 2 : Math.PI / 2, { ...HOUSE_STYLES[s], w: 6.5 + (s % 3), d: 5.5 + (s % 2) });
  }
  // four big walk-in houses with stairs and an upstairs to hide in
  b.bigHouse(-24, -44, HOUSE_STYLES[1]);
  b.bigHouse(24, 44, HOUSE_STYLES[2]);
  b.bigHouse(-30, -84, HOUSE_STYLES[3]);
  b.bigHouse(30, 88, HOUSE_STYLES[4]);
  const nearBigHouse = (px, pz) =>
    (Math.abs(px + 24) < 7 && Math.abs(pz + 44) < 6) || (Math.abs(px - 24) < 7 && Math.abs(pz - 44) < 6) ||
    (Math.abs(px + 30) < 7 && Math.abs(pz + 84) < 6) || (Math.abs(px - 30) < 7 && Math.abs(pz - 88) < 6);

  // street lamps
  for (let i = 0; i < 14; i++) {
    const z = -104 + i * 16;
    const side = i % 2 ? 1 : -1;
    b.lamp(side * 4.8, z, -side);
  }

  // palms + trees + garden bits
  for (const [x, z, s] of [[-7, -46, 1.1], [7.5, -8, 1], [-7, 26, 1.25], [8, 36, 0.95], [19, -24, 1.15], [-19, 8, 1.05], [-24, 42, 1.2], [26, 16, 1]]) b.palm(x, z, s);
  b.sprinkle(80, (x, z) => { if (Math.abs(x) > 9 && !nearBigHouse(x, z)) b.tree(x, z, 0.9 + rng() * 0.5); }, 18);
  b.sprinkle(80, (x, z) => { if (Math.abs(x) > 8 && !nearBigHouse(x, z)) b.bush(x, z, 0.9 + rng() * 0.5); }, 14);
  for (let i = 0; i < 12; i++) { // palms sprinkled through the outskirts
    const a = rng() * Math.PI * 2, r = 55 + rng() * 55;
    const px = Math.cos(a) * r, pz = Math.sin(a) * r;
    if (Math.abs(px) > 9 && !nearBigHouse(px, pz)) b.palm(px, pz, 0.9 + rng() * 0.4);
  }
  // hedges + garden furniture + rocks
  b.box(-20, -12, 7, 1.6, 1, '#7fa05a');
  b.box(22, -2, 1, 1.6, 7, '#7fa05a');
  b.box(-24, 22, 1, 1.6, 8, '#7fa05a');
  b.box(26, 34, 8, 1.6, 1, '#7fa05a');
  b.box(-30, -22, 6, 1.6, 1, '#7fa05a');
  b.box(-4, 4, 3, 0.8, 1.4, '#d3a870', { y: 0 });
  b.box(20, 48, 3, 0.8, 1.4, '#d3a870', { y: 0 });
  b.box(-34, 40, 2, 2, 2, '#c99a63'); b.box(-32, 40, 2, 2, 2, '#a97c47');
  b.box(34, -44, 2, 2, 2, '#c99a63'); b.box(34, -42, 2, 2, 2, '#a97c47');
  b.cylinder(-40, -6, 0.7, 1.6, '#6f93b3'); b.cylinder(-38.6, -6.6, 0.7, 1.6, '#eab54e');
  for (const [x, z, s] of [[24, 30, 1.3], [-26, -30, 1.5], [30, -14, 1.1], [-38, 30, 1.4], [42, 22, 1.2], [8, -46, 1.3]]) {
    const rock = gradRock('#9a8f7c', '#c4baa4', 1.1 * s);
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s });
  }
  b.sprinkle(150, (x, z) => { if (Math.abs(x) > 7 && !nearBigHouse(x, z)) b.flower(x, z, FLOWER_COLORS[Math.floor(rng() * 4)]); }, 8);
  b.sprinkle(420, (x, z) => { if (Math.abs(x) > 7 && !nearBigHouse(x, z)) b.tuft(x, z, 0.9); }, 8);
  // garden huts you can hide inside
  b.hut(-20, 28, { door: 'E' });
  b.hut(20, -8, { door: 'W', wall: '#d9c2cf', roof: '#a86a6a' });
  b.hut(-26, -44, { door: 'N', wall: '#e6d1a8', roof: '#8aa864' });
  b.hut(30, 46, { door: 'S', wall: '#efe0bd', roof: '#e0824f' });

  // world beyond the walls: rolling hills and far palms
  b.hill(bounds + 20, -20, 28, '#9dc06c');
  b.hill(-bounds - 22, 12, 32, '#93b765');
  b.hill(12, bounds + 24, 30, '#a3c471');
  b.hill(-18, -bounds - 22, 26, '#8fb161');
  for (const [x, z] of [[bounds + 8, 10], [-bounds - 6, -26], [20, bounds + 8], [-30, bounds + 6]]) b.palm(x, z, 1.3);
  b.cloud(-40, 50, -25, 1.3); b.cloud(25, 58, 35, 1.5); b.cloud(55, 52, -10, 1); b.cloud(-15, 62, 50, 1.2);
  for (const [x, z, c] of [[0, 20, '#f2b6c9'], [-16, -8, '#eab54e'], [18, 12, '#f2f0e4'], [-8, 38, '#c9a3e0'], [10, -40, '#f2b6c9']]) b.butterfly(x, z, c);

  // hand-picked spawns that never land inside a house
  const spawns = [
    [0, 0, -68], [0, 0, 68], [-44, 0, -36], [44, 0, 36], [-40, 0, 40], [40, 0, -40],
    [-60, 0, 0], [60, 0, 8], [0, 0, -100], [8, 0, 100], [-48, 0, 72], [52, 0, -72],
    [-90, 0, 30], [90, 0, -30], [-70, 0, -70], [70, 0, 70],
  ];
  return finish(b, [0, 0, 10], spawns);
}

// ---------- 🏡 Sunny Garden ----------
function buildGarden(scene) {
  const bounds = 88;
  const b = new Builder(scene, bounds);
  b.sky('#8fc3ea', '#ffe9b8');
  b.lights({});
  b.ground('#a4cc6b', '#7ba14e');
  b.fence(2, '#e0bd8a');
  // the family house in one corner (two floors — go inside!) + garden shed
  b.bigHouse(-32, -32, HOUSE_STYLES[0]);
  b.bigHouse(58, 52, HOUSE_STYLES[3]);
  const nearBigHouse = (px, pz) =>
    (Math.abs(px + 32) < 7 && Math.abs(pz + 32) < 6) || (Math.abs(px - 58) < 7 && Math.abs(pz - 52) < 6);
  b.box(-14, -14, 5, 3, 0.3, '#efe3c2');
  b.box(-16.4, -12, 0.3, 3, 4.3, '#efe3c2');
  b.box(-11.6, -12, 0.3, 3, 4.3, '#efe3c2');
  b.box(-15.4, -9.9, 2.2, 3, 0.3, '#efe3c2');
  b.box(-14, -12, 5.4, 0.35, 4.8, '#cf7351', { y: 3 });
  // trees, palms + bushes
  b.tree(12, -12, 1.2); b.tree(16, 8, 1); b.tree(-8, 14, 1.1);
  b.sprinkle(55, (x, z) => { if (!nearBigHouse(x, z)) b.tree(x, z, 0.9 + rng() * 0.5); }, 18);
  // outskirts: orchard rows, spare huts, a far corner to explore
  for (let rx = -70; rx <= 70; rx += 20) {
    if (rx > -12 && rx < 12) continue;
    b.tree(rx, -62 + rng() * 4, 1 + rng() * 0.3);
    b.tree(rx + 8, -72 + rng() * 4, 0.9 + rng() * 0.3);
    b.tree(rx - 6, 62 + rng() * 4, 1 + rng() * 0.3);
    b.tree(rx + 10, 72 + rng() * 4, 0.9 + rng() * 0.3);
  }
  b.hut(-60, 20, { door: 'E' });
  b.hut(56, -44, { door: 'N', wall: '#d9c2cf', roof: '#a86a6a' });
  b.palm(-52, -58, 1.2); b.palm(70, 10, 1.1); b.palm(-70, 60, 1);
  b.box(-48, 48, 10, 1.8, 1, '#7fa05a');
  b.box(44, -20, 1, 1.8, 10, '#7fa05a');
  b.box(-64, -24, 2, 2, 2, '#c99a63'); b.box(-62, -24, 2, 2, 2, '#a97c47');
  b.cylinder(66, -66, 0.7, 1.6, '#6f93b3'); b.cylinder(64.6, -66.6, 0.7, 1.6, '#eab54e');
  b.palm(30, -26, 1.1); b.palm(-28, 24, 1.2); b.palm(36, 30, 1); b.palm(-36, -20, 1.15);
  b.bush(6, -6); b.bush(8, -4.5, 1.2); b.bush(-4, -16, 1.1); b.bush(18, -2, 1.3);
  b.bush(-18, 6, 1.2); b.bush(2, 16, 1); b.bush(4, 17.5, 1.2, '#5d7c40', '#94b25e');
  b.sprinkle(55, (x, z) => { if (!nearBigHouse(x, z)) b.bush(x, z, 0.9 + rng() * 0.5); }, 18);
  // bigger hedge maze
  b.box(10, 14, 8, 1.8, 1, '#7fa05a');
  b.box(13.5, 10.5, 1, 1.8, 8, '#7fa05a');
  b.box(8, 10, 4, 1.8, 1, '#7fa05a');
  b.box(24, 26, 12, 1.8, 1, '#7fa05a');
  b.box(29.5, 21, 1, 1.8, 11, '#7fa05a');
  b.box(19, 21, 1, 1.8, 6, '#7fa05a');
  b.box(24, 17, 6, 1.8, 1, '#7fa05a');
  // picnic table + sandbox + doghouse + trampoline
  b.box(-4, 4, 3, 0.8, 1.4, '#d3a870');
  b.box(-4, 2.9, 3, 0.45, 0.4, '#d3a870');
  b.box(-4, 5.1, 3, 0.45, 0.4, '#d3a870');
  b.box(14, 2, 3.5, 0.4, 3.5, '#e6d3a3');
  b.box(-9, 8, 1.8, 1.4, 1.8, '#d07a5e');
  b.cylinder(0, -14, 2.2, 0.9, '#5ba393');
  b.box(-26, 10, 2, 2, 2, '#c99a63'); b.box(-24, 10, 2, 2, 2, '#a97c47');
  for (const [sx, sz] of [[-6, -8], [-8, -9.5], [-10.5, -10]]) {
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.08, 9), toonMatC('#cfc3a2'));
    stone.position.set(sx, 0.04, sz);
    b.place(stone, { cast: false });
  }
  b.sprinkle(120, (x, z) => b.flower(x, z, FLOWER_COLORS[Math.floor(rng() * 4)]));
  b.sprinkle(340, (x, z) => b.tuft(x, z, 0.9));
  b.hut(20, -30, { door: 'N', wall: '#e6d1a8', roof: '#8aa864' });
  b.hut(-34, 34, { door: 'E', wall: '#d9c2cf', roof: '#a86a6a' });
  b.box(28, 14, 8, 1.8, 1, '#7fa05a');
  b.box(-14, -30, 1, 1.8, 8, '#7fa05a');
  b.hill(bounds + 16, -10, 24, '#9dc06c'); b.hill(-bounds - 18, 16, 28, '#93b765'); b.hill(8, bounds + 18, 26, '#a3c471');
  b.cloud(-30, 46, -20, 1.1); b.cloud(20, 54, 28, 1.4); b.cloud(44, 48, -8, 0.9);
  b.butterfly(4, 4); b.butterfly(-8, -4, '#eab54e'); b.butterfly(14, 14, '#f2f0e4'); b.butterfly(-20, 18, '#c9a3e0');
  return finish(b, [0, 0, 0]);
}

// ---------- 📦 Crate Yard ----------
function buildCrateYard(scene) {
  const bounds = 104;
  const b = new Builder(scene, bounds);
  b.sky('#a7cbe0', '#ffe6b8');
  b.lights({ sunPos: [30, 34, 20], sunColor: '#ffd9a0', ground: '#b3a071' });
  b.ground('#d8c49a', '#b99f6f');
  b.fence(5, '#e6d5ae');
  const crate = '#c99a63', crate2 = '#a97c47';
  // crate stack clusters (climbable!)
  const core = [[-14, -12], [9, -15], [15, 7], [-5, 14], [-30, 8], [28, -24], [-24, -32], [34, 20], [-36, 28], [20, 36], [-12, 38], [38, -6], [-42, -10], [44, 34], [-8, -42], [42, -38], [-44, 42], [6, 44], [24, -42], [-40, 16]];
  // outskirt clusters: the same layout stamped again at nearly double the radius
  const clusters = [...core, ...core.slice(0, 16).map(([cx, cz]) => [Math.round(cx * 1.95), Math.round(cz * 1.95)])];
  clusters.forEach(([cx, cz], i) => {
    b.box(cx - 1, cz, 2, 2, 2, crate);
    b.box(cx + 1, cz, 2, 2, 2, i % 2 ? crate2 : crate);
    b.box(cx, cz, 2, 2, 2, i % 2 ? crate : crate2, { y: 2 });
    if (i % 3 === 0) b.box(cx, cz + 2.1, 2, 2, 2, crate2);
  });
  // shelving rows with crawl gaps
  for (const [sx, sz] of [[-16, 4], [0, -4], [12, -4], [-28, -18], [24, 12], [4, 28], [-8, -34], [32, -34], [-38, -34], [40, 8], [-20, 40], [16, -28], [-64, 30], [58, -52], [-74, -22], [66, 48], [-32, 74], [22, -76]]) {
    b.box(sx - 3.4, sz, 0.5, 2.2, 3, '#8a7048');
    b.box(sx + 3.4, sz, 0.5, 2.2, 3, '#8a7048');
    b.box(sx, sz, 7.6, 0.4, 3.2, '#a08454', { y: 2.2 });
  }
  // two shipping containers, open ends
  for (const [ox, oz, col, col2] of [[4, 12, '#d07a5e', '#b3593f'], [-26, 24, '#7f9bb3', '#5f7b93'], [-58, -60, '#8aa864', '#6d8148'], [64, 66, '#d07a5e', '#b3593f']]) {
    b.box(ox - 2, oz, 0.3, 3, 8, col);
    b.box(ox + 2, oz, 0.3, 3, 8, col);
    b.box(ox, oz + 4, 4.3, 3, 0.3, col);
    b.box(ox, oz, 4.3, 0.3, 8, col2, { y: 3 });
  }
  // pastel barrels
  const barrelCols = ['#6f93b3', '#eab54e', '#8aa864', '#9c6b8f', '#d07a5e', '#5ba393'];
  b.sprinkle(30, (x, z) => b.cylinder(x, z, 0.7, 1.6, barrelCols[Math.floor(rng() * 6)]), 10);
  b.sprinkle(240, (x, z) => b.tuft(x, z, 0.9, '#a99a5c', '#d9cc84'));
  b.palm(-42, -40, 1.2); b.palm(44, 40, 1.1);
  b.hill(bounds + 18, 10, 26, '#c4b083'); b.hill(-bounds - 16, -18, 24, '#b9a878');
  b.cloud(-30, 44, -20); b.cloud(20, 52, 30, 1.3); b.cloud(48, 48, -10, 0.9);
  b.butterfly(0, -8, '#eab54e'); b.butterfly(10, 10, '#f2f0e4'); b.butterfly(-20, 20, '#f2b6c9');
  return finish(b, [0, 0, 0]);
}

// ---------- 🌾 Golden Meadow ----------
function buildMeadow(scene) {
  const bounds = 120;
  const b = new Builder(scene, bounds);
  b.sky('#bcd6e8', '#ffdda0');
  b.lights({ sunPos: [34, 18, -12], sunColor: '#ffc98a', sky: '#ffe9c4', ground: '#8f9552', ambI: 1.4 });
  b.ground('#b3b465', '#8a9048');
  b.fence(2.5, '#c9a06a');
  const spots = [[-18, -14], [-10, -20], [6, -18], [16, -10], [20, 4], [14, 16], [2, 20], [-12, 16], [-20, 6], [-6, -8], [8, 6], [-15, -3]];
  spots.forEach(([x, z], i) => b.tree(x, z, 0.9 + (i % 3) * 0.25, '#7c8b44', '#e3d878'));
  b.sprinkle(95, (x, z) => b.tree(x, z, 0.85 + rng() * 0.6, '#7c8b44', '#e3d878'), 22);
  // tall golden grass to lie down in
  for (const [gx, gz, gs] of [[-6, 10, 1.4], [10, -6, 1.2], [18, 12, 1], [-16, -18, 1.3], [30, -26, 1.5], [-34, 22, 1.4], [24, 34, 1.2], [-28, -36, 1.3], [-62, 44, 1.6], [58, -50, 1.5], [-52, -66, 1.4], [70, 62, 1.6], [-84, 8, 1.3], [86, -14, 1.4], [12, -84, 1.5], [-20, 88, 1.4]]) {
    for (let i = 0; i < 10 * gs; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 2 * gs;
      b.tuft(gx + Math.cos(a) * r, gz + Math.sin(a) * r, 1.5, '#a3a353', '#e8d98a');
    }
  }
  // warm rocks
  for (const [x, z, s] of [[4, -10, 1.4], [-10, 4, 1.1], [12, 10, 1.6], [-20, -8, 1.2], [34, 8, 1.7], [-38, -14, 1.4], [8, -38, 1.3], [-12, 40, 1.5]]) {
    const rock = gradRock('#9a8f7c', '#c4baa4', 1.1 * s);
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s });
  }
  // fallen logs
  for (const [x, z, rot] of [[-2, -16, 0.4], [16, -2, 1.2], [-14, 10, 2.2], [28, 20, 0.9], [-30, -26, 1.8], [36, -18, 0.2]]) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.65, 5, 9), toonMatC('#8a6642'));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rot;
    log.position.set(x, 0.6, z);
    b.place(log);
    b.colliders.push({ minX: x - 2, maxX: x + 2, minZ: z - 2, maxZ: z + 2, top: 1.2 });
  }
  // pond with lily pads
  const pond = new THREE.Mesh(new THREE.CircleGeometry(4, 24), toonMatC('#8fc2d8'));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(0, 0.02, -2);
  b.place(pond, { cast: false });
  for (const [px, pz] of [[-1.2, -2.5], [1.5, -1], [0.4, -3.4]]) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.4, 10), toonMatC('#7fa05a'));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(px, 0.04, pz);
    scene.add(pad);
  }
  b.sprinkle(90, (x, z) => b.flower(x, z, FLOWER_COLORS[Math.floor(rng() * 4)]));
  b.sprinkle(200, (x, z) => b.tuft(x, z, 1, '#a3a353', '#ddd07e'));
  b.hut(-30, 8, { door: 'S', wall: '#c9b489', roof: '#8a7048' });
  b.hut(66, -38, { door: 'W', wall: '#c9b489', roof: '#8a7048' });
  b.hut(-72, 58, { door: 'E', wall: '#e6d1a8', roof: '#8aa864' });
  // outskirt rocks and logs so the far meadow has cover too
  for (let i = 0; i < 12; i++) {
    const a = rng() * Math.PI * 2, r = 62 + rng() * 52, s = 1 + rng() * 0.8;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const rock = gradRock('#9a8f7c', '#c4baa4', 1.1 * s);
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s, base: 0 });
  }
  for (let i = 0; i < 8; i++) {
    const a = rng() * Math.PI * 2, r = 62 + rng() * 50;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.65, 5, 9), toonMatC('#8a6642'));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rng() * 3;
    log.position.set(x, 0.6, z);
    b.place(log);
    b.colliders.push({ minX: x - 2, maxX: x + 2, minZ: z - 2, maxZ: z + 2, top: 1.2, base: 0 });
  }
  b.hill(bounds + 20, 14, 30, '#a8a460'); b.hill(-bounds - 22, -10, 34, '#9c9a58'); b.hill(-10, bounds + 22, 28, '#b0ae66');
  b.cloud(-35, 42, 15, 1.2); b.cloud(25, 54, -25); b.cloud(50, 46, 20, 0.8); b.cloud(-55, 50, -35, 1.1);
  b.butterfly(-6, 10); b.butterfly(10, -6, '#eab54e'); b.butterfly(0, 14, '#f2f0e4'); b.butterfly(-14, -10, '#c9a3e0'); b.butterfly(26, -22, '#f2b6c9');
  return finish(b, [0, 0, 6]);
}
