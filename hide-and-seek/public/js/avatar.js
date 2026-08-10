// Characters: either our procedural "Classic" kids or a rigged GLB model from
// the dropdown (see models.js). Both expose the same API:
//   { group, setPose, setWalk, update(dt), setPaint, setGhillie, setGhost,
//     standHeight, headY }

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { MODELS } from './models.js';

// ---- shared toon shading (3-step cel look) ----
let gradTex = null;
function toonGradient() {
  if (!gradTex) {
    gradTex = new THREE.DataTexture(new Uint8Array([100, 180, 255]), 3, 1, THREE.RedFormat);
    gradTex.minFilter = gradTex.magFilter = THREE.NearestFilter;
    gradTex.needsUpdate = true;
  }
  return gradTex;
}
export const toonMat = (color) => new THREE.MeshToonMaterial({ color, gradientMap: toonGradient() });
export const toonVertexMat = () => new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: toonGradient() });

// classic-kid faces: calm smile, alert "someone's near!", scared "they're HERE!"
function drawFace(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#26160c';
  x.strokeStyle = '#26160c';
  x.lineCap = 'round';
  if (kind === 'alert') {
    x.lineWidth = 5;
    x.beginPath(); x.arc(44, 50, 10, 0, 7); x.stroke();
    x.beginPath(); x.arc(84, 50, 10, 0, 7); x.stroke();
    x.beginPath(); x.arc(44, 50, 4, 0, 7); x.fill();
    x.beginPath(); x.arc(84, 50, 4, 0, 7); x.fill();
    x.beginPath(); x.arc(64, 82, 8, 0, 7); x.stroke(); // little "o" mouth
  } else if (kind === 'scared') {
    x.lineWidth = 5;
    x.beginPath(); x.moveTo(32, 32); x.quadraticCurveTo(44, 22, 56, 30); x.stroke(); // eyebrows up
    x.beginPath(); x.moveTo(72, 30); x.quadraticCurveTo(84, 22, 96, 32); x.stroke();
    x.fillStyle = '#ffffff';
    x.beginPath(); x.arc(44, 52, 12, 0, 7); x.fill();  // wide white eyes
    x.beginPath(); x.arc(84, 52, 12, 0, 7); x.fill();
    x.fillStyle = '#26160c';
    x.beginPath(); x.arc(44, 54, 5, 0, 7); x.fill();
    x.beginPath(); x.arc(84, 54, 5, 0, 7); x.fill();
    x.beginPath(); x.arc(64, 88, 11, 0, 7); x.fill();  // big open mouth
  } else { // calm
    x.beginPath(); x.arc(44, 52, 7, 0, 7); x.fill();
    x.beginPath(); x.arc(84, 52, 7, 0, 7); x.fill();
    x.lineWidth = 5;
    x.beginPath(); x.arc(64, 72, 20, 0.2 * Math.PI, 0.8 * Math.PI); x.stroke();
  }
  return new THREE.CanvasTexture(c);
}
let FACE_TEX = null;
function faceTextures() {
  if (!FACE_TEX) FACE_TEX = { calm: drawFace('calm'), alert: drawFace('alert'), scared: drawFace('scared') };
  return FACE_TEX;
}

function darken(hex, amt = 0.5) {
  const c = new THREE.Color(hex);
  c.multiplyScalar(amt);
  return c;
}

// a transparent cylinder "shell" around the body that brush strokes paint onto —
// we control its texture mapping, so painting works on ANY model, GLB or classic
function makeBodyShell(radius, height) {
  const geo = new THREE.CylinderGeometry(radius, radius * 0.92, height, 24, 1, true);
  const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false });
  const shell = new THREE.Mesh(geo, mat);
  shell.position.y = height / 2 + 0.04;
  shell.visible = false;
  shell.userData.noHit = true; // decoration only — bullets must NOT count it as the player
  return shell;
}
function applyShellPaint(shell, dataUrl) {
  if (!dataUrl) { shell.visible = false; return; }
  const img = new Image();
  img.onload = () => {
    const tex = new THREE.Texture(img);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    shell.material.map = tex;
    shell.material.needsUpdate = true;
    shell.visible = true;
  };
  img.src = dataUrl;
}

// leaf/twig cocoon for the "cover me in leaves" camouflage
function makeGhillie(colors, height) {
  const g = new THREE.Group();
  for (let i = 0; i < 26; i++) {
    const leaf = new THREE.Mesh(
      Math.random() < 0.6 ? new THREE.ConeGeometry(0.09, 0.3, 5) : new THREE.SphereGeometry(0.11, 6, 5),
      toonMat(colors[i % colors.length])
    );
    const a = Math.random() * Math.PI * 2;
    const r = 0.28 + Math.random() * 0.2;
    leaf.position.set(Math.cos(a) * r, 0.15 + Math.random() * height * 0.85, Math.sin(a) * r);
    leaf.rotation.set(Math.random() * 0.9 - 0.45, Math.random() * Math.PI, Math.random() * 0.9 - 0.45);
    leaf.castShadow = true;
    leaf.userData.noHit = true; // shots pass through the foliage
    g.add(leaf);
  }
  return g;
}

