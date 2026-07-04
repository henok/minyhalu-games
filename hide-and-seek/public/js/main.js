// Hide & Seek 3D — client
import * as THREE from 'three';
import { buildAvatar, makeNameTag, toonMat } from './avatar.js';
import { MODELS, PROPS, makeProp } from './models.js';
import { MAPS, buildMap } from './maps.js';
import { Net } from './net.js';

const $ = (id) => document.getElementById(id);

// ---------- tuning ----------
const HIDER_SPEED = 7.6;   // hiders are faster!
const SEEKER_SPEED = 5.4;
const POSE_SPEED = { stand: 1, crouch: 0.5, flat: 0.28, ball: 0.65 };
const GRAVITY = -28;
const JUMP_VEL = 9;
const PLAYER_RADIUS = 0.38;

const SKIN_TONES = ['#f9d5b3', '#eab68a', '#d29b6c', '#a86a3c', '#7a4a24', '#4d2c15'];
const SHIRTS = ['#d96f4e', '#eab54e', '#8aa864', '#6f93b3', '#9c6b8f', '#5ba393', '#e58a91', '#7d7568'];
const PAINTS = ['#98bf62', '#6f8f4f', '#4a6b3a', '#7fa05a', '#c99a63', '#8a6642', '#d8c49a', '#efe3c2', '#d07a5e', '#a89d88', '#8fc2d8'];

// ---------- state ----------
const net = new Net();
let myId = null;
let isHost = false;
let phase = 'lobby';
let endsAt = 0;
let roomPlayers = [];            // latest lobby data from server
const remotes = new Map();       // id -> {avatar, tag, target:{pos,ry}, data}
let world = null;
let me = {
  name: '', role: 'hider', caught: false, eliminated: false, ammo: 0,
  paint: null, ghillie: null, bodyPaint: null, disguise: null, pose: 'stand',
  pos: new THREE.Vector3(), vel: new THREE.Vector3(), onGround: true,
  walkT: 0, walkK: 0,
  cfg: { h: 1, w: 1, model: 'classic_boy', skin: SKIN_TONES[1], shirt: SHIRTS[0] },
};
let myProp = null; // my disguise mesh, when I'm pretending to be furniture
let pendingRound = null; // joined a running game: {phase, endsAt, ammo} until "Jump in!"
let ammoMeshes = []; // pickup boxes currently on the map
let camoOpen = false; // palette deliberately open: mouse freed, no click-to-play overlay
let myAvatar = null;
let heading = 0;               // which way the player faces (arrow keys turn this)
let camYaw = 0, pitch = -0.2;  // mouse orbits the camera only
let avatarYaw = 0;             // smoothed visual facing
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camInit = false;
const keys = {};

// debug handle (also used by automated tests)
const HS = {
  me, keys, debugFree: false, tick: null,
  setYaw: (v) => { heading = v; camYaw = v; avatarYaw = v; }, getYaw: () => heading, setPitch: (v) => { pitch = v; },
  state: () => ({ phase, hasWorld: !!world, hasAvatar: !!myAvatar, role: me.role, pose: me.pose, caught: me.caught }),
  pv: () => pvAvatar,
};
window.hs = HS;

// ---------- three.js setup ----------
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;   // warm, filmic summer light
renderer.toneMappingExposure = 1.35;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
let scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 300);
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------- little sound effects ----------
let audio;
function beep(freq, dur = 0.12, type = 'square', vol = 0.15, slide = 0) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type; o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, audio.currentTime + dur);
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + dur);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + dur);
  } catch { /* no sound, no problem */ }
}
const sfx = {
  shot: () => beep(180, 0.15, 'sawtooth', 0.2, -80),
  hit: () => { beep(600, 0.1); setTimeout(() => beep(400, 0.15), 90); },
  caught: () => { beep(300, 0.2, 'sine', 0.2, -150); },
  phase: () => { beep(523, 0.12, 'sine'); setTimeout(() => beep(784, 0.2, 'sine'), 130); },
  win: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => beep(f, 0.18, 'sine'), i * 140)),
  paint: () => beep(880, 0.08, 'sine', 0.1),
  pickup: () => { beep(660, 0.08, 'sine', 0.12); setTimeout(() => beep(880, 0.1, 'sine', 0.12), 70); },
};

// ---------- relaxing background music (synthesized — no files needed) ----------
let musicOn = localStorage.getItem('hsmusic') !== 'off';
let musicPlaying = false, musicTimer = null, musicMaster = null;
function startMusic() {
  if (musicPlaying || !musicOn) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch { return; }
  musicPlaying = true;
  musicMaster = audio.createGain();
  musicMaster.gain.value = 0.05;
  const lp = audio.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1500;
  musicMaster.connect(lp);
  lp.connect(audio.destination);
  // dreamy four-chord loop with sparse plucked notes on top
  const chords = [
    [130.8, 196.0, 246.9, 329.6],  // Cmaj7
    [110.0, 164.8, 220.0, 261.6],  // Am7
    [87.3, 174.6, 220.0, 261.6],   // Fmaj7
    [98.0, 146.8, 196.0, 293.7],   // G
  ];
  const scale = [261.6, 293.7, 329.6, 392.0, 440.0, 523.3, 587.3];
  let bar = 0;
  const playBar = () => {
    if (!musicPlaying) return;
    const t0 = audio.currentTime + 0.05;
    for (const f of chords[bar++ % 4]) {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'triangle';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 1.4);
      g.gain.linearRampToValueAtTime(0.0001, t0 + 4.1);
      o.connect(g).connect(musicMaster);
      o.start(t0);
      o.stop(t0 + 4.2);
    }
    for (let i = 0; i < 3; i++) {
      const tN = t0 + 0.4 + Math.random() * 3;
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = scale[Math.floor(Math.random() * scale.length)];
      g.gain.setValueAtTime(0.0001, tN);
      g.gain.exponentialRampToValueAtTime(0.07, tN + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, tN + 1.6);
      o.connect(g).connect(musicMaster);
      o.start(tN);
      o.stop(tN + 1.7);
    }
  };
  playBar();
  musicTimer = setInterval(playBar, 4000);
  updateMusicPill();
}
function stopMusic() {
  musicPlaying = false;
  clearInterval(musicTimer);
  if (musicMaster) { try { musicMaster.disconnect(); } catch { /* already gone */ } musicMaster = null; }
  updateMusicPill();
}
function toggleMusic() {
  musicOn = !musicOn;
  localStorage.setItem('hsmusic', musicOn ? 'on' : 'off');
  if (musicOn) startMusic(); else stopMusic();
}
function updateMusicPill() { $('musicPill').textContent = musicPlaying ? '🎵' : '🔇'; }
$('musicPill').onclick = toggleMusic;

