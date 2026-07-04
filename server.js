// Hide & Seek 3D — game server
// Serves the game files AND runs the multiplayer rooms over WebSockets.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ---- Game rules (tweak these!) ----
const RULES = {
  HIDE_TIME: 30_000,        // seekers cover their eyes for this long
  SEEK_TIME: 240_000,       // how long seekers get to find everyone
  SHOTS_PER_HIDER: 2,       // each seeker gets: hiders * this + EXTRA_SHOTS
  EXTRA_SHOTS: 2,
  MAX_SHOT_RANGE: 80,       // sanity check on hits
};

// ---------- persistent scoreboard + optional accounts ----------
const DATA_FILE = path.join(__dirname, 'data', 'stats.json');
let db = { accounts: {} }; // key -> { name, passHash?, guest, avatar?, stats: {finds, wins, hideSeconds, games} }
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { /* first run */ }
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(db));
    } catch (e) { console.error('could not save stats:', e.message); }
  }, 500);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function recFor(player) {
  const key = player.accountKey || player.guestKey;
  if (!db.accounts[key]) {
    db.accounts[key] = { name: player.name, guest: !player.accountKey, stats: { finds: 0, wins: 0, hideSeconds: 0, games: 0 } };
  }
  db.accounts[key].name = player.name;
  return db.accounts[key];
}

// ---------- static file server ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
};

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // serve three.js straight out of node_modules so the game works offline / on LAN
  let filePath;
  if (urlPath === '/vendor/three.module.js') {
    filePath = path.join(__dirname, 'node_modules/three/build/three.module.js');
  } else if (urlPath.startsWith('/vendor/addons/')) {
    // three.js example modules (GLTFLoader, SkeletonUtils, ...)
    const rest = path.normalize(urlPath.slice('/vendor/addons/'.length)).replace(/^(\.\.[\/\\])+/, '');
    filePath = path.join(__dirname, 'node_modules/three/examples/jsm', rest);
  } else {
    filePath = path.join(__dirname, 'public', path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, ''));
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- multiplayer ----------
const wss = new WebSocketServer({ server, maxPayload: 2 * 1024 * 1024 });

const rooms = new Map(); // code -> room
let nextId = 1;

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id !== exceptId && p.ws.readyState === 1) p.ws.send(msg);
  }
}

function roomInfo(room) {
  return {
    t: 'room',
    code: room.code,
    hostId: room.hostId,
    map: room.map,
    phase: room.phase,
    endsAt: room.endsAt,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, role: p.role, caught: p.caught, ammo: p.ammo, avatar: p.avatar,
    })),
  };
}

function syncRoom(room) { broadcast(room, roomInfo(room)); }

function clearTimers(room) {
  if (room.phaseTimer) clearTimeout(room.phaseTimer);
  if (room.tick) clearInterval(room.tick);
  room.phaseTimer = null;
  room.tick = null;
}

function startGame(room) {
  const hiders = [...room.players.values()].filter(p => p.role === 'hider');
  const seekers = [...room.players.values()].filter(p => p.role === 'seeker');
  if (hiders.length === 0 || seekers.length === 0) {
    send(room.players.get(room.hostId).ws, { t: 'error', msg: 'You need at least 1 seeker and 1 hider to start!' });
    return;
  }
  const ammo = hiders.length * RULES.SHOTS_PER_HIDER + RULES.EXTRA_SHOTS;
  for (const p of room.players.values()) {
    p.caught = false;
    p.ammo = p.role === 'seeker' ? ammo : 0;
    p.pos = [0, 0, 0];
    p.ry = 0;
    p.pose = 'stand';
    p.finds = 0;
    p.caughtAtMs = null;
  }
  room.phase = 'hide';
  room.endsAt = Date.now() + RULES.HIDE_TIME;
  syncRoom(room);
  broadcast(room, { t: 'phase', phase: 'hide', endsAt: room.endsAt });

  clearTimers(room);
  room.phaseTimer = setTimeout(() => beginSeek(room), RULES.HIDE_TIME);
  room.tick = setInterval(() => {
    const states = [...room.players.values()].map(p => [p.id, ...p.pos, p.ry, p.pose]);
    broadcast(room, { t: 'state', players: states });
  }, 50);
}

function beginSeek(room) {
  room.phase = 'seek';
  room.endsAt = Date.now() + RULES.SEEK_TIME;
  room.seekStartMs = Date.now();
  broadcast(room, { t: 'phase', phase: 'seek', endsAt: room.endsAt });
  room.phaseTimer = setTimeout(() => endGame(room, 'hiders'), RULES.SEEK_TIME);
}