export function buildAvatar(cfg = {}) {
  const spec = MODELS[cfg.model] || MODELS.classic_boy;
  if (!spec.url) return buildClassicAvatar(cfg, spec.classic || 'boy');
  return buildGlbAvatar(cfg, spec);
}

// scratch objects for the per-frame procedural layers (look-at, foot IK) —
// shared across avatars; all usage is synchronous within one update call
const _vA = new THREE.Vector3(), _vB = new THREE.Vector3(), _vC = new THREE.Vector3(), _vD = new THREE.Vector3();
const _vT = new THREE.Vector3(); // reserved for IK targets — never touched by ccdTowards
const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion(), _qC = new THREE.Quaternion(), _qD = new THREE.Quaternion();

// rotate `bone` (in place) by the world-space rotation taking direction
// `from` to direction `to` — no assumptions about the bone's local axes
function rotBoneWorld(bone, from, to) {
  _qA.setFromUnitVectors(from.normalize(), to.normalize());
  bone.parent.getWorldQuaternion(_qB);
  _qC.copy(_qB).invert().multiply(_qA).multiply(_qB);
  bone.quaternion.premultiply(_qC);
}

// exact two-bone leg solve: aim hip at target, set the knee angle by the
// law of cosines (bending in the leg's existing bend plane), re-aim hip.
// CCD stalls here because a foot lift keeps the target nearly along the limb.
function solveLeg(hip, knee, ankle, target) {
  hip.updateWorldMatrix(true, false);
  hip.getWorldPosition(_vA);
  ankle.updateWorldMatrix(true, false);
  ankle.getWorldPosition(_vB);
  rotBoneWorld(hip, _vB.sub(_vA), _vC.copy(target).sub(_vA));

  hip.updateWorldMatrix(true, false);
  hip.getWorldPosition(_vA);
  knee.updateWorldMatrix(true, false);
  knee.getWorldPosition(_vB);
  ankle.updateWorldMatrix(true, false);
  ankle.getWorldPosition(_vC);
  const L1 = _vB.distanceTo(_vA), L2 = _vC.distanceTo(_vB);
  if (L1 < 1e-4 || L2 < 1e-4) return;
  const d = Math.min(L1 + L2 - 0.005, Math.max(Math.abs(L1 - L2) + 0.005, target.distanceTo(_vA)));
  const cosNew = (L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2);
  _vC.sub(_vB);               // knee → ankle
  _vD.copy(_vA).sub(_vB);     // knee → hip
  const cosCur = _vC.dot(_vD) / (L1 * L2);
  // +rotation about (KA×KH) closes the knee angle (verified empirically),
  // so a smaller target angle needs delta = current − new
  const delta = Math.acos(Math.min(1, Math.max(-1, cosCur))) - Math.acos(Math.min(1, Math.max(-1, cosNew)));
  _vA.copy(_vC).cross(_vD).normalize();  // bend-plane normal (keeps knee direction)
  if (_vA.lengthSq() < 0.5) return;      // dead-straight leg: skip this frame
  const applyKnee = (ang) => {
    _qA.setFromAxisAngle(_vA, ang);
    knee.parent.getWorldQuaternion(_qB);
    _qC.copy(_qB).invert().multiply(_qA).multiply(_qB);
    knee.quaternion.premultiply(_qC);
  };
  const dCur = Math.sqrt(Math.max(0, L1 * L1 + L2 * L2 - 2 * L1 * L2 * cosCur));
  applyKnee(delta);
  // axis handedness is pose-dependent — if the reach moved away from d, flip
  hip.updateWorldMatrix(true, false);
  hip.getWorldPosition(_vB);
  ankle.updateWorldMatrix(true, false);
  ankle.getWorldPosition(_vC);
  if (Math.abs(_vC.distanceTo(_vB) - d) > Math.abs(dCur - d)) applyKnee(-2 * delta);

  hip.updateWorldMatrix(true, false);
  hip.getWorldPosition(_vA);
  ankle.updateWorldMatrix(true, false);
  ankle.getWorldPosition(_vB);
  rotBoneWorld(hip, _vB.sub(_vA), _vC.copy(target).sub(_vA));
}

// ================= GLB models =================
const loader = new GLTFLoader();
const gltfCache = new Map();
function loadGLTF(url) {
  if (!gltfCache.has(url)) gltfCache.set(url, loader.loadAsync(url));
  return gltfCache.get(url);
}