// ---------- lobby UI ----------
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.style.display = 'block';
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.style.display = 'none'), 3500);
}

function makeSwatches(containerId, colors, initial, onPick) {
  const box = $(containerId);
  colors.forEach((c) => {
    const s = document.createElement('button');
    s.className = 'swatch' + (c === initial ? ' active' : '');
    s.style.background = c;
    s.onclick = () => {
      box.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      onPick(c);
    };
    box.appendChild(s);
  });
}

makeSwatches('skinSwatches', SKIN_TONES, me.cfg.skin, (c) => { me.cfg.skin = c; refreshPreview(); sendProfile(); });
makeSwatches('shirtSwatches', SHIRTS, me.cfg.shirt, (c) => { me.cfg.shirt = c; refreshPreview(); sendProfile(); });

$('heightSlider').oninput = (e) => { me.cfg.h = +e.target.value; refreshPreview(); sendProfile(); };
$('buildSlider').oninput = (e) => { me.cfg.w = +e.target.value; refreshPreview(); sendProfile(); };

// character model dropdown
{
  const sel = $('modelSelect');
  for (const [id, m] of Object.entries(MODELS)) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = m.name;
    sel.appendChild(o);
  }
  sel.value = me.cfg.model;
  sel.onchange = () => {
    me.cfg.model = sel.value;
    $('classicOnly').style.display = MODELS[me.cfg.model]?.url ? 'none' : '';
    refreshPreview();
    sendProfile();
  };
}

$('roomNameInput').oninput = (e) => {
  me.name = e.target.value.trim().slice(0, 16) || 'Player';
  localStorage.setItem('hsname', me.name);
  clearTimeout($('roomNameInput')._h);
  $('roomNameInput')._h = setTimeout(sendProfile, 400);
};

function setRole(role) {
  me.role = role;
  $('roleHider').classList.toggle('active', role === 'hider');
  $('roleSeeker').classList.toggle('active', role === 'seeker');
  sendProfile();
}
$('roleHider').onclick = () => setRole('hider');
$('roleSeeker').onclick = () => setRole('seeker');

// map picker
let currentMap = 'village';
for (const [id, m] of Object.entries(MAPS)) {
  const b = document.createElement('button');
  b.className = 'mapBtn' + (id === currentMap ? ' active' : '');
  b.dataset.map = id;
  b.innerHTML = `<b>${m.name}</b><span>${m.desc}</span>`;
  b.onclick = () => { if (isHost) net.send({ t: 'setMap', map: id }); };
  $('mapPick').appendChild(b);
}
function showMap(id) {
  currentMap = id;
  document.querySelectorAll('.mapBtn').forEach(b => b.classList.toggle('active', b.dataset.map === id));
}

function sendProfile() {
  if (myId) net.send({ t: 'profile', name: me.name, role: me.role, avatar: me.cfg });
}

// avatar preview (spinning character in the lobby)
const pvCanvas = $('avatarPreview');
const pvRenderer = new THREE.WebGLRenderer({ canvas: pvCanvas, antialias: true, alpha: true });
const pvScene = new THREE.Scene();
const pvCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
pvCamera.position.set(0, 1.4, 3.4);
pvCamera.lookAt(0, 0.95, 0);
pvRenderer.toneMapping = THREE.ACESFilmicToneMapping;
pvScene.add(new THREE.HemisphereLight(0xfff3d8, 0x93a862, 1.5));
const pvSun = new THREE.DirectionalLight(0xffdfae, 1.6);
pvSun.position.set(2, 4, 3);
pvScene.add(pvSun);
let pvAvatar = null;
function refreshPreview() {
  if (pvAvatar) pvScene.remove(pvAvatar.group);
  pvAvatar = buildAvatar(me.cfg);
  pvScene.add(pvAvatar.group);
}
refreshPreview();
(function spinPreview() {
  requestAnimationFrame(spinPreview);
  if ($('roomCard').hidden) return;
  const w = pvCanvas.clientWidth, h = pvCanvas.clientHeight;
  if (pvCanvas.width !== w || pvCanvas.height !== h) {
    pvRenderer.setSize(w, h, false);
    pvCamera.aspect = w / h;
    pvCamera.updateProjectionMatrix();
  }
  if (pvAvatar) {
    pvAvatar.group.rotation.y += 0.02;
    pvAvatar.setWalk(performance.now() * 0.004, 0.3); // little strut to show off
    pvAvatar.update(1 / 60);
  }
  pvRenderer.render(pvScene, pvCamera);
})();

// join / create
async function enterRoom(action) {
  me.name = $('nameInput').value.trim() || 'Player';
  localStorage.setItem('hsname', me.name);
  try {
    if (!net.ws || net.ws.readyState !== 1) await net.connect();
  } catch {
    toast('Could not reach the game server 😢');
    return;
  }
  net.send({ t: action, code: $('codeInput').value, name: me.name, role: me.role, avatar: me.cfg });
}
$('nameInput').value = localStorage.getItem('hsname') || '';
$('createBtn').onclick = () => enterRoom('create');
$('joinBtn').onclick = () => enterRoom('join');
$('codeInput').onkeydown = (e) => { if (e.key === 'Enter') enterRoom('join'); };

$('startBtn').onclick = () => net.send({ t: 'start' });
$('againBtn').onclick = () => net.send({ t: 'again' });

