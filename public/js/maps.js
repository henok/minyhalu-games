// Four big maps in a warm, cel-shaded "summer afternoon" style:
// gradient skies, blobby swaying trees, detailed little houses, palm trees,
// street lamps, drifting clouds, butterflies and rolling hills on the horizon.
// Every map returns { solids, colliders, seekerSpawn, hiderSpawns, bounds, animate }

import * as THREE from 'three';
import { toonMat, toonVertexMat } from './avatar.js';

export const MAPS = {
  village: { name: '🏘️ Summer Village', desc: 'A sunny street with houses, palm trees and gardens' },
  jungle: { name: '🌴 Jungle', desc: 'Giant trees, ferns and dark caves to hide inside' },
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

class Builder {
  constructor(scene, bounds) {
    this.scene = scene;
    this.bounds = bounds;
    this.solids = [];     // meshes bullets can hit / camo can sample
    this.colliders = [];  // {minX,maxX,minZ,maxZ,top} walk-blockers / climbables
    this.animated = [];   // {kind, obj, ...} updated every frame
  }
  place(mesh, { solid = true, cast = true, receive = true } = {}) {
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    this.scene.add(mesh);
    if (solid) this.solids.push(mesh);
    return mesh;
  }
  collideBox(x, z, w, d, top) {
    this.colliders.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top });
  }
  box(x, z, w, h, d, color, { collide = true, y = 0, solid = true, rotY = 0 } = {}) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMat(color));
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.y = rotY;
    this.place(mesh, { solid });
    if (collide) {
      const half = rotY ? Math.max(w, d) : 0;
      this.collideBox(x, z, half || w, half || d, y + h);
    }
    return mesh;
  }
  cylinder(x, z, r, h, color, { collide = true, y = 0, r2 = null, tilt = 0 } = {}) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(r, r2 ?? r, h, 10), toonMat(color));
    mesh.position.set(x, y + h / 2, z);
    mesh.rotation.z = tilt;
    this.place(mesh);
    if (collide) this.colliders.push({ minX: x - r, maxX: x + r, minZ: z - r, maxZ: z + r, top: y + h });
    return mesh;
  }

  // --- sky, light, ground ---
  sky(top, horizon) {
    const R = Math.max(240, this.bounds * 4.2);
    const geo = new THREE.SphereGeometry(R, 24, 12);
    gradientize(geo, horizon, top, R * 0.03, R * 0.85);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, toneMapped: false }));
    this.scene.add(mesh);
    this.scene.background = new THREE.Color(horizon);
    this.scene.fog = new THREE.Fog(horizon, this.bounds * 0.9, Math.max(140, this.bounds * 3.4));
  }
  lights({ sunColor = '#ffdfae', sunPos = [26, 40, 16], sunI = 2.8, sky = '#fff3d8', ground = '#93a862', ambI = 1.5 }) {
    const sun = new THREE.DirectionalLight(sunColor, sunI);
    sun.position.set(...sunPos);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const B = this.bounds * 1.25;
    Object.assign(sun.shadow.camera, { left: -B, right: B, top: B, bottom: -B, near: 1, far: 220 });
    sun.shadow.bias = -0.0006;
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(sky, ground, ambI));
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
    const tilt = (Math.random() - 0.5) * 0.12;
    this.cylinder(x, z, 0.22 * s, 2.3 * s, '#8a6642', { r2: 0.34 * s, tilt, collide: false });
    this.colliders.push({ minX: x - 0.4 * s, maxX: x + 0.4 * s, minZ: z - 0.4 * s, maxZ: z + 0.4 * s, top: 99 });
    const blobs = [
      [0, 3.1 * s, 0, 1.5 * s],
      [0.9 * s, 2.6 * s, 0.3 * s, 1.0 * s],
      [-0.8 * s, 2.7 * s, -0.4 * s, 0.9 * s],
    ];
    for (const [bx, by, bz, br] of blobs) {
      const blob = gradMesh(new THREE.SphereGeometry(br, 10, 8), lo, hi, { camo: lo });
      blob.position.set(x + bx + tilt * 2, by, z + bz);
      blob.scale.y = 0.88;
      this.place(blob);
      this.animated.push({ kind: 'sway', obj: blob, phase: x + z + by, amp: 0.02 });
    }
  }
  palm(x, z, s = 1) {
    const g = new THREE.Group();
    const lean = (Math.random() - 0.5) * 0.55;
    const trunkMat = toonMat('#b3946a');
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
    const frondMat = toonMat('#4e8a4e');
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
    const cocoMat = toonMat('#7a5230');
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
    const blob = gradMesh(new THREE.SphereGeometry(0.9 * s, 9, 7), lo, hi, { camo: lo });
    blob.position.set(x, 0.62 * s, z);
    blob.scale.set(1.1, 0.8, 1.1);
    this.place(blob);
    const puff = gradMesh(new THREE.SphereGeometry(0.55 * s, 8, 6), lo, hi, { camo: lo });
    puff.position.set(x + 0.5 * s, 0.5 * s, z - 0.3 * s);
    this.place(puff);
    this.colliders.push({ minX: x - 0.6 * s, maxX: x + 0.6 * s, minZ: z - 0.6 * s, maxZ: z + 0.6 * s, top: 1.1 * s });
    this.animated.push({ kind: 'sway', obj: blob, phase: x * 3, amp: 0.015 });
  }
  tuft(x, z, s = 1, lo = '#87a552', hi = '#d6cf7c') {
    const g = new THREE.Group();
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const blade = gradMesh(new THREE.ConeGeometry(0.09 * s, (0.55 + Math.random() * 0.5) * s, 5), lo, hi);
      blade.position.set((Math.random() - 0.5) * 0.5 * s, blade.geometry.parameters.height / 2, (Math.random() - 0.5) * 0.5 * s);
      blade.rotation.z = (Math.random() - 0.5) * 0.25;
      blade.castShadow = false;
      g.add(blade);
    }
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.animated.push({ kind: 'sway', obj: g, phase: x * 1.7 + z, amp: 0.09 });
  }
  flower(x, z, color) {
    const g = new THREE.Group();
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.02, 0.3), toonMat('#7a9a4e'));
    stem.position.y = 0.15;
    g.add(stem);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), toonMat(color));
    head.position.y = 0.33;
    g.add(head);
    g.position.set(x, 0, z);
    this.scene.add(g);
    this.animated.push({ kind: 'sway', obj: g, phase: x + z * 2, amp: 0.12 });
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
    const body = add(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toonMat(wall)));
    body.position.y = h / 2;
    // pyramid roof with a little overhang
    const roofGeo = new THREE.ConeGeometry(0.74, 1, 4);
    roofGeo.rotateY(Math.PI / 4);
    const roofM = add(new THREE.Mesh(roofGeo, toonMat(roof)));
    roofM.scale.set(w * 1.08, h * 0.55, d * 1.08);
    roofM.position.y = h + h * 0.272;
    const chim = add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.2, 0.5), toonMat(wall)));
    chim.position.set(w * 0.28, h + h * 0.4, -d * 0.18);
    // windows + door + awning
    const winMat = toonMat('#9fb9cf');
    const frameMat = toonMat('#f4ead2');
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
    const door = add(new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.9, 0.16), toonMat('#8a6642')));
    door.position.set(0, 0.95, d / 2);
    const awn = add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.1, 1.1), toonMat(awning)));
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
    const roofM = new THREE.Mesh(roofGeo, toonMat(roof));
    roofM.scale.set(w * 1.15, h * 0.5, d * 1.15);
    roofM.position.set(x, h + h * 0.25, z);
    this.place(roofM);
  }
  cave(x, z, s = 1.4) {
    // rocky shelter with a dark inside, entrance on the +z side
    const rock = (rx, rz, rr) => {
      const m = gradMesh(new THREE.DodecahedronGeometry(rr), '#6b6257', '#968b78', { camo: '#7a7060' });
      m.position.set(x + rx, rr * 0.7, z + rz);
      this.place(m);
    };
    rock(-2.2 * s, 0.3 * s, 1.6 * s);
    rock(2.2 * s, 0.3 * s, 1.6 * s);
    rock(0, -2.2 * s, 1.9 * s);
    const top = gradMesh(new THREE.DodecahedronGeometry(2.6 * s), '#5f574d', '#8a8070', { camo: '#6b6257' });
    top.position.set(x, 2.9 * s, z - 0.5 * s);
    top.scale.set(1.25, 0.55, 1.15);
    this.place(top);
    // three walls collide; the front stays open so you can slip in
    this.collideBox(x - 2.2 * s, z + 0.3 * s, 2.4 * s, 2.6 * s, 99);
    this.collideBox(x + 2.2 * s, z + 0.3 * s, 2.4 * s, 2.6 * s, 99);
    this.collideBox(x, z - 2.2 * s, 3 * s, 2.4 * s, 99);
  }
  bigTree(x, z, s = 1) {
    // jungle giant: flared roots, thick trunk, huge canopy
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.55 * s, 0.8 * s, 6.5 * s, 10), toonMat('#6e4f32'));
    trunk.position.set(x, 3.25 * s, z);
    this.place(trunk);
    this.colliders.push({ minX: x - 0.8 * s, maxX: x + 0.8 * s, minZ: z - 0.8 * s, maxZ: z + 0.8 * s, top: 99 });
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      const root = new THREE.Mesh(new THREE.CylinderGeometry(0.18 * s, 0.3 * s, 1.6 * s, 6), toonMat('#6e4f32'));
      root.position.set(x + Math.cos(a) * 0.85 * s, 0.5 * s, z + Math.sin(a) * 0.85 * s);
      root.rotation.z = Math.cos(a) * 0.5;
      root.rotation.x = -Math.sin(a) * 0.5;
      this.place(root);
    }
    for (const [bx, by, bz, br] of [[0, 7 * s, 0, 3.2 * s], [2 * s, 6 * s, 0.8 * s, 2.2 * s], [-1.8 * s, 6.3 * s, -0.9 * s, 2.4 * s]]) {
      const blob = gradMesh(new THREE.SphereGeometry(br, 10, 8), '#3f6b35', '#7fae57', { camo: '#4a7040' });
      blob.position.set(x + bx, by, z + bz);
      blob.scale.y = 0.8;
      this.place(blob);
      this.animated.push({ kind: 'sway', obj: blob, phase: x + by, amp: 0.015 });
    }
  }
  lamp(x, z, side = 1) {
    const mat = toonMat('#5a6152');
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
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 10), toonMat(color));
    m.position.set(x, -r * 0.62, z);
    m.scale.y = 0.6;
    m.castShadow = false;
    m.receiveShadow = true;
    this.scene.add(m);
  }
  flat(x, z, w, d, color, y = 0.02) {
    // road / path pieces: flat, no collision
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), toonMat(color));
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
    this.animated.push({ kind: 'drift', obj: g, speed: 0.25 + Math.random() * 0.35, limit: this.bounds * 4 });
  }
  butterfly(cx, cz, color = '#f2b6c9') {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide });
    const wingGeo = new THREE.PlaneGeometry(0.16, 0.22);
    wingGeo.translate(0.09, 0, 0);
    const wingR = new THREE.Mesh(wingGeo, mat);
    const wingL = new THREE.Mesh(wingGeo.clone(), mat);
    wingL.scale.x = -1;
    g.add(wingR, wingL);
    g.rotation.x = -0.6;
    this.scene.add(g);
    this.animated.push({
      kind: 'butterfly', obj: g, wingR, wingL,
      cx, cz, r: 2.5 + Math.random() * 3, sp: 0.25 + Math.random() * 0.3, phase: Math.random() * 9,
    });
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
      const a = Math.random() * Math.PI * 2;
      const r = exclude + Math.random() * (this.bounds - exclude - 2);
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
          a.obj.position.set(a.cx + Math.cos(s) * a.r, 1.1 + Math.sin(t * 1.7 + a.phase) * 0.4, a.cz + Math.sin(s * 1.33) * a.r);
          const flap = 0.5 + Math.sin(t * 14 + a.phase) * 0.55;
          a.wingR.rotation.y = -flap;
          a.wingL.rotation.y = flap;
          a.obj.rotation.z = Math.cos(s) * 0.3;
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
  return {
    solids: builder.solids,
    colliders: builder.colliders,
    seekerSpawn: spawn,
    hiderSpawns: spawns || ringSpawns(0, 0, builder.bounds * 0.55),
    bounds: builder.bounds,
    animate: builder.makeAnimate(),
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

export function buildMap(id, scene) {
  if (id === 'village') return buildVillage(scene);
  if (id === 'jungle') return buildJungle(scene);
  if (id === 'warehouse') return buildCrateYard(scene);
  if (id === 'forest') return buildMeadow(scene);
  return buildGarden(scene);
}

// ---------- 🌴 Jungle ----------
function buildJungle(scene) {
  const bounds = 64;
  const b = new Builder(scene, bounds);
  b.sky('#8fc3e0', '#d9e8b8');
  b.lights({ sunColor: '#ffedb8', sunI: 2.4, sky: '#e8f3d0', ground: '#41603f', ambI: 1.35 });
  b.ground('#5f8a4a', '#3a5c34');
  b.fence(3, '#4a6b3a');
  scene.fog = new THREE.Fog('#c2d8a8', bounds * 0.45, bounds * 2.3); // thicker jungle haze
  // giant trees with flared roots and huge canopies
  const giants = [[-20, -16, 1.1], [16, -24, 1.3], [28, 12, 1], [-8, 22, 1.2], [-34, 6, 1], [8, 40, 1.1], [-28, -38, 1.2], [40, -10, 1.1], [-44, 28, 1], [22, -46, 1], [44, 34, 1.2], [-14, -2, 0.9]];
  giants.forEach(([x, z, s]) => b.bigTree(x, z, s));
  b.bigTree(-48, -12, 1); b.bigTree(50, 18, 1.1); b.bigTree(-6, -50, 1.2); b.bigTree(34, 48, 1);
  b.sprinkle(22, (x, z) => b.tree(x, z, 0.9 + Math.random() * 0.5, '#4a7040', '#8fb85f'), 12);
  // caves to hide inside!
  b.cave(-30, -26, 1.4);
  b.cave(26, 28, 1.5);
  b.cave(38, -34, 1.3);
  b.cave(-44, 36, 1.4);
  // ferns, fallen logs, mossy rocks, mushrooms
  b.sprinkle(88, (x, z) => b.tuft(x, z, 1.7, '#3f6b35', '#87b45f'));
  for (const [x, z, rot] of [[-6, -20, 0.5], [18, 4, 1.4], [-22, 18, 2.0], [34, 22, 0.8], [-38, -12, 1.7], [4, -38, 0.3]]) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.7, 5.5, 9), toonMat('#5f4426'));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rot;
    log.position.set(x, 0.65, z);
    b.place(log);
    b.colliders.push({ minX: x - 2.2, maxX: x + 2.2, minZ: z - 2.2, maxZ: z + 2.2, top: 1.3 });
  }
  for (const [x, z, s] of [[10, 14, 1.4], [-16, 34, 1.2], [32, -18, 1.5], [-42, -30, 1.3], [46, 8, 1.2], [-4, 48, 1.4]]) {
    const rock = gradMesh(new THREE.DodecahedronGeometry(1.1 * s), '#6b6257', '#968b78', { camo: '#7a7060' });
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s });
  }
  b.sprinkle(9, (x, z) => {
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.3), toonMat('#e8dcc0'));
    stem.position.set(x, 0.15, z);
    b.place(stem, { solid: false, cast: false });
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 9, 7), toonMat('#c9564a'));
    cap.scale.y = 0.6;
    cap.position.set(x, 0.34, z);
    b.place(cap, { solid: false });
  });
  b.sprinkle(20, (x, z) => b.flower(x, z, FLOWER_COLORS[Math.floor(Math.random() * 4)]));
  b.hill(bounds + 22, 0, 34, '#54774a'); b.hill(-bounds - 20, -20, 30, '#4c6f44'); b.hill(6, bounds + 24, 32, '#5b7f50');
  b.cloud(-30, 56, 20, 1.2); b.cloud(35, 62, -30, 1.4); b.cloud(0, 58, 55, 1);
  b.butterfly(-10, 6, '#eab54e'); b.butterfly(14, -12); b.butterfly(-24, 26, '#f2f0e4'); b.butterfly(30, 34, '#c9a3e0'); b.butterfly(0, -34, '#f2b6c9'); b.butterfly(-38, -18, '#eab54e');
  const spawns = [
    [0, 0, -30], [0, 0, 30], [-26, 0, 8], [26, 0, -6], [-12, 0, -30], [14, 0, 30],
    [-36, 0, -8], [36, 0, 6], [-20, 0, 34], [20, 0, -32], [-40, 0, 20], [44, 0, -22],
  ];
  return finish(b, [0, 0, 0], spawns);
}