function buildGlbAvatar(cfg, spec) {
  const h = cfg.h ?? 1;
  const w = cfg.w ?? 1;
  const group = new THREE.Group();
  const poseG = new THREE.Group();
  group.add(poseG);
  const standHeight = (spec.height || 1.7) * h;

  let mixer = null;
  const actions = {};
  let current = null;
  let mats = [], matOriginals = [];
  let pose = 'stand', walkK = 0, ghillieG = null;
  let pendingPaint = undefined, pendingGhost = false;

  // procedural layers (M3): head look-at + ground-adaptive feet
  const hasRealCrouch = !!(spec.clips && spec.clips.crouchwalk);
  let bones = null, modelRef = null, baseModelY = 0;
  let lookHas = false, lookW = 0;
  const lookPos = new THREE.Vector3(), lastLook = new THREE.Vector3();
  let groundSampler = null, rootYOff = 0;

  // life layers (M4): face morphs, blink, breath, finger curl
  const EXPR = {
    calm: {},
    alert: { wide: 0.5, browsUp: 0.6, mouthO: 0.35 },
    scared: { wide: 1, browsUp: 1, mouthO: 1 },
  };
  let morphMeshes = [];
  let expression = 'calm';
  const exprCur = { wide: 0, browsUp: 0, mouthO: 0 };
  let blinkT = 1.5 + Math.random() * 3, blinkPhase = -1;
  let breathT = Math.random() * 10;
  let fingerBones = [], handCur = 0.25, handTarget = null, pointing = false;

  loadGLTF(spec.url).then((gltf) => {
    // measure the ORIGINAL scene: cloned skinned meshes report unreliable
    // bounds (bind-space geometry misses armature scale), the source is right
    if (!spec._box) spec._box = new THREE.Box3().setFromObject(gltf.scene);
    const size = spec._box.getSize(new THREE.Vector3());
    const model = SkeletonUtils.clone(gltf.scene);
    // normalize: scale to target height, feet on the ground, facing +z
    const s = standHeight / (size.y || 1);
    model.scale.set(s * w, s, s * w);
    model.position.y = -spec._box.min.y * s;
    model.rotation.y = spec.rotY || 0;
    poseG.add(model);
    model.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false; // skinned meshes move outside their static bounds
        const arr = Array.isArray(o.material) ? o.material : [o.material];
        arr.forEach((m, i) => {
          const c = m.clone(); // per-player instance so paint doesn't leak
          if (Array.isArray(o.material)) o.material[i] = c; else o.material = c;
          mats.push(c);
        });
      }
    });
    matOriginals = mats.map(m => (m.color ? m.color.clone() : null));
    modelRef = model;
    baseModelY = model.position.y;
    // named bones for the procedural layers; suffix match survives the
    // loader's name sanitizing ("mixamorig:Head" vs "mixamorigHead")
    const findBone = (suffix) => {
      let hit = null;
      model.traverse(o => { if (!hit && o.isBone && o.name.endsWith(suffix)) hit = o; });
      return hit;
    };
    bones = {
      head: findBone('Head'), neck: findBone('Neck'), spine2: findBone('Spine2'),
      upLegL: findBone('LeftUpLeg'), legL: findBone('LeftLeg'), footL: findBone('LeftFoot'),
      upLegR: findBone('RightUpLeg'), legR: findBone('RightLeg'), footR: findBone('RightFoot'),
    };
    // meshes carrying the face morph targets (blink / wide / browsUp / mouthO)
    model.traverse(o => { if (o.isMesh && o.morphTargetDictionary) morphMeshes.push(o); });
    // finger bones with a per-bone local curl axis, computed once from the
    // bind pose (palms face down in the T-pose, so curl = tips toward -Y)
    const FING = /(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/;
    model.updateMatrixWorld(true);
    model.traverse(o => {
      if (!o.isBone) return;
      const m = o.name.match(FING);
      if (!m) return;
      const child = o.children.find(c => c.isBone);
      if (!child) return;
      const dir = child.getWorldPosition(new THREE.Vector3())
        .sub(o.getWorldPosition(new THREE.Vector3())).normalize();
      const axisWorld = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, -1, 0));
      if (axisWorld.lengthSq() < 1e-6) return;
      const wq = o.getWorldQuaternion(new THREE.Quaternion());
      const axisLocal = axisWorld.normalize().applyQuaternion(wq.invert());
      fingerBones.push({
        bone: o, axis: axisLocal, finger: m[2],
        factor: (m[2] === 'Thumb' ? 0.45 : 1) * (m[3] === '1' ? 0.8 : 1),
      });
    });
    mixer = new THREE.AnimationMixer(model);
    const clipFor = (names) => {
      for (const n of names || []) {
        const c = THREE.AnimationClip.findByName(gltf.animations, n);
        if (c) return c;
      }
      return gltf.animations[0] || null;
    };
    for (const key of ['idle', 'walk', 'run', 'dance', 'crouch', 'crouchwalk']) {
      const names = spec.clips && spec.clips[key];
      if (key === 'crouchwalk' && !names) continue; // optional clip — no fallback
      const clip = clipFor(names);
      if (clip) actions[key] = mixer.clipAction(clip);
    }
    play(pose === 'dance' ? 'dance' : pose === 'crouch' ? 'crouch' : 'idle', 0);
    if (pendingPaint !== undefined) setPaint(pendingPaint);
    if (pendingGhost) setGhost(true);
  }).catch((e) => console.warn('model load failed', spec.url, e));

  function play(name, fade = 0.25) {
    const a = actions[name] || actions.idle;
    if (!a || a === current) return;
    a.reset().fadeIn(fade).play();
    if (current) current.fadeOut(fade);
    current = a;
  }

  function setPose(name) {
    if (name === pose) return;
    pose = name;
    poseG.rotation.set(0, 0, 0);
    poseG.position.set(0, 0, 0);
    poseG.scale.set(1, 1, 1);
    if (name === 'flat') {
      // lie flat: tip the whole body onto the ground, nose forward
      poseG.rotation.x = Math.PI / 2;
      poseG.position.y = standHeight * 0.18;
      play('idle');
    } else if (name === 'ball') {
      // scrunch into a little lump — works even without a matching clip
      poseG.scale.set(0.62, 0.45, 0.62);
      play('crouch');
    } else if (name === 'crouch') {
      // models with a real crouch-walk set (Scout) play honest clips;
      // everyone else gets the squash + lean so they still visibly crouch
      if (!hasRealCrouch) {
        poseG.scale.set(1, 0.62, 1);
        poseG.rotation.x = 0.12;
      }
      play('crouch');
    } else if (name === 'dance') {
      play('dance');
    } else {
      play('idle');
    }
  }

  function setWalk(_t, k) { walkK = k; }

  function update(dt) {
    if (!mixer) return;
    if (pose === 'stand') play(walkK > 0.55 ? 'run' : walkK > 0.06 ? 'walk' : 'idle');
    else if (pose === 'crouch' && actions.crouchwalk) play(walkK > 0.06 ? 'crouchwalk' : 'crouch');
    mixer.update(dt);
    applyFingers(dt);
    applyBreath(dt);
    applyFeet();
    applyLookAt(dt);
    applyFace(dt);
  }

  // ---- L4: finger curl — relaxed / loose fist / point, eased ----
  function applyFingers(dt) {
    if (!fingerBones.length) return;
    const auto = pose === 'crouch' ? 0.35 : walkK > 0.55 ? 0.6 : 0.25;
    const goal = handTarget === null ? auto : handTarget;
    handCur += (goal - handCur) * Math.min(1, dt * 6);
    if (handCur < 0.01) return;
    for (const f of fingerBones) {
      const amt = handCur * f.factor * (pointing && f.finger === 'Index' ? 0.05 : 1);
      _qA.setFromAxisAngle(f.axis, amt);
      f.bone.quaternion.multiply(_qA);
    }
  }

  // ---- idle breath: subtle chest sway, damped while moving ----
  function applyBreath(dt) {
    if (!bones || !bones.spine2) return;
    breathT += dt;
    const ang = Math.sin(breathT * 1.6) * 0.012 * (walkK < 0.06 ? 1 : 0.3);
    const yawBody = group.rotation.y + (spec.rotY || 0);
    _vD.set(Math.cos(yawBody), 0, -Math.sin(yawBody));  // body lateral axis
    _qA.setFromAxisAngle(_vD, ang);
    const b = bones.spine2;
    b.updateWorldMatrix(true, false);
    b.parent.getWorldQuaternion(_qB);
    b.getWorldQuaternion(_qC);
    _qC.premultiply(_qA);
    b.quaternion.copy(_qB.invert().multiply(_qC));
  }

  // ---- L5: face — expression morphs eased, autonomous blinking ----
  function applyFace(dt) {
    if (!morphMeshes.length) return;
    const tgt = EXPR[expression] || EXPR.calm;
    const k = Math.min(1, dt * 8);
    for (const key of ['wide', 'browsUp', 'mouthO']) {
      exprCur[key] += ((tgt[key] || 0) - exprCur[key]) * k;
    }
    let blinkW = 0;
    if (blinkPhase >= 0) {
      blinkPhase += dt;
      const t = blinkPhase / 0.22;
      if (t >= 1) { blinkPhase = -1; blinkT = 2 + Math.random() * 4; }
      else blinkW = Math.sin(t * Math.PI);
    } else if ((blinkT -= dt) <= 0) {
      blinkPhase = 0;
    }
    for (const mesh of morphMeshes) {
      const d = mesh.morphTargetDictionary, inf = mesh.morphTargetInfluences;
      if (d.blink !== undefined) inf[d.blink] = blinkW;
      if (d.wide !== undefined) inf[d.wide] = exprCur.wide;
      if (d.browsUp !== undefined) inf[d.browsUp] = exprCur.browsUp;
      if (d.mouthO !== undefined) inf[d.mouthO] = exprCur.mouthO;
    }
  }

  function setExpression(kind) {
    expression = EXPR[kind] ? kind : 'calm';
  }

  function setHandPose(name) {
    pointing = name === 'point';
    handTarget = name === 'point' ? 1.15 : name === 'fist' ? 1.15
      : name === 'relaxed' ? 0.25 : null;
  }

  // ---- L2: ground-adaptive feet — plant on stairs and slopes ----
  function applyFeet() {
    if (!groundSampler || !bones || !bones.footL || !bones.footR || !modelRef) return;
    if (pose === 'flat' || pose === 'ball') return;
    const baseY = group.position.y;
    const feet = [
      [bones.legL, bones.upLegL, bones.footL],
      [bones.legR, bones.upLegR, bones.footR],
    ];
    const dys = feet.map(([, , foot]) => {
      foot.updateWorldMatrix(true, false);
      foot.getWorldPosition(_vA);
      const dy = groundSampler(_vA.x, _vA.z, baseY) - baseY;
      // big drops are ledges (upstairs floor edges) — leave the animation alone
      return (dy < -0.35 || dy > 0.6) ? 0 : dy;
    });
    const drop = Math.min(dys[0], dys[1], 0);
    rootYOff += (drop - rootYOff) * 0.25;            // ease the pelvis down
    modelRef.position.y = baseModelY + rootYOff;
    for (let i = 0; i < 2; i++) {
      const lift = dys[i] - drop;
      if (lift < 0.02) continue;                     // this foot already rests
      const [leg, upLeg, foot] = feet[i];
      foot.updateWorldMatrix(true, false);
      foot.getWorldPosition(_vA);
      solveLeg(upLeg, leg, foot, _vT.set(_vA.x, _vA.y + lift, _vA.z));
    }
  }

  // ---- L3: head look-at — eased, clamped to a natural neck range ----
  function applyLookAt(dt) {
    if (!bones || !bones.head) return;
    lookW += ((lookHas ? 1 : 0) - lookW) * Math.min(1, dt * 5);
    if (lookW < 0.02) return;
    if (lookHas) lastLook.copy(lookPos);
    const yawBody = group.rotation.y + (spec.rotY || 0);
    bones.head.updateWorldMatrix(true, false);
    bones.head.getWorldPosition(_vA);
    _vB.subVectors(lastLook, _vA);
    const dist = Math.hypot(_vB.x, _vB.z);
    if (dist < 0.3) return;
    let dyaw = Math.atan2(_vB.x, _vB.z) - yawBody;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const yaw = yawBody + THREE.MathUtils.clamp(dyaw, -1.1, 1.1);
    const pitch = THREE.MathUtils.clamp(Math.atan2(_vB.y, dist), -0.45, 0.45);
    _vC.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    _vD.set(Math.sin(yawBody), 0, Math.cos(yawBody));
    _qA.setFromUnitVectors(_vD, _vC); // world-space "turn face from forward to target"
    for (const [bone, share] of [[bones.neck, 0.35], [bones.head, 0.65]]) {
      if (!bone) continue;
      _qB.identity().slerp(_qA, lookW * share);
      bone.updateWorldMatrix(true, false);
      bone.parent.getWorldQuaternion(_qC);
      bone.getWorldQuaternion(_qD);
      _qD.premultiply(_qB);
      bone.quaternion.copy(_qC.invert().multiply(_qD));
    }
  }

  function setLookTarget(v) {
    lookHas = !!v;
    if (v) lookPos.copy(v);
  }

  function setGroundSampler(fn) { groundSampler = fn; }

  function setPaint(color) {
    if (!mats.length) { pendingPaint = color; return; }
    mats.forEach((m, i) => {
      if (!m.color) return;
      if (color) m.color.set(color); // tints over the model's texture
      else if (matOriginals[i]) m.color.copy(matOriginals[i]);
    });
  }

  function setGhillie(colors) {
    if (ghillieG) { poseG.remove(ghillieG); ghillieG = null; }
    if (colors && colors.length) {
      ghillieG = makeGhillie(colors, standHeight);
      poseG.add(ghillieG);
    }
  }

  const shell = makeBodyShell(0.42 * Math.max(1, w), standHeight * 0.92);
  poseG.add(shell);
  const setBodyPaint = (dataUrl) => applyShellPaint(shell, dataUrl);

  function setGhost(on) {
    if (!mats.length) { pendingGhost = on; return; }
    group.traverse(o => {
      if (!o.isMesh) return;
      const list = Array.isArray(o.material) ? o.material : [o.material];
      list.forEach(m => { m.transparent = on || m === shell.material; m.opacity = on ? 0.25 : 1; });
    });
  }

  return {
    group, setPose, setWalk, update, setPaint, setGhillie, setBodyPaint, setGhost,
    setExpression, setLookTarget, setGroundSampler, setHandPose,
    standHeight, headY: standHeight * 0.85,
  };
}