function renderLobby() {
  $('codeBadge').textContent = roomPlayers.length ? $('codeBadge').textContent : '----';
  const list = $('playerList');
  list.innerHTML = '';
  const inLobby = phase === 'lobby';
  for (const p of roomPlayers) {
    const li = document.createElement('li');
    const roleTag = `<span class="tag ${p.role}">${p.role === 'hider' ? '🙈 hider' : '🔍 seeker'}</span>`;
    const hostTag = p.id === hostId ? '<span class="tag host">👑 host</span>' : '';
    let readyTag = '';
    if (inLobby && p.id !== hostId) readyTag = p.ready ? '✅' : '⏳';
    if (p.playing === false) readyTag = '🛋️ setting up';
    li.innerHTML = `<span>${p.id === myId ? '⭐' : '🧑'}</span> <span class="grow">${escapeHtml(p.name)}</span> ${readyTag} ${roleTag} ${hostTag}`;
    list.appendChild(li);
  }
  document.querySelectorAll('.hostOnly').forEach(el => (el.hidden = !isHost));

  // host: Start unlocks only with both roles filled and everyone ready
  const hiders = roomPlayers.filter(p => p.role === 'hider').length;
  const seekers = roomPlayers.filter(p => p.role === 'seeker').length;
  const othersReady = roomPlayers.filter(p => p.id !== hostId).every(p => p.ready);
  if (isHost) {
    $('startBtn').disabled = !(hiders >= 1 && seekers >= 1 && othersReady);
    $('startHint').textContent = (!hiders || !seekers)
      ? 'You need at least 1 hider and 1 seeker to start.'
      : (othersReady ? '' : 'Waiting for everyone to press Ready…');
  }

  // guests: ready button (or Jump-in when the round is already running)
  const mine = roomPlayers.find(p => p.id === myId);
  const showReady = !isHost && inLobby && !pendingRound;
  $('readyBtn').hidden = !showReady;
  if (showReady && mine) {
    $('readyBtn').textContent = mine.ready ? '🎉 Ready! (tap to change)' : "✅ I'm ready!";
  }
  $('jumpBtn').hidden = !pendingRound;
  $('waitHint').hidden = isHost || !inLobby || !!pendingRound;
  $('endWait').hidden = isHost;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- network handlers ----------
let hostId = null;

net.on('joined', (m) => {
  myId = m.id;
  $('codeBadge').textContent = m.code;
  $('roomNameInput').value = me.name;
  $('joinCard').hidden = true;
  $('roomCard').hidden = false;
});

// ---------- live games browser ----------
async function ensureConnected() {
  if (net.ws && net.ws.readyState === 1) return true;
  if (net.ws && net.ws.readyState === 0) return false; // still connecting
  try { await net.connect(); return true; } catch { return false; }
}
net.on('games', (m) => {
  const box = $('gamesList');
  box.innerHTML = '';
  if (!m.games.length) {
    box.innerHTML = '<p class="hint">No games right now — start one and invite your friends!</p>';
    return;
  }
  for (const g of m.games) {
    const row = document.createElement('div');
    row.className = 'gameRow';
    const info = document.createElement('span');
    info.className = 'grow';
    info.textContent = `${(MAPS[g.map]?.name || g.map)} · ${g.host}'s game · ${g.players} playing`;
    const btn = document.createElement('button');
    btn.className = 'joinMini';
    btn.textContent = 'Join ' + g.code;
    btn.onclick = () => { $('codeInput').value = g.code; enterRoom('join'); };
    row.append(info, btn);
    box.appendChild(row);
  }
});
async function refreshGames() {
  if ($('joinCard').hidden || $('lobby').hidden) return;
  if (await ensureConnected()) {
    net.send({ t: 'list' });
    net.send({ t: 'scores' });
  }
}
setInterval(refreshGames, 3000);
refreshGames();

// ---------- optional login: keeps your scoreboard record + avatar ----------
$('loginBtn').onclick = async () => {
  if (!(await ensureConnected())) { toast('Could not reach the server'); return; }
  net.send({ t: 'auth', name: $('nameInput').value, pass: $('passInput').value });
};
net.on('auth', (m) => {
  if (!m.ok) { toast(m.msg); return; }
  me.name = m.name;
  $('nameInput').value = m.name;
  localStorage.setItem('hsname', m.name);
  if (m.avatar) {
    Object.assign(me.cfg, m.avatar);
    $('modelSelect').value = MODELS[me.cfg.model] ? me.cfg.model : 'classic_boy';
    $('classicOnly').style.display = MODELS[me.cfg.model]?.url ? 'none' : '';
    $('heightSlider').value = me.cfg.h;
    $('buildSlider').value = me.cfg.w;
    refreshPreview();
  }
  toast(m.created ? '✅ Account created — your avatar & scores are saved!' : '👋 Welcome back, ' + m.name + '!');
});

// ---------- scoreboard ----------
net.on('scores', (m) => {
  const render = (el, list, fmt) => {
    if (!list.length) { el.innerHTML = '<p class="hint">No scores yet — go play!</p>'; return; }
    el.innerHTML = '';
    list.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'scoreRow';
      const name = document.createElement('span');
      name.textContent = `${i + 1}. ${e.name}${e.guest ? ' 👤' : ''}`;
      const val = document.createElement('b');
      val.textContent = fmt(e);
      row.append(name, val);
      el.appendChild(row);
    });
  };
  render($('scoreFinds'), m.finds, e => `${e.v} 🎯`);
  render($('scoreHide'), m.hide, e => `${Math.floor(e.v / 60)}m ${e.v % 60}s`);
});
if (innerWidth > 900) $('scoreDetails').open = true; // desktop: scoreboard always visible

// ---------- lobby chat ----------
function sendChat() {
  const text = $('chatInput').value.trim();
  if (!text) return;
  net.send({ t: 'chat', text });
  $('chatInput').value = '';
}
$('chatSend').onclick = sendChat;
$('chatInput').onkeydown = (e) => {
  e.stopPropagation(); // typing shouldn't trigger game keys
  if (e.key === 'Enter') sendChat();
};
net.on('chat', (m) => {
  const log = $('chatLog');
  const row = document.createElement('div');
  const who = document.createElement('b');
  who.textContent = m.name + ': ';
  row.append(who, document.createTextNode(m.text));
  log.appendChild(row);
  while (log.children.length > 60) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
});

$('readyBtn').onclick = () => {
  const mine = roomPlayers.find(p => p.id === myId);
  net.send({ t: 'ready', ready: !(mine && mine.ready) });
};
$('hideTimeSel').onchange = (e) => { if (isHost) net.send({ t: 'setHideTime', secs: +e.target.value }); };

$('jumpBtn').onclick = () => {
  if (!pendingRound) return;
  const p = pendingRound;
  pendingRound = null;
  net.send({ t: 'spawn' });
  startRound(p.endsAt, p.ammo || []);
  if (p.phase === 'seek') {
    phase = 'seek';
    $('blind').hidden = true;
    $('phasePill').textContent = "Don't get found! 🤫";
  }
};

net.on('room', (m) => {
  hostId = m.hostId;
  isHost = myId === m.hostId;
  roomPlayers = m.players;
  showMap(m.map);
  if (m.hideTime) $('hideTimeSel').value = String(Math.round(m.hideTime / 1000));
  const mine = m.players.find(p => p.id === myId);
  if (mine) {
    me.ammo = mine.ammo;
    me.caught = mine.caught;
    if (mine.role !== me.role) { // server can reassign (e.g. joining mid-round makes you a hider)
      me.role = mine.role;
      $('roleHider').classList.toggle('active', me.role === 'hider');
      $('roleSeeker').classList.toggle('active', me.role === 'seeker');
    }
  }
  renderLobby();
  syncRemotePlayers();
  if ((m.phase === 'lobby') && phase !== 'lobby' && phase !== 'joining') backToLobbyUI();
});

