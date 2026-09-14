const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const SIZE = 20;
const SHOOT_RANGE = 6;
const VIEW_RANGE = 9;
const DRAW_LIMIT = 50;

const MODES = {
  '10v20': { defender: 10, attacker: 20 },
  '15v15': { player1: 15, player2: 15 }
};

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404); res.end('404'); return; }
    const ext = path.extname(file);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(data);
  });
});

function inside(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }

function generateMap() {
  const m = Array.from({ length: SIZE }, () =>
    Array.from({ length: SIZE }, () => ({ terrain: 'plain', bridge: false }))
  );
  let rx = 10;
  for (let y = 0; y < SIZE; y++) {
    rx += Math.floor(Math.random() * 3) - 1;
    rx = Math.max(7, Math.min(12, rx));
    m[y][rx].terrain = 'river';
    if (Math.random() < 0.35) {
      const rx2 = Math.max(0, Math.min(SIZE - 1, rx + (Math.random() < 0.5 ? 1 : -1)));
      m[y][rx2].terrain = 'river';
    }
  }
  const bridges = [];
  while (bridges.length < 3) {
    const y = 3 + Math.floor(Math.random() * (SIZE - 6));
    if (!bridges.some(b => Math.abs(b - y) < 3)) bridges.push(y);
  }
  bridges.forEach(y => {
    for (let x = 0; x < SIZE; x++) if (m[y][x].terrain === 'river') m[y][x].bridge = true;
  });
  const place = (t, n) => {
    let c = 0;
    while (c < n) {
      const y = 2 + Math.floor(Math.random() * (SIZE - 4));
      const x = Math.floor(Math.random() * SIZE);
      const cell = m[y][x];
      if (cell.terrain === 'plain' && !cell.bridge) { cell.terrain = t; c++; }
    }
  };
  place('hill', 18);
  place('forest', 45);
  return m;
}

