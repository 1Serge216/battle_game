const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const SIZE = 20;
const SHOOT_RANGE = 6;
const VIEW_RANGE = 9;

const MODES = {
  '10v20': { defender: 10, attacker: 20 },
  '15v30': { defender: 15, attacker: 30 }
};

const server = http.createServer((req, res) => {
  const file = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  fs.readFile(file, (e, data) => {
    if (e) {
      res.writeHead(404);
      res.end('404');
      return;
    }
    const ext = path.extname(file);
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
    res.end(data);
  });
});

function inside(x, y) {
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE;
}

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
      if (cell.terrain === 'plain' && !cell.bridge) {
        cell.terrain = t;
        c++;
      }
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

function viewLineDirs(dir) {
  return [(dir + 7) % 8, dir, (dir + 1) % 8];
}

function lineCells(room, unit, range, ignoreObstacles) {
  const dirs = viewLineDirs(unit.dir);
  const out = [];
  for (const d of dirs) {
    const v = DIR_VECS[d];
    for (let k = 1; k <= range; k++) {
      const nx = unit.x + v.dx * k;
      const ny = unit.y + v.dy * k;
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
const waiting = { '10v20': [], '15v30': [] };
let nextRoomId = 1;
let nextUnitId = 1;

function sendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function createRoom(mode) {
  const spec = MODES[mode];
  const roles = Math.random() < 0.5 ? ['defender', 'attacker'] : ['attacker', 'defender'];
  return {
    id: 'room' + (nextRoomId++),
    mode,
    spec,
    roles,
    players: {},
    map: generateMap(),
    units: [],
    phase: 'setup',
    turn: 'defender',
    ready: {},
    winner: null,
    lastEvent: null
  };
}

function publicState(room, role) {
  const myUnits = room.units.filter(u => u.owner === role);
  const visible = new Set();
  myUnits.forEach(u => {
    visionCells(room, u).forEach(c => visible.add(c.y + ',' + c.x));
    visible.add(u.y + ',' + u.x);
  });

  const mapOut = [];
  for (let y = 0; y < SIZE; y++) {
    const row = [];
    for (let x = 0; x < SIZE; x++) {
      const key = y + ',' + x;
      const vis = role === 'defender' || visible.has(key);
      row.push(vis
        ? { terrain: room.map[y][x].terrain, bridge: room.map[y][x].bridge }
        : { terrain: 'unknown', bridge: false }
      );
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
    .map(u => ({
      id: u.id,
      owner: u.owner,
      x: u.x,
      y: u.y,
      dir: u.dir,
      hp: u.hp,
      acted: u.acted
    }));

  return {
    roomId: room.id,
    mode: room.mode,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    size: SIZE,
    map: mapOut,
    units,
    role,
    lastEvent: room.lastEvent
  };
}

function broadcast(room) {
  for (const role of ['defender', 'attacker']) {
    const ws = room.players[role];
    if (ws) sendTo(ws, { type: 'state', state: publicState(room, role) });
  }
}

function checkEnd(room) {
  const d = room.units.filter(u => u.owner === 'defender').length;
  const a = room.units.filter(u => u.owner === 'attacker').length;
  if (d === 0) {
    room.phase = 'over';
    room.winner = 'attacker';
  } else if (a === 0) {
    room.phase = 'over';
    room.winner = 'defender';
  }
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

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
        opponent.roomId = room.id;
        opponent.role = r1;
        ws.roomId = room.id;
        ws.role = r2;
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
        for (const r of ['defender', 'attacker']) {
          if (room.players[r] && room.players[r] !== ws) {
            sendTo(room.players[r], { type: 'opponentLeft' });
          }
        }
        rooms.delete(room.id);
      }
      ws.roomId = null;
      ws.role = null;
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) return;
    const role = ws.role;

    if (msg.type === 'setup') {
      if (room.phase !== 'setup') return;
      const isDef = role === 'defender';
      const need = isDef ? room.spec.defender : room.spec.attacker;
      const zone = isDef ? [0, 6] : [13, SIZE - 1];
      const units = msg.units || [];
      const taken = new Set();
      const valid = units.length === need && units.every(u => {
        if (!inside(u.x, u.y)) return false;
        if (u.y < zone[0] || u.y > zone[1]) return false;
        const cell = room.map[u.y][u.x];
        if (cell.terrain === 'river' && !cell.bridge) return false;
        const k = u.y + ',' + u.x;
        if (taken.has(k)) return false;
        taken.add(k);
        return true;
      });
      if (!valid) {
        sendTo(ws, { type: 'error', message: 'Некорректная расстановка' });
        return;
      }

      room.units = room.units.filter(u => u.owner !== role);
      units.forEach(u => {
        room.units.push({
          id: nextUnitId++,
          owner: role,
          x: u.x,
          y: u.y,
          dir: isDef ? 4 : 0,
          hp: 2,
          acted: false
        });
      });
      room.ready[role] = true;
      if (room.ready.defender && room.ready.attacker) {
        room.phase = 'battle';
        room.turn = 'defender';
        room.units.forEach(u => u.acted = false);
      }
      broadcast(room);
      return;
    }

    if (msg.type === 'action') {
      if (room.phase !== 'battle') return;
      if (room.turn !== role) {
        sendTo(ws, { type: 'error', message: 'Не ваш ход' });
        return;
      }
      const u = room.units.find(x => x.id === msg.id && x.owner === role);
      if (!u || u.hp <= 0 || u.acted) {
        sendTo(ws, { type: 'error', message: 'Боец недоступен' });
        return;
      }
      applyAction(room, role, u, msg);
      checkEnd(room);
      broadcast(room);
      return;
    }

    if (msg.type === 'endTurn') {
      if (room.phase !== 'battle') return;
      if (room.turn !== role) return;
      room.turn = role === 'defender' ? 'attacker' : 'defender';
      room.units.forEach(x => x.acted = false);
      room.lastEvent = { kind: 'turnEnded', by: role, at: Date.now() };
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
      for (const r of ['defender', 'attacker']) {
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
    const nx = u.x + a.dx;
    const ny = u.y + a.dy;
    if (!inside(nx, ny)) return;
    const cell = room.map[ny][nx];
    if (cell.terrain === 'river' && !cell.bridge) return;
    if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) return;
    u.x = nx;
    u.y = ny;
    u.acted = true;
  } else if (a.action === 'rotate') {
    if (a.dir < 0 || a.dir > 7) return;
    u.dir = a.dir;
    u.acted = true;
  } else if (a.action === 'shoot') {
    const t = room.units.find(o => o.id === a.targetId && o.owner !== role && o.hp > 0);
    if (!t) return;
    if (!canShoot(room, u, t)) return;
    const p = hitChance(room, u, t);
    const hit = Math.random() < p;
    let killed = false;
    if (hit) {
      t.hp -= 1;
      if (t.hp <= 0) {
        room.units = room.units.filter(o => o.id !== t.id);
        killed = true;
      }
    }
    u.acted = true;
    room.lastEvent = {
      kind: 'shot',
      by: role,
      from: { x: u.x, y: u.y },
      to: { x: t.x, y: t.y },
      hit,
      killed,
      at: Date.now()
    };
  } else if (a.action === 'shootAt') {
    const x = a.x;
    const y = a.y;
    if (!inside(x, y)) return;
    const onHill = room.map[u.y][u.x].terrain === 'hill';
    const range = SHOOT_RANGE + (onHill ? 2 : 0);
    const cells = lineCells(room, u, range, onHill);
    if (!cells.some(c => c.x === x && c.y === y)) return;
    const t = room.units.find(o => o.x === x && o.y === y && o.owner !== role && o.hp > 0);
    let hit = false;
    let killed = false;
    if (t) {
      let p = hitChance(room, u, t);
      if (!canShoot(room, u, t)) p *= 0.75;
      hit = Math.random() < p;
      if (hit) {
        t.hp -= 1;
        if (t.hp <= 0) {
          room.units = room.units.filter(o => o.id !== t.id);
          killed = true;
        }
      }
    }
    u.acted = true;
    room.lastEvent = {
      kind: 'shot',
      by: role,
      from: { x: u.x, y: u.y },
      to: { x, y },
      hit,
      killed,
      blind: true,
      at: Date.now()
    };
  }
}

function canShoot(room, s, t) {
  const onHill = room.map[s.y][s.x].terrain === 'hill';
  const maxR = SHOOT_RANGE + (onHill ? 2 : 0);
  const cells = lineCells(room, s, maxR, onHill);
  if (!cells.some(c => c.x === t.x && c.y === t.y)) return false;
  if (onHill) return true;
  for (const d of viewLineDirs(s.dir)) {
    const v = DIR_VECS[d];
    for (let k = 1; k <= maxR; k++) {
      const nx = s.x + v.dx * k;
      const ny = s.y + v.dy * k;
      if (!inside(nx, ny)) break;
      if (nx === t.x && ny === t.y) return true;
      const c = room.map[ny][nx];
      if (c.terrain === 'river' && !c.bridge) break;
      if (c.terrain === 'forest' || c.terrain === 'hill') break;
      if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0 && o.owner === s.owner)) break;
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

server.listen(PORT, () => console.log('http://localhost:' + PORT));