net.on('error', (m) => toast(m.msg));

net.on('phase', (m) => {
  if (m.late) {
    // we joined a game that's already running — finish setup first, then jump in
    pendingRound = { phase: m.phase, endsAt: m.endsAt, ammo: m.ammo || [] };
    renderLobby();
    toast('Game in progress — set up your character, then jump in!');
    return;
  }
  if (pendingRound && (m.phase === 'hide' || m.phase === 'seek')) {
    // still in the setup screen — just remember where the round is up to
    pendingRound.phase = m.phase;
    pendingRound.endsAt = m.endsAt;
    return;
  }
  if (m.phase === 'hide') startRound(m.endsAt, m.ammo || []);
  else if (m.phase === 'seek') {
    if (!world || !myAvatar) startRound(m.endsAt, m.ammo || []);
    phase = 'seek'; endsAt = m.endsAt;
    $('blind').hidden = true;
    $('phasePill').textContent = me.role === 'seeker' ? 'Go find them! 🔍' : "Don't get found! 🤫";
    showBanner(me.role === 'seeker' ? 'READY OR NOT, HERE I COME!' : 'The seekers are coming!!');
    sfx.phase();
    if (me.role === 'seeker') {
      $('crosshair').hidden = false;
      $('ammoPill').hidden = false;
      askPointerLock();   // eyes open — let the seeker grab the mouse and go!
    }
  } else if (m.phase === 'over') {
    if (pendingRound) { pendingRound = null; renderLobby(); return; } // never jumped in
    phase = 'over'; endsAt = 0;
    document.exitPointerLock?.();
    revealEveryone(); // names + beacons over every hiding spot
    const iWon = (m.winner === 'seekers') === (me.role === 'seeker');
    $('endTitle').textContent = m.winner === 'seekers' ? '🔍 SEEKERS WIN! 🏆' : '🙈 HIDERS WIN! 🏆';
    const bestLine = m.best ? ` — 🏆 Best seeker: ${m.best.name} (${m.best.finds} ${m.best.finds === 1 ? 'find' : 'finds'})` : '';
    $('endSub').textContent = (iWon ? 'You won!! 🎉🎉🎉' : 'You lost this time… get \'em next round!') + bestLine;
    $('end').hidden = false;
    $('clickToPlay').hidden = true;
    sfx.win();
  }
});

// game over: everyone steps out of hiding — tags and beacons on every spot
function revealEveryone() {
  if (!world) return;
  const beam = (pos, color) => {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.16, 30, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, toneMapped: false, depthWrite: false })
    );
    m.position.set(pos.x, 15, pos.z);
    scene.add(m);
  };
  for (const r of remotes.values()) {
    if (r.prop) { scene.remove(r.prop); r.prop = null; } // unmask disguises
    r.avatar.group.visible = true;
    if (!r.tag) {
      r.tag = makeNameTag(r.data.name, r.data.role === 'seeker' ? '#ffd9c4' : '#c9f2b3');
      r.tag.position.y = r.avatar.standHeight + 0.35;
      r.avatar.group.add(r.tag);
    }
    r.tag.material.depthTest = false; // show through walls — it's reveal time
    beam(r.avatar.group.position, r.data.role === 'seeker' ? '#e0805a' : '#8aa864');
  }
  if (myAvatar) beam(me.pos, me.role === 'seeker' ? '#e0805a' : '#8aa864');
}

net.on('state', (m) => {
  for (const [id, x, y, z, ry, pose] of m.players) {
    if (id === myId) continue;
    const r = remotes.get(id);
    if (r) {
      r.target.pos.set(x, y, z);
      r.target.ry = ry;
      if (r.pose !== pose) { r.pose = pose; r.avatar.setPose(pose); }
    }
  }
});

net.on('painted', (m) => {
  if (m.id === myId) return;
  const r = remotes.get(m.id);
  if (!r) return;
  r.avatar.setPaint(m.color);
  r.avatar.setGhillie(m.ghillie || null);
  r.avatar.setBodyPaint(m.body || null);
});

net.on('disguised', (m) => {
  if (m.id === myId) return;
  const r = remotes.get(m.id);
  if (!r) return;
  if (r.prop) { scene.remove(r.prop); r.prop = null; }
  if (m.prop) {
    r.prop = makeProp(m.prop);
    r.prop.position.copy(r.avatar.group.position);
    scene.add(r.prop);
  }
  r.avatar.group.visible = !m.prop;
});

net.on('shot', (m) => {
  sfx.shot();
  if (m.by === myId) {
    me.ammo = m.ammo;
    $('ammoPill').textContent = `🔫 ${me.ammo}`;
    if (m.hit) sfx.hit();
    else feed('Missed! 💨');
  }
  if (m.from && m.to) drawTracer(m.from, m.to);
});

net.on('caught', (m) => {
  const who = roomPlayers.find(p => p.id === m.id);
  feed(`🎯 ${m.byName} found ${who ? who.name : 'someone'}!`);
  if (m.id === myId) {
    me.caught = true;
    if (me.disguise) setDisguise(null); // disguise drops when you're found
    myAvatar?.setGhost(true);
    showBanner('You got found! 👻 You can still watch.');
    sfx.caught();
  } else {
    const r = remotes.get(m.id);
    if (r) {
      if (r.prop) { scene.remove(r.prop); r.prop = null; }
      r.avatar.group.visible = true;
      r.avatar.setGhost(true);
    }
  }
  updateLeftPill();
});

net.on('left', (m) => {
  feed(`👋 ${m.name} left the game`);
  const r = remotes.get(m.id);
  if (r) { scene.remove(r.avatar.group); remotes.delete(m.id); }
});

net.on('_closed', () => {
  if (phase !== 'lobby') toast('Lost connection to the game 😢 — refresh to rejoin');
});

