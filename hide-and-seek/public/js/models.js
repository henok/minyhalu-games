// Character model manifest + disguise props.
// GLB models live in public/models/ — drop a new .glb there and add an entry
// here to put it in the character dropdown. `clips` lists candidate animation
// names per action (first one found in the file wins).

import * as THREE from 'three';
import { toonMat } from './avatar.js';

export const MODELS = {
  classic_boy: { name: '🧒 Classic Boy', classic: 'boy' },
  classic_girl: { name: '👧 Classic Girl', classic: 'girl' },
  robot: {
    name: '🤖 Robot', url: '/models/RobotExpressive.glb', height: 1.7,
    clips: { idle: ['Idle'], walk: ['Walking'], run: ['Running'], dance: ['Dance'], crouch: ['Sitting'] },
  },
  fox: {
    name: '🦊 Fox', url: '/models/Fox.glb', height: 1.0,
    clips: { idle: ['Survey'], walk: ['Walk'], run: ['Run'], dance: ['Run'], crouch: ['Survey'] },
  },
  soldier: {
    name: '🪖 Soldier', url: '/models/Soldier.glb', height: 1.75, rotY: Math.PI,
    clips: { idle: ['Idle'], walk: ['Walk'], run: ['Run'], dance: ['Walk'], crouch: ['Idle'] },
  },
  xbot: {
    name: '🦾 X Bot', url: '/models/Xbot.glb', height: 1.75,
    clips: { idle: ['idle'], walk: ['walk'], run: ['run'], dance: ['agree'], crouch: ['sneak_pose'] },
  },
};

export const PROPS = [
  { id: 'bush', label: '🌿 Bush' },
  { id: 'crate', label: '📦 Crate' },
  { id: 'rock', label: '🪨 Rock' },
  { id: 'barrel', label: '🛢️ Barrel' },
];

// the props hiders can disguise as — kept close to the map dressing colors
export function makeProp(kind) {
  const g = new THREE.Group();
  if (kind === 'crate') {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 1.1), toonMat('#c99a63'));
    m.position.y = 0.55;
    g.add(m);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.16, 0.12, 1.16), toonMat('#a97c47'));
    lid.position.y = 1.12;
    g.add(lid);
  } else if (kind === 'rock') {
    const m = new THREE.Mesh(new THREE.DodecahedronGeometry(0.78), toonMat('#9a8f7c'));
    m.position.y = 0.58;
    m.scale.y = 0.85;
    g.add(m);
  } else if (kind === 'barrel') {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.55, 1.25, 12), toonMat('#8aa864'));
    m.position.y = 0.63;
    g.add(m);
    for (const y of [0.35, 0.95]) {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.07, 12), toonMat('#6d8148'));
      ring.position.y = y;
      g.add(ring);
    }
  } else { // bush
    const blob = new THREE.Mesh(new THREE.SphereGeometry(0.75, 9, 7), toonMat('#6d8c4c'));
    blob.position.y = 0.6;
    blob.scale.set(1.1, 0.85, 1.1);
    g.add(blob);
    const puff = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), toonMat('#7fa05a'));
    puff.position.set(0.45, 0.45, -0.2);
    g.add(puff);
  }
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