// ---------- 🏘️ Summer Village ----------
function buildVillage(scene) {
  const bounds = 60;
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
    if (Math.abs(z - 10) < 4 || Math.abs(z + 30) < 4) continue; // keep crosswalks clear
    b.flat(0, z, 0.35, 2.4, '#f2ecd7', 0.03);
  }
  for (const cz of [10, -30]) {
    for (let x = -3.3; x <= 3.3; x += 1.1) b.flat(x, cz, 0.75, 3.4, '#f2ecd7', 0.03);
  }

  // houses along the street (fronts face the road)
  const L = [[-12.5, -40, 0], [-13, -22, 1], [-12.5, -4, 2], [-13, 16, 3], [-12.5, 34, 4]];
  const R = [[12.5, -32, 1], [13, -14, 4], [12.5, 6, 0], [13, 24, 2], [12.5, 42, 1]];
  for (const [x, z, s] of L) b.house(x, z, Math.PI / 2, { ...HOUSE_STYLES[s], w: 6.5 + (s % 3), d: 5.5 + ((s + 1) % 2) });
  for (const [x, z, s] of R) b.house(x, z, -Math.PI / 2, { ...HOUSE_STYLES[s], w: 6.5 + ((s + 1) % 3), d: 5.5 + (s % 2) });

  // street lamps
  for (let i = 0; i < 7; i++) {
    const z = -48 + i * 16;
    const side = i % 2 ? 1 : -1;
    b.lamp(side * 4.8, z, -side);
  }

  // palms + trees + garden bits
  for (const [x, z, s] of [[-7, -46, 1.1], [7.5, -8, 1], [-7, 26, 1.25], [8, 36, 0.95], [19, -24, 1.15], [-19, 8, 1.05], [-24, 42, 1.2], [26, 16, 1]]) b.palm(x, z, s);
  b.sprinkle(30, (x, z) => { if (Math.abs(x) > 9) b.tree(x, z, 0.9 + Math.random() * 0.5); }, 18);
  b.sprinkle(30, (x, z) => { if (Math.abs(x) > 8) b.bush(x, z, 0.9 + Math.random() * 0.5); }, 14);
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
    const rock = gradMesh(new THREE.DodecahedronGeometry(1.1 * s), '#9a8f7c', '#c4baa4', { camo: '#a89d88' });
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s });
  }
  b.sprinkle(48, (x, z) => { if (Math.abs(x) > 7) b.flower(x, z, FLOWER_COLORS[Math.floor(Math.random() * 4)]); }, 8);
  b.sprinkle(72, (x, z) => { if (Math.abs(x) > 7) b.tuft(x, z, 0.9); }, 8);
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
    [0, 0, -34], [0, 0, 34], [-22, 0, -18], [22, 0, 18], [-20, 0, 20], [20, 0, -20],
    [-30, 0, 0], [30, 0, 4], [0, 0, -50], [4, 0, 50], [-24, 0, 36], [26, 0, -36],
  ];
  return finish(b, [0, 0, 10], spawns);
}