// ---------- entering / leaving a round ----------
function startRound(ends, ammoList = []) {
  phase = 'hide';
  endsAt = ends;
  me.caught = false;
  me.eliminated = false;
  me.paint = null;
  me.ghillie = null;
  me.bodyPaint = null;
  me.disguise = null;
  myProp = null; // the old scene (and any prop in it) is thrown away below
  me.pose = 'stand';
  remoteCaught.clear(); // fresh round, nobody is caught yet
  scene = new THREE.Scene();
  world = buildMap(currentMap, scene);
  spawnAmmoBoxes(ammoList);

  // my avatar + spawn
  myAvatar = buildAvatar(me.cfg);
  scene.add(myAvatar.group);
  const iAmSeeker = me.role === 'seeker';
  const hiders = roomPlayers.filter(p => p.role === 'hider');
  const myHiderIdx = Math.max(0, hiders.findIndex(p => p.id === myId));
  const spawn = iAmSeeker ? world.seekerSpawn : world.hiderSpawns[myHiderIdx % world.hiderSpawns.length];
  me.pos.set(spawn[0], 0, spawn[2]);
  me.vel.set(0, 0, 0);
  heading = camYaw = avatarYaw = Math.atan2(-me.pos.x, -me.pos.z); // face the middle
  camInit = false;

  // everyone else
  remotes.clear();
  syncRemotePlayers();

  // UI
  $('lobby').hidden = true;
  $('end').hidden = true;
  $('hud').hidden = false;
  $('banner').hidden = true;
  $('crosshair').hidden = true;
  $('ammoPill').hidden = true;
  $('palette').hidden = iAmSeeker;
  $('poseHint').hidden = iAmSeeker;
  $('feed').innerHTML = '';
  $('phasePill').textContent = iAmSeeker ? 'Cover your eyes…' : 'Quick, go HIDE! 🏃';
  $('ammoPill').textContent = `🔫 ${me.ammo}`;
  updateLeftPill();
  buildPalette();

  if (iAmSeeker) {
    $('blind').hidden = false;   // seekers can't watch people hide!
  } else {
    $('blind').hidden = true;
    askPointerLock();
  }
  sfx.phase();
}

function syncRemotePlayers() {
  if (phase === 'lobby' || phase === 'joining') return;
  for (const p of roomPlayers) {
    if (p.playing === false) continue; // still in the setup screen — invisible until they jump in
    if (p.id === myId || remotes.has(p.id)) {
      // keep caught state in sync
      if (p.id !== myId && remotes.has(p.id)) remotes.get(p.id).data = p;
      continue;
    }
    const avatar = buildAvatar(p.avatar || {});
    let tag = null;
    if (p.role === 'seeker') {          // hiders never show a name tag
      tag = makeNameTag(p.name, '#ffd9c4');
      tag.position.y = avatar.standHeight + 0.35;
      avatar.group.add(tag);
    }
    scene.add(avatar.group);
    remotes.set(p.id, {
      avatar, tag, data: p, pose: 'stand', walkT: 0, walkK: 0,
      target: { pos: new THREE.Vector3(0, 0, 0), ry: 0 },
    });
    if (p.caught) avatar.setGhost(true);
  }
}

function backToLobbyUI() {
  phase = 'lobby';
  document.exitPointerLock?.();
  $('end').hidden = true;
  $('hud').hidden = true;
  $('blind').hidden = true;
  $('clickToPlay').hidden = true;
  $('lobby').hidden = false;
  remotes.clear();
}

function updateLeftPill() {
  const hiders = roomPlayers.filter(p => p.role === 'hider' && p.playing !== false);
  const free = hiders.filter(p => !(p.id === myId ? me.caught : (remotes.get(p.id)?.data.caught || remoteCaught.has(p.id)))).length;
  $('leftPill').textContent = `🙈 ${free} hiding`;
}
const remoteCaught = new Set(); // updated via caught events

// ---------- ammo pickups ----------
function spawnAmmoBoxes(list) {
  ammoMeshes = [];
  for (const [id, x, z] of list) {
    const g = new THREE.Group();
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.42, 0.5), toonMat('#c99a63'));
    g.add(box);
    const band = new THREE.Mesh(new THREE.BoxGeometry(0.54, 0.1, 0.54), toonMat('#5a4632'));
    g.add(band);
    const glow = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.26, 8),
      new THREE.MeshBasicMaterial({ color: '#ffe1a1', toneMapped: false })
    );
    glow.position.y = 0.36;
    g.add(glow);
    g.traverse(o => { if (o.isMesh) o.castShadow = true; });
    g.position.set(x, 0.5, z);
    scene.add(g);
    ammoMeshes.push({ id, g, x, z, requested: false });
  }
}

net.on('ammoTaken', (m) => {
  const i = ammoMeshes.findIndex(b => b.id === m.id);
  if (i >= 0) { scene.remove(ammoMeshes[i].g); ammoMeshes.splice(i, 1); }
  if (m.by === myId) {
    me.ammo = m.ammo;
    $('ammoPill').textContent = `🔫 ${me.ammo}`;
    sfx.pickup();
    feed('🔫 +3 shots!');
  } else {
    feed(`${m.byName} grabbed an ammo box!`);
  }
});

net.on('eliminated', (m) => {
  if (m.id === myId) {
    me.eliminated = true;
    myAvatar?.setGhost(true);
    showBanner('Out of shots — eliminated! 👻 You can still watch.');
    sfx.caught();
  } else {
    remotes.get(m.id)?.avatar.setGhost(true);
    feed(`💨 ${m.name} ran out of shots!`);
  }
});

// ---------- paint tools ----------
function buildPalette() {
  const pal = $('palette');
  pal.innerHTML = '';
  const relock = () => { camoOpen = false; $('palette').hidden = false; canvas.requestPointerLock(); };
  const add = (el) => pal.appendChild(el);
  const mini = (text, fn) => {
    const b = document.createElement('button');
    b.className = 'miniBtn';
    b.textContent = text;
    b.onclick = () => { fn(); relock(); };
    add(b);
    return b;
  };
  const label = document.createElement('span');
  label.style.cssText = 'color:white;font-weight:bold;font-size:0.85rem';
  label.textContent = '🎨';
  add(label);
  PAINTS.forEach(c => {
    const s = document.createElement('button');
    s.className = 'swatch';
    s.style.background = c;
    s.onclick = () => { applyPaint(c); relock(); };
    add(s);
  });
  mini('✨ Match (C)', camoMatch);
  mini('🍃 Leaves', applyGhillie);
  const brush = document.createElement('button');
  brush.className = 'miniBtn';
  brush.textContent = '🖌️ Brush';
  brush.onclick = openPaintStudio; // keeps the mouse free — opens the studio
  add(brush);
  for (const p of PROPS) mini(p.label, () => setDisguise(p.id));
  mini('🧍 Me again', () => { setDisguise(null); applyPaint(null); });
}

function sendCamo() {
  net.send({ t: 'paint', color: me.paint, ghillie: me.ghillie, body: me.bodyPaint });
}

function applyPaint(color) {
  if (me.role !== 'hider') return;
  me.paint = color;
  if (!color) { // wash-off clears everything
    me.ghillie = null;
    me.bodyPaint = null;
    myAvatar?.setGhillie(null);
    myAvatar?.setBodyPaint(null);
  }
  myAvatar?.setPaint(color);
  sendCamo();
  sfx.paint();
}