const DIR_VECS = [
  { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
  { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 }
];

function parallelStarts(u, dir) {
  const v = DIR_VECS[dir];
  const perp = { dx: -v.dy, dy: v.dx };
  return [
    { x: u.x + v.dx, y: u.y + v.dy },
    { x: u.x + v.dx + perp.dx, y: u.y + v.dy + perp.dy },
    { x: u.x + v.dx - perp.dx, y: u.y + v.dy - perp.dy }
  ];
}

function lineCells(room, unit, range, ignoreObstacles) {
  const v = DIR_VECS[unit.dir];
  const starts = parallelStarts(unit, unit.dir);
  const out = [];
  for (const s of starts) {
    for (let k = 0; k < range; k++) {
      const nx = s.x + v.dx * k;
      const ny = s.y + v.dy * k;
      if (!inside(nx, ny)) break;
      out.push({ x: nx, y: ny });
      if (!ignoreObstacles) {
        const t = room.map[ny][nx].terrain;
        if (t === 'forest' || t === 'hill') break;
      }
    }
  }
  return out;
}

function visionCells(room, unit) {
  const onHill = room.map[unit.y][unit.x].terrain === 'hill';
  const range = VIEW_RANGE + (onHill ? 3 : 0);
  return lineCells(room, unit, range, onHill);
}

const rooms = new Map();
const waiting = { '10v20': [], '15v15': [] };
let nextRoomId = 1;
let nextUnitId = 1;

function sendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function autoPlaceUnits(room, role) {
  const is10v20 = room.mode === '10v20';
  let need, startY, dirY, dir;
  if (is10v20) {
    if (role === 'defender') { need = room.spec.defender; startY = 3; dirY = 1; dir = 4; }
    else { need = room.spec.attacker; startY = 16; dirY = -1; dir = 0; }
  } else {
    need = 15;
    if (role === 'player1') { startY = 3; dirY = 1; dir = 4; }
    else { startY = 16; dirY = -1; dir = 0; }
  }
  const maxSteps = 4;
  let placed = 0;
  const taken = new Set();
  room.units.forEach(u => taken.add(u.y + ',' + u.x));

  outer:
  for (let step = 0; step < maxSteps; step++) {
    const y = startY + dirY * step;
    if (y < 0 || y >= SIZE) continue;
    for (let x = 0; x < SIZE; x++) {
      if (placed >= need) break outer;
      const cell = room.map[y][x];
      if (cell.terrain === 'river' && !cell.bridge) continue;
      const k = y + ',' + x;
      if (taken.has(k)) continue;
      taken.add(k);
      room.units.push({
        id: nextUnitId++,
        owner: role,
        x: x, y: y,
        dir: dir,
        hp: 2, acted: false
      });
      placed++;
    }
  }
}

function createRoom(mode) {
  const spec = MODES[mode];
  let roles, firstTurn;
  if (mode === '10v20') {
    roles = Math.random() < 0.5 ? ['defender', 'attacker'] : ['attacker', 'defender'];
    firstTurn = 'defender';
  } else {
    roles = Math.random() < 0.5 ? ['player1', 'player2'] : ['player2', 'player1'];
    firstTurn = Math.random() < 0.5 ? 'player1' : 'player2';
  }
  const room = {
    id: 'room' + (nextRoomId++),
    mode, spec, roles,
    players: {},
    map: generateMap(),
.m    units: [],
    phase: 'battleoves',
    turn: firstTurn,
    winner: null,
Count    draw: false,
    movesCount: {},
   ,
 lastEvent: null,
    drawProposed: null
  };
  if (mode === '10v20') {
    autoPlaceUnits(room, 'defender');
    autoPlaceUnits(room, 'attacker');
  } else {
    autoPlaceUnits(room, 'player1');
    autoPlaceUnits(room, 'player2');
  }
  return room;
}

function publicState(room, role) {
  const is15v15 = room.mode === '15v15';
  const myUnits = room.units.filter(u => u.owner === role);
  const visible = new Set();
  myUnits.forEach(u => {
    visionCells(room, u).forEach(c => visible.add(c.y + ',' + c.x));
    visible.add(u.y + ',' + u.x);
  });

  const seesAll = !is15v15 && role === 'defender';

  const mapOut = [];
  for (let y = 0; y < SIZE; y++) {
    const row = [];
    for (let x = 0; x < SIZE; x++) {
      const key = y + ',' + x;
      const vis = seesAll || visible.has(key);
      row.push(vis
        ? { terrain: room.map[y][x].terrain, bridge: room.map[y][x].bridge }
        : { terrain: 'unknown', bridge: false });
    }
    mapOut.push(row);
  }

  const units = room.units
    .filter(u => {
      if (u.owner === role) return true;
      const cell = room.map[u.y][u.x];
      if (cell.terrain === 'forest') return false;
      return visible.has(u.y + ',' + u.x);
    })
    .map(u => ({ id: u.id, owner: u.owner, x: u.x, y: u.y, dir: u.dir, hp: u.hp, acted: u.acted }));

  return {
    roomId: room.id,
    mode: room.mode,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    draw: room.draw,
    size: SIZE,
    map: mapOut,
    units,
    role,
    lastEvent: room.lastEvent,
    drawProposed: room.drawProposed,
    movesCount    drawLimit: DRAW_LIMIT
  };
}

function broadcast(room) {
  for (const role of Object.keys(room.players)) {
    const ws = room.players[role];
    if (ws) sendTo(ws, { type: 'state', state: publicState(room, role) });
  }
}

function checkEnd(room) {
  if (room.mode === '15v15') {
    const p1 = room.units.filter(u => u.owner === 'player1').length;
    const p2 = room.units.filter(u => u.owner === 'player2').length;
    if (p1 === 0 && p2 === 0) { room.phase = 'over'; room.draw = true; }
    else if (p1 === 0) { room.phase = 'over'; room.winner = 'player2'; }
    else if (p2 === 0) { room.phase = 'over'; room.winner = 'player1'; }
  } else {
    const d = room.units.filter(u => u.owner === 'defender').length;
    const a = room.units.filter(u => u.owner === 'attacker').length;
    if (d === 0) { room.phase = 'over'; room.winner = 'attacker'; }
    else if (a === 0) { room.phase = 'over'; room.winner = 'defender'; }
  }
}

function getOpponent(room, role) {
  if (room.mode === '15v15') return role === 'player1' ? 'player2' : 'player1';
  return role === 'defender' ? 'attacker' : 'defender';
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'joinQueue') {
      const mode = msg.mode;
      if (!MODES[mode]) return;
      if (ws.roomId) return;
      const q = waiting[mode];
      if (q.length > 0) {
        const opponent = q.shift();
        const room = createRoom(mode);
        const [r1, r2] = room.roles;
        room.players[r1] = opponent;
        room.players[r2] = ws;
        opponent.roomId = room.id; opponent.role = r1;
        ws.roomId = room.id; ws.role = r2;
        rooms.set(room.id, room);
        sendTo(opponent, { type: 'matched', role: r1, roomId: room.id, mode });
        sendTo(ws, { type: 'matched', role: r2, roomId: room.id, mode });
        broadcast(room);
      } else {
        q.push(ws);
        sendTo(ws, { type: 'waiting' });
      }
      return;
    }

    if (msg.type === 'cancelQueue') {
      for (const mode of Object.keys(waiting)) {
        const i = waiting[mode].indexOf(ws);
        if (i >= 0) waiting[mode].splice(i, 1);
      }
      sendTo(ws, { type: 'queueCancelled' });
      return;
    }

    if (msg.type === 'leave') {
      const room = rooms.get(ws.roomId);
      if (room) {
        for (const r of Object.keys(room.players)) {
          if (room.players[r] && room.players[r] !== ws) {
            sendTo(room.players[r], { type: 'opponentLeft' });
          }
        }
        rooms.delete(room.id);
      }
      ws.roomId = null; ws.role = null;
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) return;
    const role = ws.role;

    if (msg.type === 'action') {
      if (room.phase !== 'battle') return;
      if (room.turn !== role) { sendTo(ws, { type: 'error', message: 'Не ваш ход' }); return; }
      const u = room.units.find(x => x.id === msg.id && x.owner === role);
      if (!u || u.hp <= 0 || u.acted) { sendTo(ws, { type: 'error', message: 'Боец недоступен' }); return; }
      applyAction(room, role, u, msg);
      checkEnd(room);
      broadcast(room);
      return;
    }

    if (msg.type === 'endTurn') {
      if (room.phase !== 'battle') return;
      if (room.turn !== role) return;
      room.movesCount[role] = (room.movesCount[role] || 0) + 1;
      const totalMoves = Object.values(room.movesCount).reduce((a, b) => a + b, 0);
      if (room.mode === '15v15' && totalMoves >= DRAW_LIMIT * 2) {
        room.phase = 'over';
        room.draw = true;
      } else {
        room.turn = getOpponent(room, role);
        room.units.forEach(x => x.acted = false);
        room.lastEvent = { kind: 'turnEnded', by: role, at: Date.now() };
      }
      broadcast(room);
      return;
    }

    if (msg.type === 'proposeDraw') {
      if (room.phase !== 'battle') return;
      if (room.mode !== '15v15') return;
      if (room.drawProposed) return;
      room.drawProposed = { by: role, at: Date.now() };
      broadcast(room);
      return;
    }

    if (msg.type === 'acceptDraw') {
      if (room.phase !== 'battle') return;
      if (room.mode !== '15v15') return;
      if (!room.drawProposed) return;
      if (room.drawProposed.by === role) return;
      room.phase = 'over';
      room.draw = true;
      broadcast(room);
      return;
    }
  });

  ws.on('close', () => {
    for (const mode of Object.keys(waiting)) {
      const i = waiting[mode].indexOf(ws);
      if (i >= 0) waiting[mode].splice(i, 1);
    }
    const room = rooms.get(ws.roomId);
    if (room) {
      for (const r of Object.keys(room.players)) {
        if (room.players[r] && room.players[r] !== ws) {
          sendTo(room.players[r], { type: 'opponentLeft' });
        }
      }
      rooms.delete(room.id);
    }
  });
});