// ---------- 🏡 Sunny Garden ----------
function buildGarden(scene) {
  const bounds = 44;
  const b = new Builder(scene, bounds);
  b.sky('#8fc3ea', '#ffe9b8');
  b.lights({});
  b.ground('#a4cc6b', '#7ba14e');
  b.fence(2, '#e0bd8a');
  // the family house in one corner + garden shed you can walk into
  b.house(-32, -32, Math.PI / 4 * 2, HOUSE_STYLES[0]);
  b.box(-14, -14, 5, 3, 0.3, '#efe3c2');
  b.box(-16.4, -12, 0.3, 3, 4.3, '#efe3c2');
  b.box(-11.6, -12, 0.3, 3, 4.3, '#efe3c2');
  b.box(-15.4, -9.9, 2.2, 3, 0.3, '#efe3c2');
  b.box(-14, -12, 5.4, 0.35, 4.8, '#cf7351', { y: 3 });
  // trees, palms + bushes
  b.tree(12, -12, 1.2); b.tree(16, 8, 1); b.tree(-8, 14, 1.1);
  b.sprinkle(20, (x, z) => b.tree(x, z, 0.9 + Math.random() * 0.5), 18);
  b.palm(30, -26, 1.1); b.palm(-28, 24, 1.2); b.palm(36, 30, 1); b.palm(-36, -20, 1.15);
  b.bush(6, -6); b.bush(8, -4.5, 1.2); b.bush(-4, -16, 1.1); b.bush(18, -2, 1.3);
  b.bush(-18, 6, 1.2); b.bush(2, 16, 1); b.bush(4, 17.5, 1.2, '#5d7c40', '#94b25e');
  b.sprinkle(22, (x, z) => b.bush(x, z, 0.9 + Math.random() * 0.5), 18);
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
    const stone = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.6, 0.08, 9), toonMat('#cfc3a2'));
    stone.position.set(sx, 0.04, sz);
    b.place(stone, { cast: false });
  }
  b.sprinkle(46, (x, z) => b.flower(x, z, FLOWER_COLORS[Math.floor(Math.random() * 4)]));
  b.sprinkle(68, (x, z) => b.tuft(x, z, 0.9));
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
  const bounds = 52;
  const b = new Builder(scene, bounds);
  b.sky('#a7cbe0', '#ffe6b8');
  b.lights({ sunPos: [30, 34, 20], sunColor: '#ffd9a0', ground: '#b3a071' });
  b.ground('#d8c49a', '#b99f6f');
  b.fence(5, '#e6d5ae');
  const crate = '#c99a63', crate2 = '#a97c47';
  // crate stack clusters (climbable!)
  const clusters = [[-14, -12], [9, -15], [15, 7], [-5, 14], [-30, 8], [28, -24], [-24, -32], [34, 20], [-36, 28], [20, 36], [-12, 38], [38, -6], [-42, -10], [44, 34], [-8, -42], [42, -38], [-44, 42], [6, 44], [24, -42], [-40, 16]];
  clusters.forEach(([cx, cz], i) => {
    b.box(cx - 1, cz, 2, 2, 2, crate);
    b.box(cx + 1, cz, 2, 2, 2, i % 2 ? crate2 : crate);
    b.box(cx, cz, 2, 2, 2, i % 2 ? crate : crate2, { y: 2 });
    if (i % 3 === 0) b.box(cx, cz + 2.1, 2, 2, 2, crate2);
  });
  // shelving rows with crawl gaps
  for (const [sx, sz] of [[-16, 4], [0, -4], [12, -4], [-28, -18], [24, 12], [4, 28], [-8, -34], [32, -34], [-38, -34], [40, 8], [-20, 40], [16, -28]]) {
    b.box(sx - 3.4, sz, 0.5, 2.2, 3, '#8a7048');
    b.box(sx + 3.4, sz, 0.5, 2.2, 3, '#8a7048');
    b.box(sx, sz, 7.6, 0.4, 3.2, '#a08454', { y: 2.2 });
  }
  // two shipping containers, open ends
  for (const [ox, oz, col, col2] of [[4, 12, '#d07a5e', '#b3593f'], [-26, 24, '#7f9bb3', '#5f7b93']]) {
    b.box(ox - 2, oz, 0.3, 3, 8, col);
    b.box(ox + 2, oz, 0.3, 3, 8, col);
    b.box(ox, oz + 4, 4.3, 3, 0.3, col);
    b.box(ox, oz, 4.3, 0.3, 8, col2, { y: 3 });
  }
  // pastel barrels
  const barrelCols = ['#6f93b3', '#eab54e', '#8aa864', '#9c6b8f', '#d07a5e', '#5ba393'];
  b.sprinkle(18, (x, z) => b.cylinder(x, z, 0.7, 1.6, barrelCols[Math.floor(Math.random() * 6)]), 10);
  b.sprinkle(46, (x, z) => b.tuft(x, z, 0.9, '#a99a5c', '#d9cc84'));
  b.palm(-42, -40, 1.2); b.palm(44, 40, 1.1);
  b.hill(bounds + 18, 10, 26, '#c4b083'); b.hill(-bounds - 16, -18, 24, '#b9a878');
  b.cloud(-30, 44, -20); b.cloud(20, 52, 30, 1.3); b.cloud(48, 48, -10, 0.9);
  b.butterfly(0, -8, '#eab54e'); b.butterfly(10, 10, '#f2f0e4'); b.butterfly(-20, 20, '#f2b6c9');
  return finish(b, [0, 0, 0]);
}