function applyGhillie() {
  if (me.role !== 'hider') return;
  // leaves colored like whatever you're looking at, plus natural greens
  const base = sampleLookColor() || '#6f8f4f';
  me.ghillie = [base, '#4a6b3a', '#87a552'];
  myAvatar?.setGhillie(me.ghillie);
  sendCamo();
  sfx.paint();
  feed('🍃 Covered in leaves!');
}

function sampleLookColor() {
  if (!world) return null;
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const hits = raycaster.intersectObjects(world.solids, false);
  if (!hits.length) return null;
  const obj = hits[0].object;
  if (obj.userData.camoColor) return obj.userData.camoColor; // gradient-shaded things store their color here
  const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
  return '#' + mat.color.getHexString();
}

function camoMatch() {
  const hex = sampleLookColor();
  if (hex) {
    applyPaint(hex);
    feed('✨ Camouflaged!');
  }
}

// --- brush painting studio: draw stripes and shapes that wrap onto your body ---
const pCanvas = $('paintCanvas');
const pCtx = pCanvas.getContext('2d');
let brushColor = '#26160c', brushSize = 10, brushing = false, lastPX = 0, lastPY = 0;
{
  const box = $('brushSwatches');
  [...PAINTS, '#26160c', '#f2f0e4', '#c9564a', '#eab54e'].forEach((c, i) => {
    const s = document.createElement('button');
    s.className = 'swatch' + (i === PAINTS.length ? ' active' : '');
    s.style.background = c;
    s.onclick = () => {
      box.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
      s.classList.add('active');
      brushColor = c;
    };
    box.appendChild(s);
  });
  $('brushSize').oninput = (e) => { brushSize = +e.target.value; };
  const toXY = (e) => {
    const r = pCanvas.getBoundingClientRect();
    return [(e.clientX - r.left) * (pCanvas.width / r.width), (e.clientY - r.top) * (pCanvas.height / r.height)];
  };
  pCanvas.onpointerdown = (e) => {
    brushing = true;
    [lastPX, lastPY] = toXY(e);
    try { pCanvas.setPointerCapture(e.pointerId); } catch { /* synthetic events have no real pointer */ }
    pCtx.beginPath();
    pCtx.fillStyle = brushColor;
    pCtx.arc(lastPX, lastPY, brushSize / 2, 0, 7);
    pCtx.fill();
  };
  pCanvas.onpointermove = (e) => {
    if (!brushing) return;
    const [x, y] = toXY(e);
    pCtx.strokeStyle = brushColor;
    pCtx.lineWidth = brushSize;
    pCtx.lineCap = 'round';
    pCtx.beginPath();
    pCtx.moveTo(lastPX, lastPY);
    pCtx.lineTo(x, y);
    pCtx.stroke();
    [lastPX, lastPY] = [x, y];
  };
  pCanvas.onpointerup = () => { brushing = false; };
  $('paintClear').onclick = () => pCtx.clearRect(0, 0, pCanvas.width, pCanvas.height);
  $('paintDone').onclick = () => closePaintStudio(true);
  $('paintCancel').onclick = () => closePaintStudio(false);
}
function openPaintStudio() {
  $('paintModal').hidden = false;
}
function closePaintStudio(apply) {
  $('paintModal').hidden = true;
  if (apply) {
    me.bodyPaint = pCanvas.toDataURL('image/png');
    myAvatar?.setBodyPaint(me.bodyPaint);
    sendCamo();
    sfx.paint();
    feed('🖌️ Body paint on!');
  }
  camoOpen = false;
  canvas.requestPointerLock();
}

// --- prop disguise: pretend to be furniture ---
function setDisguise(prop) {
  if (me.role !== 'hider' || (me.caught && prop)) return;
  me.disguise = prop;
  if (myProp) { scene.remove(myProp); myProp = null; }
  if (prop) {
    myProp = makeProp(prop);
    myProp.position.copy(me.pos);
    scene.add(myProp);
    feed('🎭 You are now a ' + prop + '! (move slowly or you\'ll wobble)');
  }
  if (myAvatar) myAvatar.group.visible = !prop;
  net.send({ t: 'disguise', prop });
  sfx.paint();
}

// ---------- input ----------
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'KeyM' && !e.repeat && e.target.tagName !== 'INPUT') toggleMusic();
  if (phase !== 'hide' && phase !== 'seek') return;
  if (e.code === 'ArrowDown' && !e.repeat) heading += Math.PI; // spin around, run toward the camera
  if (e.code === 'KeyG' && !e.repeat && myAvatar) {
    me.pose = me.pose === 'dance' ? 'stand' : 'dance';         // 🕺 dance break!
    myAvatar.setPose(me.pose);
    sendPos(true);
  }
  if (me.role === 'hider' && !me.caught) {
    const poses = { Digit1: 'stand', Digit2: 'crouch', Digit3: 'flat', Digit4: 'ball' };
    if (poses[e.code]) {
      me.pose = poses[e.code];
      myAvatar.setPose(me.pose);
      sendPos(true);
    }
    if (e.code === 'KeyC') camoMatch();
    if (e.code === 'KeyP') { // P behaves like right-click: open palette / close and re-lock
      if (document.pointerLockElement === canvas) {
        camoOpen = true;
        $('palette').hidden = false;
        document.exitPointerLock();
      } else if (camoOpen) {
        camoOpen = false;
        canvas.requestPointerLock();
      }
    }
  }
});
addEventListener('keyup', (e) => (keys[e.code] = false));

function askPointerLock() {
  $('clickToPlay').hidden = false;
}
$('clickToPlay').onclick = () => { canvas.requestPointerLock(); startMusic(); };
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if (locked) camoOpen = false;
  $('clickToPlay').hidden = locked || camoOpen || phase === 'lobby' || phase === 'over' || ($('blind').hidden === false);
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  camYaw -= e.movementX * 0.0024;
  pitch -= e.movementY * 0.0024;
  pitch = Math.max(-1.1, Math.min(0.65, pitch));
});
addEventListener('mousedown', (e) => {
  // right-click: hiders open the camouflage palette (mouse is freed to click it)
  if (e.button === 2 && (phase === 'hide' || phase === 'seek') && me.role === 'hider' && !me.caught) {
    camoOpen = true;
    $('palette').hidden = false;
    $('clickToPlay').hidden = true;
    document.exitPointerLock?.();
    return;
  }
  // left-click on empty ground while the palette is open = never mind, back to the game
  if (e.button === 0 && camoOpen && document.pointerLockElement !== canvas && e.target === canvas) {
    camoOpen = false;
    canvas.requestPointerLock();
    return;
  }
  if (document.pointerLockElement !== canvas || e.button !== 0) return;
  if (phase === 'seek' && me.role === 'seeker' && me.ammo > 0) shoot();
});
addEventListener('contextmenu', (e) => { if (!$('hud').hidden) e.preventDefault(); });