function applyAction(room, role, u, a) {
  if (a.action === 'move') {
    if (Math.abs(a.dx) + Math.abs(a.dy) !== 1) return;
    const nx = u.x + a.dx, ny = u.y + a.dy;
    if (!inside(nx, ny)) return;
    const cell = room.map[ny][nx];
    if (cell.terrain === 'river' && !cell.bridge) return;
    if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) return;
    u.x = nx; u.y = ny; u.acted = true;
  } else if (a.action === 'rotate') {
    if (a.dir < 0 || a.dir > 7) return;
    if (u.dir === a.dir) return;
    u.dir = a.dir; u.acted = true;
  } else if (a.action === 'shoot') {
    const t = room.units.find(o => o.id === a.targetId && o.owner !== role && o.hp > 0);
    if (!t) return;
    if (!canShoot(room, u, t)) return;
    const p = hitChance(room, u, t);
    const hit = Math.random() < p;
    let killed = false;
    if (hit) {
      t.hp -= 1;
      if (t.hp <= 0) { room.units = room.units.filter(o => o.id !== t.id); killed = true; }
    }
    u.acted = true;
    room.lastEvent = {
      kind: 'shot', by: role,
      from: { x: u.x, y: u.y }, to: { x: t.x, y: t.y },
      hit, killed, at: Date.now()
    };
  } else if (a.action === 'shootAt') {
    const x = a.x, y = a.y;
    if (!inside(x, y)) return;
    const onHill = room.map[u.y][u.x].terrain === 'hill';
    const range = SHOOT_RANGE + (onHill ? 2 : 0);
    const cells = lineCells(room, u, range, onHill);
    if (!cells.some(c => c.x === x && c.y === y)) return;
    const t = room.units.find(o => o.x === x && o.y === y && o.owner !== role && o.hp > 0);
    let hit = false, killed = false;
    if (t) {
      let p = hitChance(room, u, t);
      if (!canShoot(room, u, t)) p *= 0.75;
      hit = Math.random() < p;
      if (hit) {
        t.hp -= 1;
        if (t.hp <= 0) { room.units = room.units.filter(o => o.id !== t.id); killed = true; }
      }
    }
    u.acted = true;
    room.lastEvent = {
      kind: 'shot', by: role,
      from: { x: u.x, y: u.y }, to: { x, y },
      hit, killed, blind: true, at: Date.now()
    };
  }
}