function endGame(room, winner) {
  clearTimers(room);
  room.phase = 'over';
  room.winner = winner;
  // record stats and crown the round's best seeker
  let best = null;
  const now = Date.now();
  for (const p of room.players.values()) {
    const rec = recFor(p);
    rec.stats.games++;
    if (p.role === 'seeker') {
      rec.stats.finds += p.finds;
      if (winner === 'seekers') rec.stats.wins++;
      if (!best || p.finds > best.finds) best = { name: p.name, finds: p.finds };
    } else {
      const start = room.seekStartMs || now;
      const hiddenUntil = p.caughtAtMs || now;
      rec.stats.hideSeconds += Math.max(0, (hiddenUntil - start) / 1000);
      if (winner === 'hiders' && !p.caught) rec.stats.wins++;
    }
  }
  saveDB();
  broadcast(room, { t: 'phase', phase: 'over', winner, best });
}

// the round only ends when every hider is found or the clock runs out
// (running out of ammo just means waiting and hoping!)
function checkWin(room) {
  if (room.phase !== 'seek') return;
  const hiders = [...room.players.values()].filter(p => p.role === 'hider');
  const seekers = [...room.players.values()].filter(p => p.role === 'seeker');
  if (hiders.length === 0 || hiders.every(p => p.caught)) { endGame(room, 'seekers'); return; }
  if (seekers.length === 0) endGame(room, 'hiders'); // nobody left to seek
}

function backToLobby(room) {
  clearTimers(room);
  room.phase = 'lobby';
  room.winner = null;
  for (const p of room.players.values()) { p.caught = false; p.ammo = 0; }
  syncRoom(room);
}