// ---------- shooting ----------
function shoot() {
  raycaster.setFromCamera({ x: 0, y: 0 }, camera);
  const candidates = [];
  const owners = new Map();
  for (const [id, r] of remotes) {
    if (r.data.role !== 'hider' || r.data.caught || remoteCaught.has(id)) continue;
    const src = r.prop || r.avatar.group; // disguised hiders are shot via their prop
    // skip invisible meshes and decoration (paint shells, ghillie leaves) —
    // only the actual body counts as a hit
    src.traverse(o => { if (o.isMesh && o.visible && !o.userData.noHit) { candidates.push(o); owners.set(o, id); } });
  }
  const wallHits = raycaster.intersectObjects(world.solids, false);
  const playerHits = raycaster.intersectObjects(candidates, false);
  const wallDist = wallHits.length ? wallHits[0].distance : Infinity;
  let hitId = null, hitPoint = null;
  if (playerHits.length && playerHits[0].distance < wallDist) {
    hitId = owners.get(playerHits[0].object);
    hitPoint = playerHits[0].point;
  } else if (wallHits.length) {
    hitPoint = wallHits[0].point;
  } else {
    hitPoint = raycaster.ray.at(60, new THREE.Vector3());
  }
  const from = myAvatar.group.position.clone().add(new THREE.Vector3(0, myAvatar.headY, 0));
  net.send({ t: 'shoot', hit: hitId, from: from.toArray(), to: hitPoint.toArray() });
}

const tracers = [];
function drawTracer(from, to) {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(...from), new THREE.Vector3(...to),
  ]);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe066, linewidth: 3 }));
  scene.add(line);
  tracers.push({ line, until: performance.now() + 130 });
  // little impact flash
  const flash = new THREE.PointLight(0xffe066, 6, 6);
  flash.position.set(...to);
  scene.add(flash);
  setTimeout(() => scene.remove(flash), 120);
}

function feed(text) {
  const d = document.createElement('div');
  d.textContent = text;
  $('feed').prepend(d);
  setTimeout(() => d.remove(), 6000);
}

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.hidden = false;
  clearTimeout(b._h);
  b._h = setTimeout(() => (b.hidden = true), 3200);
}

// ---------- physics + movement ----------
function groundHeightAt(x, z, feetY) {
  let top = 0;
  for (const c of world.colliders) {
    if (x > c.minX - PLAYER_RADIUS && x < c.maxX + PLAYER_RADIUS &&
        z > c.minZ - PLAYER_RADIUS && z < c.maxZ + PLAYER_RADIUS &&
        c.top <= feetY + 0.45 && c.top > top) {
      top = c.top;
    }
  }
  return top;
}

function blockedAt(x, z, feetY) {
  for (const c of world.colliders) {
    if (x > c.minX - PLAYER_RADIUS && x < c.maxX + PLAYER_RADIUS &&
        z > c.minZ - PLAYER_RADIUS && z < c.maxZ + PLAYER_RADIUS &&
        feetY < c.top - 0.45) {
      return true;
    }
  }
  return false;
}

function updateLocal(dt) {
  const noLock = document.pointerLockElement !== canvas && !HS.debugFree;
  const frozen = (phase === 'hide' && me.role === 'seeker') || phase === 'over' || noLock;
  const ox = me.pos.x, oz = me.pos.z;
  const base = me.role === 'hider' ? HIDER_SPEED : SEEKER_SPEED;
  const speed = base * (POSE_SPEED[me.pose] || 1) * (me.caught ? 1.1 : 1) * (me.disguise ? 0.45 : 1);

  // arrow keys pivot the player; the mouse only moves the camera
  if (!frozen) {
    const TURN = 2.8;
    if (keys.ArrowLeft) heading += TURN * dt;
    if (keys.ArrowRight) heading -= TURN * dt;
  }
  let fwd = 0, strafe = 0;
  if (!frozen) {
    if (keys.KeyW || keys.ArrowUp || keys.ArrowDown) fwd += 1; // ArrowDown already spun us around
    if (keys.KeyS) fwd -= 0.55;                                // gentle backpedal
    if (keys.KeyA) strafe -= 1;
    if (keys.KeyD) strafe += 1;
  }
  if ((fwd || strafe) && me.pose === 'dance') { me.pose = 'stand'; myAvatar.setPose('stand'); }
  const len = Math.hypot(fwd, strafe) || 1;
  const sinH = Math.sin(heading), cosH = Math.cos(heading);
  // player-relative: forward is (-sin, -cos), right is (cos, -sin)
  const vx = ((strafe * cosH - fwd * sinH) / len) * speed;
  const vz = ((-fwd * cosH - strafe * sinH) / len) * speed;

  // horizontal, one axis at a time so you slide along walls
  let nx = me.pos.x + vx * dt;
  if (!blockedAt(nx, me.pos.z, me.pos.y)) me.pos.x = nx;
  let nz = me.pos.z + vz * dt;
  if (!blockedAt(me.pos.x, nz, me.pos.y)) me.pos.z = nz;

  // keep inside the fence
  const B = world.bounds - 0.8;
  me.pos.x = Math.max(-B, Math.min(B, me.pos.x));
  me.pos.z = Math.max(-B, Math.min(B, me.pos.z));

  // vertical
  const ground = groundHeightAt(me.pos.x, me.pos.z, me.pos.y);
  me.vel.y += GRAVITY * dt;
  if (!frozen && keys.Space && me.onGround && me.pose === 'stand') { me.vel.y = JUMP_VEL; me.onGround = false; }
  me.pos.y += me.vel.y * dt;
  if (me.pos.y <= ground) { me.pos.y = ground; me.vel.y = 0; me.onGround = true; }
  else me.onGround = false;

  // turn the body smoothly toward its heading (+PI: the face is on the +z side)
  myAvatar.group.position.copy(me.pos);
  let dTurn = heading - avatarYaw;
  while (dTurn > Math.PI) dTurn -= Math.PI * 2;
  while (dTurn < -Math.PI) dTurn += Math.PI * 2;
  avatarYaw += dTurn * Math.min(1, dt * 12);
  myAvatar.group.rotation.y = avatarYaw + Math.PI;

  // drive the walk cycle from how fast we actually moved
  const moved = Math.hypot(me.pos.x - ox, me.pos.z - oz) / dt;
  const targetK = Math.min(1, moved / (base * 0.9));
  me.walkK += (targetK - me.walkK) * Math.min(1, dt * 8);
  me.walkT += dt * (3 + moved * 1.6);
  myAvatar.setWalk(me.walkT, me.walkK);
  myAvatar.update(dt);

  // disguised? the prop is you now — it follows, and wobbles when you move
  if (myProp) {
    myProp.position.copy(me.pos);
    myProp.rotation.z = moved > 0.4 ? Math.sin(performance.now() / 90) * 0.09 : 0;
  }

  // seekers: walk over an ammo box to grab it
  if (me.role === 'seeker' && !me.caught && phase === 'seek') {
    for (const b of ammoMeshes) {
      if (!b.requested && Math.hypot(b.x - me.pos.x, b.z - me.pos.z) < 1.5) {
        b.requested = true;
        net.send({ t: 'ammo', id: b.id });
      }
    }
  }

  // --- third-person camera: springy follow, shoulder offset, wind sway ---
  const t = performance.now() / 1000;
  if ((keys.KeyW || keys.ArrowUp) && !frozen) {
    // running forward: ease the camera back to its spot behind the player
    let dc = heading - camYaw;
    while (dc > Math.PI) dc -= Math.PI * 2;
    while (dc < -Math.PI) dc += Math.PI * 2;
    camYaw += dc * Math.min(1, dt * 2.5);
  }
  const dist = 5.0;
  const cp = Math.cos(pitch);
  const back = new THREE.Vector3(Math.sin(camYaw) * cp, Math.sin(-pitch), Math.cos(camYaw) * cp);
  const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
  // over-the-shoulder framing keeps the crosshair off the back of your head
  const desired = me.pos.clone()
    .addScaledVector(back, dist)
    .addScaledVector(right, 0.6)
    .add(new THREE.Vector3(0, 1.9, 0));
  const lookTarget = me.pos.clone().addScaledVector(right, 0.6).add(new THREE.Vector3(0, 1.45, 0));
  if (!camInit) { camPos.copy(desired); camLook.copy(lookTarget); camInit = true; }
  camPos.lerp(desired, 1 - Math.exp(-dt * 9));
  camLook.lerp(lookTarget, 1 - Math.exp(-dt * 13));
  // a breath of wind, plus a gentle bob while running
  const swayX = Math.sin(t * 0.8) * 0.05 + Math.sin(t * 1.9 + 2) * 0.02;
  const swayY = Math.sin(t * 1.2 + 1) * 0.04 + me.walkK * Math.abs(Math.sin(me.walkT)) * 0.045;
  camera.position.set(camPos.x + swayX, Math.max(0.35, camPos.y + swayY), camPos.z);
  camera.lookAt(camLook.x + swayX * 0.5, camLook.y + swayY * 0.5, camLook.z);
}