// ---------- 🌾 Golden Meadow ----------
function buildMeadow(scene) {
  const bounds = 60;
  const b = new Builder(scene, bounds);
  b.sky('#bcd6e8', '#ffdda0');
  b.lights({ sunPos: [34, 18, -12], sunColor: '#ffc98a', sky: '#ffe9c4', ground: '#8f9552', ambI: 1.4 });
  b.ground('#b3b465', '#8a9048');
  b.fence(2.5, '#c9a06a');
  const spots = [[-18, -14], [-10, -20], [6, -18], [16, -10], [20, 4], [14, 16], [2, 20], [-12, 16], [-20, 6], [-6, -8], [8, 6], [-15, -3]];
  spots.forEach(([x, z], i) => b.tree(x, z, 0.9 + (i % 3) * 0.25, '#7c8b44', '#e3d878'));
  b.sprinkle(32, (x, z) => b.tree(x, z, 0.85 + Math.random() * 0.6, '#7c8b44', '#e3d878'), 22);
  // tall golden grass to lie down in
  for (const [gx, gz, gs] of [[-6, 10, 1.4], [10, -6, 1.2], [18, 12, 1], [-16, -18, 1.3], [30, -26, 1.5], [-34, 22, 1.4], [24, 34, 1.2], [-28, -36, 1.3]]) {
    for (let i = 0; i < 10 * gs; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 2 * gs;
      b.tuft(gx + Math.cos(a) * r, gz + Math.sin(a) * r, 1.5, '#a3a353', '#e8d98a');
    }
  }
  // warm rocks
  for (const [x, z, s] of [[4, -10, 1.4], [-10, 4, 1.1], [12, 10, 1.6], [-20, -8, 1.2], [34, 8, 1.7], [-38, -14, 1.4], [8, -38, 1.3], [-12, 40, 1.5]]) {
    const rock = gradMesh(new THREE.DodecahedronGeometry(1.1 * s), '#9a8f7c', '#c4baa4', { camo: '#a89d88' });
    rock.position.set(x, 0.8 * s, z);
    b.place(rock);
    b.colliders.push({ minX: x - s, maxX: x + s, minZ: z - s, maxZ: z + s, top: 1.5 * s });
  }
  // fallen logs
  for (const [x, z, rot] of [[-2, -16, 0.4], [16, -2, 1.2], [-14, 10, 2.2], [28, 20, 0.9], [-30, -26, 1.8], [36, -18, 0.2]]) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.65, 5, 9), toonMat('#8a6642'));
    log.rotation.z = Math.PI / 2;
    log.rotation.y = rot;
    log.position.set(x, 0.6, z);
    b.place(log);
    b.colliders.push({ minX: x - 2, maxX: x + 2, minZ: z - 2, maxZ: z + 2, top: 1.2 });
  }
  // pond with lily pads
  const pond = new THREE.Mesh(new THREE.CircleGeometry(4, 24), toonMat('#8fc2d8'));
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(0, 0.02, -2);
  b.place(pond, { cast: false });
  for (const [px, pz] of [[-1.2, -2.5], [1.5, -1], [0.4, -3.4]]) {
    const pad = new THREE.Mesh(new THREE.CircleGeometry(0.4, 10), toonMat('#7fa05a'));
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(px, 0.04, pz);
    scene.add(pad);
  }
  b.sprinkle(30, (x, z) => b.flower(x, z, FLOWER_COLORS[Math.floor(Math.random() * 4)]));
  b.sprinkle(36, (x, z) => b.tuft(x, z, 1, '#a3a353', '#ddd07e'));
  b.hut(-30, 8, { door: 'S', wall: '#c9b489', roof: '#8a7048' });
  b.hill(bounds + 20, 14, 30, '#a8a460'); b.hill(-bounds - 22, -10, 34, '#9c9a58'); b.hill(-10, bounds + 22, 28, '#b0ae66');
  b.cloud(-35, 42, 15, 1.2); b.cloud(25, 54, -25); b.cloud(50, 46, 20, 0.8); b.cloud(-55, 50, -35, 1.1);
  b.butterfly(-6, 10); b.butterfly(10, -6, '#eab54e'); b.butterfly(0, 14, '#f2f0e4'); b.butterfly(-14, -10, '#c9a3e0'); b.butterfly(26, -22, '#f2b6c9');
  return finish(b, [0, 0, 6]);
}