function canShoot(room, s, t) {
  const onHill = room.map[s.y][s.x].terrain === 'hill';
  const maxR = SHOOT_RANGE + (onHill ? 2 : 0);
  const v = DIR_VECS[s.dir];
  const starts = parallelStarts(s, s.dir);
  for (const st of starts) {
    for (let k = 0; k < maxR; k++) {
      const nx = st.x + v.dx * k, ny = st.y + v.dy * k;
      if (!inside(nx, ny)) break;
      if (nx === t.x && ny === t.y) return true;
      if (!onHill) {
        const c = room.map[ny][nx];
        if (c.terrain === 'river' && !c.bridge) break;
        if (c.terrain === 'forest' || c.terrain === 'hill') break;
        if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0 && o.owner === s.owner)) break;
      }
    }
  }
  return false;
}

function hitChance(room, s, t) {
  const dist = Math.max(Math.abs(s.x - t.x), Math.abs(s.y - t.y));
  const onHill = room.map[s.y][s.x].terrain === 'hill';
  const maxR = SHOOT_RANGE + (onHill ? 2 : 0);
  let p = 0.95 - (dist / maxR) * 0.7;
  if (onHill) p += 0.15;
  if (room.map[t.y][t.x].terrain === 'forest') p -= 0.25;
  return Math.max(0.05, Math.min(0.95, p));
}

server.listen(PORT, '0.0.0.0', () => console.log('Сервер запущен'));