wss.on('connection', (ws) => {
  const player = {
    id: nextId++, ws, room: null, name: 'Player',
    role: 'hider', avatar: null, pos: [0, 0, 0], ry: 0, pose: 'stand',
    ammo: 0, caught: false,
    accountKey: null,
    guestKey: 'g:' + crypto.randomBytes(5).toString('hex'), // fresh identity per visit unless they log in
    finds: 0, caughtAtMs: null,
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = player.room;

    switch (msg.t) {
      case 'create': {
        const code = makeCode();
        const newRoom = {
          code, hostId: player.id, map: 'village', phase: 'lobby',
          players: new Map(), phaseTimer: null, tick: null, winner: null, endsAt: 0,
        };
        rooms.set(code, newRoom);
        joinRoom(player, newRoom, msg);
        break;
      }
      case 'join': {
        const target = rooms.get(String(msg.code || '').toUpperCase().trim());
        if (!target) { send(ws, { t: 'error', msg: 'No game found with that code. Check the letters!' }); return; }
        joinRoom(player, target, msg);
        if (target.phase === 'hide' || target.phase === 'seek') {
          // you can slip into a running round — as a hider
          player.role = 'hider';
          player.caught = false;
          player.ammo = 0;
          syncRoom(target);
          send(ws, { t: 'phase', phase: target.phase, endsAt: target.endsAt });
        }
        break;
      }
      case 'auth': {
        const name = String(msg.name || '').trim().slice(0, 16);
        const pass = String(msg.pass || '');
        if (name.length < 2 || pass.length < 3) {
          send(ws, { t: 'auth', ok: false, msg: 'Name needs 2+ letters and password 3+ characters' });
          return;
        }
        const key = 'a:' + name.toLowerCase();
        const acc = db.accounts[key];
        if (acc && acc.passHash && acc.passHash !== sha(pass)) {
          send(ws, { t: 'auth', ok: false, msg: 'Wrong password for that name' });
          return;
        }
        if (!acc) {
          db.accounts[key] = { name, passHash: sha(pass), guest: false, avatar: null, stats: { finds: 0, wins: 0, hideSeconds: 0, games: 0 } };
        }
        player.accountKey = key;
        player.name = name;
        saveDB();
        send(ws, { t: 'auth', ok: true, name, avatar: db.accounts[key].avatar || null, created: !acc });
        if (player.room) syncRoom(player.room);
        break;
      }
      case 'scores': {
        const all = Object.values(db.accounts);
        const top = (field, map) => all
          .filter(a => a.stats[field] > 0)
          .sort((x, y) => y.stats[field] - x.stats[field])
          .slice(0, 8)
          .map(map);
        send(ws, {
          t: 'scores',
          finds: top('finds', a => ({ name: a.name, v: a.stats.finds, wins: a.stats.wins, guest: a.guest })),
          hide: top('hideSeconds', a => ({ name: a.name, v: Math.round(a.stats.hideSeconds), wins: a.stats.wins, guest: a.guest })),
        });
        break;
      }
      case 'list': {
        // joinable games for the lobby browser
        const games = [...rooms.values()]
          .filter(r => r.phase === 'lobby' || r.phase === 'over')
          .slice(0, 20)
          .map(r => {
            const hostPlayer = r.players.get(r.hostId);
            return {
              code: r.code,
              players: r.players.size,
              map: r.map,
              host: (hostPlayer && hostPlayer.name) || 'Someone',
            };
          });
        send(ws, { t: 'games', games });
        break;
      }
      case 'profile': { // name / role / avatar updates from the lobby
        if (!room) return;
        if (typeof msg.name === 'string') player.name = msg.name.slice(0, 16) || 'Player';
        if (msg.role === 'hider' || msg.role === 'seeker') player.role = msg.role;
        if (msg.avatar && typeof msg.avatar === 'object') player.avatar = sanitizeAvatar(msg.avatar);
        if (player.accountKey && db.accounts[player.accountKey]) {
          db.accounts[player.accountKey].avatar = player.avatar; // remember your look
          db.accounts[player.accountKey].name = player.name;
          saveDB();
        }
        syncRoom(room);
        break;
      }
      case 'setMap': {
        if (room && player.id === room.hostId && typeof msg.map === 'string') {
          room.map = msg.map;
          syncRoom(room);
        }
        break;
      }
      case 'start': {
        if (room && player.id === room.hostId && (room.phase === 'lobby' || room.phase === 'over')) startGame(room);
        break;
      }
      case 'again': {
        if (room && player.id === room.hostId && room.phase === 'over') backToLobby(room);
        break;
      }
      case 'pos': {
        if (!room || (room.phase !== 'hide' && room.phase !== 'seek' && room.phase !== 'over')) return;
        if (Array.isArray(msg.p) && msg.p.length === 3 && msg.p.every(Number.isFinite)) player.pos = msg.p;
        if (Number.isFinite(msg.ry)) player.ry = msg.ry;
        if (typeof msg.pose === 'string') player.pose = msg.pose;
        break;
      }
      case 'paint': {
        if (!room || player.role !== 'hider') return;
        const ghillie = Array.isArray(msg.ghillie)
          ? msg.ghillie.filter(c => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c)).slice(0, 4)
          : null;
        let body = null; // brush strokes, as a small transparent PNG
        if (typeof msg.body === 'string' && msg.body.startsWith('data:image/') && msg.body.length < 150000) body = msg.body;
        broadcast(room, { t: 'painted', id: player.id, color: msg.color || null, ghillie: ghillie && ghillie.length ? ghillie : null, body });
        break;
      }
      case 'disguise': {
        if (!room || player.role !== 'hider' || player.caught) return;
        const PROPS = ['bush', 'crate', 'rock', 'barrel'];
        const prop = PROPS.includes(msg.prop) ? msg.prop : null;
        broadcast(room, { t: 'disguised', id: player.id, prop });
        break;
      }
      case 'shoot': {
        if (!room || room.phase !== 'seek' || player.role !== 'seeker' || player.caught) return;
        if (player.ammo <= 0) return;
        player.ammo--;
        let hitId = null;
        if (msg.hit) {
          const target = room.players.get(msg.hit);
          if (target && target.role === 'hider' && !target.caught) {
            const dx = target.pos[0] - player.pos[0];
            const dz = target.pos[2] - player.pos[2];
            if (Math.hypot(dx, dz) <= RULES.MAX_SHOT_RANGE) {
              target.caught = true;
              target.caughtAtMs = Date.now();
              player.finds++;
              hitId = target.id;
            }
          }
        }
        broadcast(room, { t: 'shot', by: player.id, from: msg.from, to: msg.to, hit: hitId, ammo: player.ammo });
        if (hitId) broadcast(room, { t: 'caught', id: hitId, by: player.id, byName: player.name });
        checkWin(room);
        break;
      }
    }
  });

  ws.on('close', () => {
    const room = player.room;
    if (!room) return;
    room.players.delete(player.id);
    if (room.players.size === 0) {
      clearTimers(room);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === player.id) {
      room.hostId = [...room.players.keys()][0]; // pass host to the next player
    }
    broadcast(room, { t: 'left', id: player.id, name: player.name });
    syncRoom(room);
    checkWin(room);
  });

  function joinRoom(p, room, msg) {
    p.room = room;
    p.name = String(msg.name || 'Player').slice(0, 16) || 'Player';
    p.avatar = sanitizeAvatar(msg.avatar || {});
    p.role = msg.role === 'seeker' ? 'seeker' : 'hider';
    room.players.set(p.id, p);
    send(p.ws, { t: 'joined', id: p.id, code: room.code });
    syncRoom(room);
  }
});

function sanitizeAvatar(a) {
  const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const color = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  return {
    h: clamp(a.h, 0.72, 1.35, 1),
    w: clamp(a.w, 0.65, 1.6, 1),
    skin: color(a.skin, '#eab68a'),
    shirt: color(a.shirt, '#e74c3c'),
    model: (typeof a.model === 'string' && /^[a-z0-9_]{1,24}$/.test(a.model)) ? a.model : 'classic_boy',
  };
}

server.listen(PORT, () => {
  console.log('');
  console.log('  🙈 Hide & Seek 3D is running!');
  console.log('');
  console.log(`  On this computer:  http://localhost:${PORT}`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  Friends on your WiFi:  http://${net.address}:${PORT}`);
      }
    }
  }
  console.log('');
});