// ================= Classic procedural kids =================
function buildClassicAvatar(cfg, gender) {
  const h = cfg.h ?? 1;   // height factor
  const w = cfg.w ?? 1;   // build factor
  const girl = gender === 'girl';
  const skinCol = cfg.skin ?? '#eab68a';
  const shirtCol = cfg.shirt ?? '#e8e2d2';

  const skinMat = toonMat(skinCol);
  const shirtMat = toonMat(shirtCol);
  const shortsMat = new THREE.MeshToonMaterial({ color: darken(shirtCol, 0.55), gradientMap: toonGradient() });
  const sandalMat = toonMat('#a9835c');
  const hairMat = new THREE.MeshToonMaterial({ color: darken(skinCol, 0.3), gradientMap: toonGradient() });
  const strawMat = toonMat('#e8cf8e');

  const group = new THREE.Group();   // world position = feet
  const poseG = new THREE.Group();   // rotated/offset for poses
  group.add(poseG);

  // proportions (~1.75m tall at h=1)
  const legLen = 0.80 * h;
  const thighLen = legLen * 0.52, shinLen = legLen * 0.48;
  const hipX = 0.10 * w;
  const torsoLen = 0.50 * h;
  const torsoR = 0.185 * w;
  const armLen = 0.55 * h;
  const upperArm = armLen * 0.5, foreArm = armLen * 0.5;
  const headR = 0.15 * (0.75 + 0.25 * (h + w) / 2);

  const capsule = (r, len, mat) =>
    new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 4, 10), mat);

  // legs: hip pivot -> thigh -> knee pivot -> shin -> shaped sandal foot
  function makeLeg(side) {
    const hip = new THREE.Group();
    hip.position.set(side * hipX, legLen, 0);
    const thigh = capsule(0.072 * w, thighLen * 1.2, girl ? skinMat : shortsMat);
    thigh.position.y = -thighLen / 2;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -thighLen;
    hip.add(knee);
    const shin = capsule(0.055 * w, shinLen * 1.15, skinMat);
    shin.position.y = -shinLen / 2;
    knee.add(shin);
    const foot = new THREE.Group();
    foot.position.y = -shinLen;
    knee.add(foot);
    const soleGeo = new THREE.CapsuleGeometry(0.05 * w, 0.14 * w, 4, 8);
    soleGeo.rotateX(Math.PI / 2);
    const sole = new THREE.Mesh(soleGeo, sandalMat);
    sole.scale.y = 0.5;
    sole.position.set(0, 0.028, 0.055);
    foot.add(sole);
    const instep = new THREE.Mesh(new THREE.SphereGeometry(0.055 * w, 8, 6), skinMat);
    instep.scale.set(0.9, 0.62, 1.35);
    instep.position.set(0, 0.07, 0.05);
    foot.add(instep);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.115 * w, 0.022, 0.045), sandalMat);
    strap.position.set(0, 0.093, 0.03);
    foot.add(strap);
    return { hip, knee };
  }
  const { hip: hipL, knee: kneeL } = makeLeg(-1);
  const { hip: hipR, knee: kneeR } = makeLeg(1);
  poseG.add(hipL, hipR);

  const upper = new THREE.Group();
  upper.position.y = legLen;
  poseG.add(upper);

  const hips = capsule(torsoR * 0.9, torsoR * 1.6, shortsMat);
  hips.scale.z = 0.7;
  hips.position.y = 0.02;
  upper.add(hips);

  if (girl) {
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(torsoR * 1.0, torsoR * 1.7, 0.22 * h, 12, 1, true),
      shortsMat
    );
    skirt.position.y = -0.07 * h;
    upper.add(skirt);
  }

  const torso = capsule(torsoR, torsoLen * 1.2, shirtMat);
  torso.scale.z = 0.7;
  torso.position.y = torsoLen * 0.52;
  upper.add(torso);

  function makeArm(side) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (torsoR + 0.05 * w), torsoLen * 0.86, 0);
    const sleeve = capsule(0.052 * Math.sqrt(w), upperArm * 1.15, shirtMat);
    sleeve.position.y = -upperArm / 2;
    shoulder.add(sleeve);
    const elbow = new THREE.Group();
    elbow.position.y = -upperArm;
    shoulder.add(elbow);
    const fore = capsule(0.04 * Math.sqrt(w), foreArm * 1.1, skinMat);
    fore.position.y = -foreArm / 2;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.055 * Math.sqrt(w), 8, 6), skinMat);
    hand.position.y = -foreArm;
    elbow.add(hand);
    shoulder.rotation.z = side * 0.08;
    elbow.rotation.x = -0.25;
    return { shoulder, elbow };
  }
  const { shoulder: armL, elbow: elbowL } = makeArm(-1);
  const { shoulder: armR, elbow: elbowR } = makeArm(1);
  upper.add(armL, armR);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(headR * 0.34, headR * 0.4, 0.08 * h), skinMat);
  neck.position.y = torsoLen + 0.02 * h;
  upper.add(neck);

  const headG = new THREE.Group();
  const headLocalY = torsoLen + 0.05 * h + headR;
  headG.position.y = headLocalY;
  upper.add(headG);

  const skull = new THREE.Mesh(new THREE.SphereGeometry(headR, 20, 14), skinMat);
  skull.scale.set(0.92, 1.05, 0.92);
  headG.add(skull);

  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(headR * 1.02, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
    hairMat
  );
  hair.scale.copy(skull.scale).multiplyScalar(1.05);
  hair.rotation.x = -0.55; // tilted well back so it never wraps over the face
  headG.add(hair);

  if (girl) {
    const back = capsule(headR * 0.5, headR * 1.9, hairMat);
    back.position.set(0, -headR * 0.35, -headR * 0.55);
    back.rotation.x = 0.14;
    headG.add(back);
    for (const side of [-1, 1]) {
      const strand = capsule(headR * 0.22, headR * 1.1, hairMat);
      strand.position.set(side * headR * 0.78, -headR * 0.45, -headR * 0.15);
      strand.rotation.z = side * -0.12;
      headG.add(strand);
    }
  }

  const hatG = new THREE.Group();
  hatG.position.y = headR * 0.35;
  hatG.rotation.set(-0.08, 0, 0.05);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(headR * (girl ? 1.8 : 1.65), headR * (girl ? 1.95 : 1.78), headR * 0.1, 18), strawMat);
  hatG.add(brim);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(headR * 0.82, headR * 0.98, headR * 0.75, 14), strawMat);
  crown.position.y = headR * 0.4;
  hatG.add(crown);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(headR * 1.0, headR * 1.0, headR * 0.2, 14), shirtMat);
  band.position.y = headR * 0.14;
  hatG.add(band);
  headG.add(hatG);

  // friendly drawn face, bent to hug the front of the skull —
  // 1.12 margin keeps it clearly outside both the skull AND the hair shell
  const faceGeo = new THREE.CircleGeometry(headR * 0.78, 24);
  {
    const a = 0.92 * headR * 1.12, b = 1.05 * headR * 1.12, cz = 0.92 * headR * 1.12;
    const pos = faceGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i);
      const t = 1 - (x / a) ** 2 - (y / b) ** 2;
      pos.setZ(i, cz * Math.sqrt(Math.max(0.02, t)));
    }
    faceGeo.computeVertexNormals();
  }
  const faceMat = new THREE.MeshBasicMaterial({ map: faceTextures().calm, transparent: true });
  faceMat.userData.alwaysTransparent = true;
  headG.add(new THREE.Mesh(faceGeo, faceMat));

  // the face reacts to how close other players are
  let expression = 'calm';
  function setExpression(kind) {
    if (kind === expression) return;
    expression = kind;
    faceMat.map = faceTextures()[kind] || faceTextures().calm;
    faceMat.needsUpdate = true;
  }

  const standHeight = legLen + headLocalY + headR * 1.4;

  // --- poses ---
  const saved = [poseG, hipL, hipR, kneeL, kneeR, armL, armR, elbowL, elbowR, upper, torso, hips, headG].map(o =>
    [o, o.position.clone(), o.rotation.clone(), o.scale.clone(), o.visible]);
  function resetPose() {
    for (const [o, p, r, s, v] of saved) {
      o.position.copy(p); o.rotation.copy(r); o.scale.copy(s); o.visible = v;
    }
  }

  let currentPose = 'stand';
  let walkable = true;
  let hipBase = 0, kneeBase = 0, elbowBase = -0.25;

  function setPose(name) {
    if (name === currentPose) return;
    currentPose = name;
    resetPose();
    walkable = true;
    hipBase = 0; kneeBase = 0; elbowBase = -0.25;
    if (name === 'crouch') {
      hipBase = -0.85; kneeBase = 1.5;
      hipL.rotation.x = hipBase; hipR.rotation.x = hipBase;
      kneeL.rotation.x = kneeBase; kneeR.rotation.x = kneeBase;
      upper.position.y = legLen * 0.6;
      upper.rotation.x = 0.35;
      headG.rotation.x = -0.3;
    } else if (name === 'flat') {
      poseG.rotation.x = Math.PI / 2;
      poseG.position.y = torsoR * 0.85;
      headG.rotation.x = -0.5;
      walkable = false;
    } else if (name === 'ball') {
      hipL.visible = false; hipR.visible = false;
      armL.visible = false; armR.visible = false;
      upper.position.y = 0.3 * h;
      upper.rotation.x = 0.6;
      torso.scale.set(1.25, 0.72, 1.25);
      torso.position.y = 0;
      hips.position.y = -0.08;
      headG.position.y = torsoLen * 0.5;
      headG.position.z = torsoR * 0.5;
      headG.rotation.x = 0.9;
      walkable = false;
    } else if (name === 'dance') {
      walkable = false;
    }
  }

  function setWalk(t, k) {
    if (currentPose === 'dance') {
      const s = Math.sin(t * 2.4), c = Math.sin(t * 4.8);
      armL.rotation.x = Math.PI - 0.5 + s * 0.55;
      armR.rotation.x = Math.PI - 0.5 - s * 0.55;
      armL.rotation.z = -0.35 + c * 0.2;
      armR.rotation.z = 0.35 - c * 0.2;
      elbowL.rotation.x = -0.5 + c * 0.3;
      elbowR.rotation.x = -0.5 - c * 0.3;
      upper.rotation.z = s * 0.12;
      headG.rotation.z = -s * 0.14;
      hipL.rotation.x = s * 0.2;
      hipR.rotation.x = -s * 0.2;
      kneeL.rotation.x = Math.abs(c) * 0.3;
      kneeR.rotation.x = Math.abs(c) * 0.3;
      poseG.position.y = Math.abs(c) * 0.06;
      return;
    }
    if (!walkable) return;
    const amp = (currentPose === 'crouch' ? 0.3 : 0.7) * k;
    const s = Math.sin(t);
    hipL.rotation.x = hipBase + s * amp;
    hipR.rotation.x = hipBase - s * amp;
    kneeL.rotation.x = kneeBase + Math.max(0, Math.sin(t + 1.0)) * amp * 1.1;
    kneeR.rotation.x = kneeBase + Math.max(0, Math.sin(t + Math.PI + 1.0)) * amp * 1.1;
    armL.rotation.x = -s * amp * 0.7;
    armR.rotation.x = s * amp * 0.7;
    elbowL.rotation.x = elbowBase - Math.max(0, -s) * amp * 0.45;
    elbowR.rotation.x = elbowBase - Math.max(0, s) * amp * 0.45;
    poseG.position.y = Math.abs(Math.cos(t)) * 0.045 * k;
  }

  const paintable = [skinMat, shirtMat, shortsMat, sandalMat, hairMat, strawMat];
  const originals = paintable.map(m => m.color.clone());
  function setPaint(color) {
    if (color) {
      const c = new THREE.Color(color);
      paintable.forEach(m => m.color.copy(c));
    } else {
      paintable.forEach((m, i) => m.color.copy(originals[i]));
    }
  }

  let ghillieG = null;
  function setGhillie(colors) {
    if (ghillieG) { poseG.remove(ghillieG); ghillieG = null; }
    if (colors && colors.length) {
      ghillieG = makeGhillie(colors, standHeight);
      poseG.add(ghillieG);
    }
  }

  const shell = makeBodyShell(torsoR * 2.2, standHeight * 0.92);
  shell.material.userData.alwaysTransparent = true;
  poseG.add(shell);
  const setBodyPaint = (dataUrl) => applyShellPaint(shell, dataUrl);

  function setGhost(on) {
    group.traverse(o => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(m => {
        m.opacity = on ? 0.25 : 1;
        m.transparent = on || m.userData.alwaysTransparent === true;
      });
    });
  }

  group.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  shell.castShadow = false; // painted strokes shouldn't cast a solid cylinder shadow

  return {
    group, setPose, setWalk, update: () => {}, setPaint, setGhillie, setBodyPaint, setGhost, setExpression,
    setLookTarget: () => {}, setGroundSampler: () => {}, setHandPose: () => {},
    standHeight, headY: legLen + headLocalY,
  };
}

// floating name tag — depthTest on, so walls hide it
export function makeNameTag(name, color = '#ffffff') {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  const tw = Math.min(240, ctx.measureText(name).width + 24);
  ctx.beginPath();
  ctx.roundRect(128 - tw / 2, 8, tw, 48, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  sprite.scale.set(1.3, 0.33, 1);
  return sprite;
}