let lastSend = 0;
function sendPos(force = false) {
  const now = performance.now();
  if (!force && now - lastSend < 50) return;
  lastSend = now;
  net.send({ t: 'pos', p: [+me.pos.x.toFixed(2), +me.pos.y.toFixed(2), +me.pos.z.toFixed(2)], ry: +(avatarYaw + Math.PI).toFixed(2), pose: me.pose });
}

function updateRemotes(dt) {
  const k = Math.min(1, dt * 12);
  for (const r of remotes.values()) {
    const g = r.avatar.group;
    const px = g.position.x, pz = g.position.z;
    g.position.lerp(r.target.pos, k);
    // shortest-way rotation lerp
    let d = r.target.ry - g.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    g.rotation.y += d * k;
    // animate their arms and legs from how fast they're moving
    const spd = Math.hypot(g.position.x - px, g.position.z - pz) / dt;
    const tk = Math.min(1, spd / 6.5);
    r.walkK += (tk - r.walkK) * Math.min(1, dt * 8);
    r.walkT += dt * (3 + spd * 1.6);
    r.avatar.setWalk(r.walkT, r.walkK);
    r.avatar.update(dt);
    if (r.prop) {
      r.prop.position.copy(g.position);
      r.prop.rotation.z = spd > 0.4 ? Math.sin(performance.now() / 90) * 0.09 : 0;
    }
  }
}

// keep remoteCaught in sync via the caught handler
const oldCaught = net.handlers['caught'];
net.on('caught', (m) => { remoteCaught.add(m.id); oldCaught(m); });

// ---------- proximity expressions: faces get worried when someone's close ----------
setInterval(() => {
  if ((phase !== 'hide' && phase !== 'seek') || !myAvatar) return;
  const exprFor = (d) => (d < 4 ? 'scared' : d < 9 ? 'alert' : 'calm');
  const nearestTo = (pos, excludeId) => {
    let d = Infinity;
    for (const [id, r] of remotes) {
      if (id === excludeId) continue;
      d = Math.min(d, pos.distanceTo(r.avatar.group.position));
    }
    return d;
  };
  myAvatar.setExpression(exprFor(nearestTo(me.pos, null)));
  for (const [id, r] of remotes) {
    const d = Math.min(r.avatar.group.position.distanceTo(me.pos), nearestTo(r.avatar.group.position, id));
    r.avatar.setExpression(exprFor(d));
  }
}, 200);

// ---------- HUD tick ----------
setInterval(() => {
  if (phase !== 'hide' && phase !== 'seek') return;
  const left = Math.max(0, endsAt - Date.now());
  const s = Math.ceil(left / 1000);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (phase === 'hide') {
    $('blindCount').textContent = s;
    if (me.role === 'seeker' && left <= 0) {
      $('blind').hidden = true;
      askPointerLock();
    }
  }
}, 200);

// ---------- main loop ----------
function tick(dt) {
  if ((phase === 'hide' || phase === 'seek' || phase === 'over') && world && myAvatar) {
    updateLocal(dt);
    updateRemotes(dt);
    world.animate(performance.now() / 1000, dt);  // grass sways, clouds drift, butterflies flap
    for (const b of ammoMeshes) { // ammo boxes bob and spin so they catch the eye
      b.g.position.y = 0.5 + Math.sin(performance.now() / 400 + b.id) * 0.12;
      b.g.rotation.y += dt * 1.5;
    }
    sendPos();
    const now = performance.now();
    for (let i = tracers.length - 1; i >= 0; i--) {
      if (now > tracers[i].until) { scene.remove(tracers[i].line); tracers.splice(i, 1); }
    }
    renderer.render(scene, camera);
  }
}
HS.tick = tick;

function animate() {
  requestAnimationFrame(animate);
  tick(Math.min(0.05, clock.getDelta()));
}
animate();
