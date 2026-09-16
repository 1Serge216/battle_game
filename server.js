const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const MODES = {
  '10v20': {
    size: 15,
    riverWidth: 1,
    bridges: 4,
    riverDir: 'horizontal',
    defender: { infantry: 10, cannons: 2 },
    attacker: { infantry: 20, cannons: 3 },
    roles: ['defender', 'attacker'],
    firstTurn: 'defender'
  },
  '15v15': {
    size: 15,
    riverWidth: 1,
    bridges: 3,
    riverDir: 'horizontal',
    player1: { infantry: 13, cannons: 3 },
    player2: { infantry: 13, cannons: 3 },
    roles: ['player1', 'player2'],
    drawLimit: 100
  },
  'capture': {
    size: 15,
    riverWidth: 1,
    bridges: 3,
    riverDir: 'horizontal',
    player1: { infantry: 13, cannons: 3 },
    player2: { infantry: 13, cannons: 3 },
    roles: ['player1', 'player2'],
    turnLimit: 30
  }
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
    res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` });
    res.end(data);
  });
});

function inside(size, x, y) {
  return x >= 0 && y >= 0 && x < size && y < size;
}

function generateMap(size, riverWidth, bridgesCount, riverDir) {
  const m = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({ terrain: 'plain', bridge: false }))
  );
  const center = Math.floor(size / 2);
  const startPos = center - Math.floor(riverWidth / 2);

  if (riverDir === 'horizontal') {
    let ry = startPos;
    for (let x = 0; x < size; x++) {
      ry += Math.floor(Math.random() * 3) - 1;
      ry = Math.max(startPos - 1, Math.min(startPos + 1, ry));
      for (let w = 0; w < riverWidth; w++) {
        const y = ry + w;
        if (y >= 0 && y < size) m[y][x].terrain = 'river';
      }
    }
  } else {
    let rx = startPos;
    for (let y = 0; y < size; y++) {
      rx += Math.floor(Math.random() * 3) - 1;
      rx = Math.max(startPos - 1, Math.min(startPos + 1, rx));
      for (let w = 0; w < riverWidth; w++) {
        const x = rx + w;
        if (x >= 0 && x < size) m[y][x].terrain = 'river';
      }
    }
  }

  const used = [];
  let placed = 0,
    attempts = 0;
  while (placed < bridgesCount && attempts < 500) {
    attempts++;
    if (riverDir === 'horizontal') {
      const x = 2 + Math.floor(Math.random() * (size - 5));
      if (used.some(c => Math.abs(c - x) < 3)) continue;
      let by = -1;
      for (let y = 0; y < size; y++)
        if (m[y][x].terrain === 'river') {
          by = y;
          break;
        }
      if (by < 0) continue;
      m[by][x].bridge = true;
      if (x + 1 < size && m[by][x + 1].terrain === 'river') m[by][x + 1].bridge = true;
      used.push(x);
      placed++;
    } else {
      const y = 2 + Math.floor(Math.random() * (size - 5));
      if (used.some(c => Math.abs(c - y) < 3)) continue;
      let bx = -1;
      for (let x = 0; x < size; x++)
        if (m[y][x].terrain === 'river') {
          bx = x;
          break;
        }
      if (bx < 0) continue;
      m[y][bx].bridge = true;
      if (y + 1 < size && m[y + 1][bx].terrain === 'river') m[y + 1][bx].bridge = true;
      used.push(y);
      placed++;
    }
  }

  const hills = 9;
  const forests = 29;
  const place = (t, n) => {
    let c = 0,
      att = 0;
    while (c < n && att < n * 40) {
      att++;
      const y = 1 + Math.floor(Math.random() * (size - 2));
      const x = Math.floor(Math.random() * size);
      const cell = m[y][x];
      if (cell.terrain === 'plain' && !cell.bridge) {
        cell.terrain = t;
        c++;
      }
    }
  };
  place('hill', hills);
  place('forest', forests);
  return m;
}

const DIR_VECS = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 1, dy: 1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: -1, dy: -1 }
];

function parallelStarts(u, dir) {
  const v = DIR_VECS[dir];
  const perp = Math.abs(v.dy) >= Math.abs(v.dx) ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 };
  return [
    { x: u.x + v.dx, y: u.y + v.dy },
    { x: u.x + v.dx + perp.dx, y: u.y + v.dy + perp.dy },
    { x: u.x + v.dx - perp.dx, y: u.y + v.dy - perp.dy }
  ];
}

function lineCells(room, unit, starts, range, ignoreObstacles) {
  const size = room.size;
  const v = DIR_VECS[unit.dir];
  const out = [];
  for (const s of starts) {
    for (let k = 0; k < range; k++) {
      const nx = s.x + v.dx * k,
        ny = s.y + v.dy * k;
      if (!inside(size, nx, ny)) break;
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
  const range = 9 + (onHill ? 3 : 0);
  return lineCells(room, unit, parallelStarts(unit, unit.dir), range, onHill);
}

function infantryShotCells(room, unit) {
  const onHill = room.map[unit.y][unit.x].terrain === 'hill';
  const range = 6 + (onHill ? 2 : 0);
  return lineCells(room, unit, parallelStarts(unit, unit.dir), range, onHill);
}

function cannonShotCells(room, unit) {
  const onHill = room.map[unit.y][unit.x].terrain === 'hill';
  const maxRange = onHill ? 10 : 8;
  const v = DIR_VECS[unit.dir];
  const out = [];
  for (let k = 5; k <= maxRange; k++) {
    const nx = unit.x + v.dx * k,
      ny = unit.y + v.dy * k;
    if (!inside(room.size, nx, ny)) break;
    out.push({ x: nx, y: ny });
  }
  return out;
}

function getShotCells(room, unit) {
  return unit.type === 'cannon' ? cannonShotCells(room, unit) : infantryShotCells(room, unit);
}

// Всегда армии сверху/снизу (независимо от реки)
function autoPlaceUnits(room, role) {
  const isTop = role === 'defender' || role === 'player1';
  const spec =
    room.mode === '10v20'
      ? role === 'defender'
        ? room.spec.defender
        : room.spec.attacker
      : role === 'player1'
        ? room.spec.player1
        : room.spec.player2;
  const need = spec.infantry + spec.cannons;
  if (need === 0) return;
  const size = room.size;
  const center = Math.floor(size / 2);
  const taken = new Set();
  room.units.forEach(u => taken.add(`${u.y},${u.x}`));
  const positions = [];

  const rows = [];
  if (isTop) {
    for (let y = 1; y <= center - 2; y++) rows.push(y);
  } else {
    for (let y = size - 2; y >= center + 2; y--) rows.push(y);
  }

  for (const y of rows) {
    if (positions.length >= need) break;
    const order = [center];
    for (let off = 1; off < size; off++) {
      const d = Math.ceil(off / 2);
      const sign = off % 2 === 1 ? 1 : -1;
      order.push(center + d * sign);
    }
    for (const x of order) {
      if (positions.length >= need) break;
      if (x < 0 || x >= size) continue;
      const k = `${y},${x}`;
      if (taken.has(k)) continue;
      const cell = room.map[y][x];
      if (cell.terrain === 'river' && !cell.bridge) continue;
      taken.add(k);
      positions.push({ x, y });
    }
  }

  const cannonPositions = positions.slice(0, spec.cannons);
  const infantryPositions = positions.slice(spec.cannons, spec.cannons + spec.infantry);
  const dir = isTop ? 4 : 0;
  cannonPositions.forEach(p => {
    room.units.push({
      id: room.nextUnitId++,
      owner: role,
      x: p.x,
      y: p.y,
      dir,
      hp: 2,
      acted: false,
      type: 'cannon',
      reloading: false
    });
  });
  infantryPositions.forEach(p => {
    room.units.push({
      id: room.nextUnitId++,
      owner: role,
      x: p.x,
      y: p.y,
      dir,
      hp: 2,
      acted: false,
      type: 'infantry',
      reloading: false
    });
  });
}

const rooms = new Map();
const passwordIndex = new Map();
const waitingRoomByMode = { '10v20': null, '15v15': null, 'capture': null };
let nextRoomId = 1;

function sendTo(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function clearPasswordIndexFor(roomId) {
  for (const [pass, entry] of passwordIndex) {
    if (entry.roomId === roomId) passwordIndex.delete(pass);
  }
}

function deleteRoom(roomId) {
  rooms.delete(roomId);
  clearPasswordIndexFor(roomId);
  for (const m of Object.keys(waitingRoomByMode)) {
    if (waitingRoomByMode[m] === roomId) waitingRoomByMode[m] = null;
  }
}

function createRoom(mode) {
  const spec = MODES[mode];
  const roles = Math.random() < 0.5 ? [spec.roles[0], spec.roles[1]] : [spec.roles[1], spec.roles[0]];
  const firstTurn = spec.firstTurn || (Math.random() < 0.5 ? spec.roles[0] : spec.roles[1]);
  const room = {
    id: 'room' + nextRoomId++,
    mode,
    spec,
    size: spec.size,
    roles,
    players: {},
    passwords: {},
    map: generateMap(spec.size, spec.riverWidth, spec.bridges, spec.riverDir),
    units: [],
    phase: 'setup',
    turn: firstTurn,
    winner: null,
    draw: false,
    movesCount: {},
    lastEvent: null,
    drawProposed: null,
    nextUnitId: 1,
    turnNumber: 0,
    territory: null,
    saved: false
  };
  if (mode === '10v20') {
    autoPlaceUnits(room, 'attacker');
  } else {
    autoPlaceUnits(room, 'player1');
    autoPlaceUnits(room, 'player2');
    room.phase = 'battle';
  }
  return room;
}

function getOpponent(room, role) {
  return role === room.roles[0] ? room.roles[1] : room.roles[0];
}

function isTopRole(room, role) {
  if (room.mode === '10v20') return role === 'defender';
  return role === 'player1';
}

function territoryCells(room, role) {
  const size = room.size;
  const cells = new Set();
  const isTop = isTopRole(room, role);
  room.units.filter(u => u.owner === role).forEach(u => {
    cells.add(`${u.y},${u.x}`);
    getShotCells(room, u).forEach(c => cells.add(`${c.y},${c.x}`));
    const backDy = isTop ? -1 : 1;
    let k = 1;
    while (true) {
      const ny = u.y + backDy * k;
      if (ny < 0 || ny >= size) break;
      for (let off = -1; off <= 1; off++) {
        const nx = u.x + off;
        if (nx < 0 || nx >= size) continue;
        cells.add(`${ny},${nx}`);
      }
      k++;
    }
  });
  return cells;
}

function calcTerritoryState(room) {
  const size = room.size;
  const total = size * size;
  const result = {};
  room.roles.forEach(r => {
    const cellsMe = territoryCells(room, r);
    const opp = getOpponent(room, r);
    const cellsOpp = territoryCells(room, opp);
    const mine = [];
    cellsMe.forEach(k => {
      if (!cellsOpp.has(k)) mine.push(k);
    });
    result[r] = { cells: mine, count: mine.length, percent: Math.round((mine.length / total) * 100) };
  });
  return result;
}

function publicState(room, role) {
  const size = room.size;
  const myUnits = room.units.filter(u => u.owner === role);
  const visible = new Set();
  myUnits.forEach(u => {
    visionCells(room, u).forEach(c => visible.add(`${c.y},${c.x}`));
    visible.add(`${u.y},${u.x}`);
  });
  const seesAll = room.mode === '10v20' && role === 'defender';
  const mapOut = [];
  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      const key = `${y},${x}`;
      const vis = seesAll || visible.has(key);
      row.push(
        vis
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
      return visible.has(`${u.y},${u.x}`);
    })
    .map(u => ({
      id: u.id,
      owner: u.owner,
      x: u.x,
      y: u.y,
      dir: u.dir,
      hp: u.hp,
      acted: u.acted,
      type: u.type,
      reloading: u.reloading
    }));

  let territory = null;
  if (room.mode === 'capture') {
    const t = calcTerritoryState(room);
    const opp = getOpponent(room, role);
    territory = {
      me: t[role].percent,
      enemy: t[opp].percent,
      myCells: t[role].cells,
      enemyCells: t[opp].cells
    };
  }
  let setupZone = null;
  if (room.phase === 'setup' && role === 'defender' && room.mode === '10v20') {
    setupZone = [1, Math.floor(room.size / 2) - 2];
  }
  return {
    roomId: room.id,
    mode: room.mode,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    draw: room.draw,
    size,
    map: mapOut,
    units,
    role,
    lastEvent: room.lastEvent,
    drawProposed: room.drawProposed,
    movesCount: room.movesCount,
    drawLimit: room.spec.drawLimit ?? 0,
    turnLimit: room.spec.turnLimit ?? 0,
    turnNumber: room.turnNumber,
    territory,
    setupZone,
    saved: room.saved
  };
}

function broadcast(room) {
  for (const role of Object.keys(room.players)) {
    const ws = room.players[role];
    if (ws) sendTo(ws, { type: 'state', state: publicState(room, role) });
  }
}

function checkEnd(room) {
  if (room.phase === 'setup') return;
  const counts = {};
  room.roles.forEach(r => (counts[r] = room.units.filter(u => u.owner === r).length));
  const alive = room.roles.filter(r => counts[r] > 0);
  if (alive.length === 0) {
    room.phase = 'over';
    room.draw = true;
  } else if (alive.length === 1) {
    room.phase = 'over';
    room.winner = alive[0];
  }
}

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'joinQueue') {
      const mode = msg.mode;
      if (!MODES[mode] || ws.roomId) return;
      const password = (msg.password || '').trim();

      if (password && passwordIndex.has(password)) {
        const existing = passwordIndex.get(password);
        const r = rooms.get(existing.roomId);
        if (!r) {
          passwordIndex.delete(password);
        } else if (!r.saved && !r.players[existing.role]) {
          // Восстановление по паролю — сразу в игру
          ws.roomId = r.id;
          ws.role = existing.role;
          r.players[existing.role] = ws;
          for (const ro of Object.keys(r.players)) {
            const w = r.players[ro];
            if (w) sendTo(w, { type: 'matched', role: ro, roomId: r.id, mode: r.mode });
          }
          broadcast(r);
          return;
        } else {
          sendTo(ws, { type: 'error', message: 'Пароль занят' });
          return;
        }
      }

      const waitingId = waitingRoomByMode[mode];
      if (waitingId) {
        const r = rooms.get(waitingId);
        if (r && !r.saved) {
          const freeRole = r.roles.find(ro => !r.players[ro]);
          if (freeRole) {
            r.players[freeRole] = ws;
            ws.roomId = r.id;
            ws.role = freeRole;
            r.passwords[freeRole] = password || null;
            const bothSaved = r.roles.every(ro => r.passwords[ro]);
            r.saved = bothSaved;
            if (password) passwordIndex.set(password, { roomId: r.id, role: freeRole });
            if (!bothSaved) {
              for (const ro of r.roles) {
                if (r.passwords[ro] && r.players[ro]) {
                  sendTo(r.players[ro], { type: 'warnPassword' });
                }
              }
            }
            waitingRoomByMode[mode] = null;
            checkEnd(r);
            // Обоим отправляем matched
            for (const ro of Object.keys(r.players)) {
              const w = r.players[ro];
              if (w) sendTo(w, { type: 'matched', role: ro, roomId: r.id, mode: r.mode });
            }
            broadcast(r);
            return;
          }
        } else if (r && r.saved) {
          waitingRoomByMode[mode] = null;
        }
      }

      // Создаём новую — первый игрок ЖДЁТ
      const room = createRoom(mode);
      const firstRole = room.roles[0];
      room.players[firstRole] = ws;
      room.passwords[firstRole] = password || null;
      ws.roomId = room.id;
      ws.role = firstRole;
      if (password) passwordIndex.set(password, { roomId: room.id, role: firstRole });
      rooms.set(room.id, room);
      waitingRoomByMode[mode] = room.id;
      checkEnd(room);
      // Отправляем waiting, а не matched
      sendTo(ws, { type: 'waiting' });
      return;
    }

    if (msg.type === 'resumeByPassword') {
      const password = (msg.password || '').trim();
      if (!password) {
        sendTo(ws, { type: 'error', message: 'Введите пароль' });
        return;
      }
      const entry = passwordIndex.get(password);
      if (!entry) {
        sendTo(ws, { type: 'error', message: 'Партия не найдена' });
        return;
      }
      const room = rooms.get(entry.roomId);
      if (!room) {
        clearPasswordIndexFor(entry.roomId);
        sendTo(ws, { type: 'error', message: 'Партия закрыта' });
        return;
      }
      if (room.players[entry.role]) {
        sendTo(ws, { type: 'error', message: 'Эта сторона занята' });
        return;
      }
      room.players[entry.role] = ws;
      ws.roomId = room.id;
      ws.role = entry.role;
      if (Object.keys(room.players).length >= 2) {
        for (const m of Object.keys(waitingRoomByMode)) {
          if (waitingRoomByMode[m] === room.id) waitingRoomByMode[m] = null;
        }
      }
      // Обоим matched
      for (const ro of Object.keys(room.players)) {
        const w = room.players[ro];
        if (w) sendTo(w, { type: 'matched', role: ro, roomId: room.id, mode: room.mode });
      }
      broadcast(room);
      return;
    }

    if (msg.type === 'cancelQueue') {
      const rid = ws.roomId;
      if (rid) {
        const r = rooms.get(rid);
        if (r) {
          delete r.players[ws.role];
          if (Object.keys(r.players).length === 0 && !r.saved) {
            deleteRoom(rid);
          }
        }
      }
      ws.roomId = null;
      ws.role = null;
      sendTo(ws, { type: 'queueCancelled' });
      return;
    }

    if (msg.type === 'leave' || msg.type === 'surrender') {
      const room = rooms.get(ws.roomId);
      if (room) {
        for (const r of Object.keys(room.players)) {
          if (room.players[r] && room.players[r] !== ws) {
            sendTo(room.players[r], { type: 'opponentLeft', surrender: msg.type === 'surrender' });
          }
        }
        delete room.players[ws.role];
        if (!room.saved && Object.keys(room.players).length === 0) {
          deleteRoom(room.id);
        }
      }
      ws.roomId = null;
      ws.role = null;
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) return;
    const role = ws.role;

    if (msg.type === 'setup') {
      if (room.phase !== 'setup' || room.mode !== '10v20' || role !== 'defender') return;
      const need = room.spec.defender.infantry + room.spec.defender.cannons;
      const units = msg.units || [];
      if (units.length !== need) {
        sendTo(ws, { type: 'error', message: 'Нужно ' + need + ' бойцов' });
        return;
      }
      const infList = units.filter(u => u.type === 'infantry');
      const canList = units.filter(u => u.type === 'cannon');
      if (
        infList.length !== room.spec.defender.infantry ||
        canList.length !== room.spec.defender.cannons
      ) {
        sendTo(ws, { type: 'error', message: 'Неверное число' });
        return;
      }
      const taken = new Set();
      const centerY = Math.floor(room.size / 2);
      for (const u of units) {
        if (!inside(room.size, u.x, u.y)) {
          sendTo(ws, { type: 'error', message: 'Вне поля' });
          return;
        }
        if (u.y < 1 || u.y > centerY - 2) {
          sendTo(ws, { type: 'error', message: 'Вне зоны' });
          return;
        }
        const cell = room.map[u.y][u.x];
        if (cell.terrain === 'river' && !cell.bridge) {
          sendTo(ws, { type: 'error', message: 'Река' });
          return;
        }
        const k = `${u.y},${u.x}`;
        if (taken.has(k)) {
          sendTo(ws, { type: 'error', message: 'Занято' });
          return;
        }
        taken.add(k);
      }
      room.units = room.units.filter(u => u.owner !== 'defender');
      units.forEach(u => {
        room.units.push({
          id: room.nextUnitId++,
          owner: 'defender',
          x: u.x,
          y: u.y,
          dir: 4,
          hp: 2,
          acted: false,
          type: u.type,
          reloading: false
        });
      });
      room.phase = 'battle';
      checkEnd(room);
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
      if (!u || u.hp <= 0) {
        sendTo(ws, { type: 'error', message: 'Недоступен' });
        return;
      }
      if (u.acted) {
        sendTo(ws, { type: 'error', message: 'Уже ходил' });
        return;
      }
      if (u.reloading && (msg.action === 'shoot' || msg.action === 'shootCannon')) {
        sendTo(ws, { type: 'error', message: 'Перезарядка' });
        return;
      }
      applyAction(room, role, u, msg);
      checkEnd(room);
      broadcast(room);
      return;
    }

    if (msg.type === 'endTurn') {
      if (room.phase !== 'battle' || room.turn !== role) return;
      room.movesCount[role] = (room.movesCount[role] || 0) + 1;
      room.turnNumber++;
      const nextPlayer = getOpponent(room, role);
      room.units.forEach(x => {
        x.acted = false;
        if (x.owner === nextPlayer) x.reloading = false;
      });
      room.drawProposed = null;

      if (room.mode === '15v15' && room.spec.drawLimit) {
        const my = room.movesCount[role] || 0;
        const opp = room.movesCount[nextPlayer] || 0;
        if (my >= room.spec.drawLimit && opp >= room.spec.drawLimit) {
          room.phase = 'over';
          room.draw = true;
        }
      }
      if (room.mode === 'capture' && room.spec.turnLimit) {
        if (room.turnNumber >= room.spec.turnLimit * 2) {
          room.phase = 'over';
          const t = calcTerritoryState(room);
          const a = t[room.roles[0]].count;
          const b = t[room.roles[1]].count;
          if (a > b) room.winner = room.roles[0];
          else if (b > a) room.winner = room.roles[1];
          else room.draw = true;
        }
      }

      if (room.phase === 'battle') {
        room.turn = nextPlayer;
        room.lastEvent = { kind: 'turnEnded', by: role, at: Date.now() };
      }
      broadcast(room);
      return;
    }

    if (msg.type === 'proposeDraw') {
      if (room.phase !== 'battle') return;
      if (room.mode !== '15v15' && room.mode !== 'capture') return;
      if (room.drawProposed) return;
      room.drawProposed = { by: role, at: Date.now() };
      broadcast(room);
      return;
    }
    if (msg.type === 'acceptDraw') {
      if (room.phase !== 'battle') return;
      if (!room.drawProposed || room.drawProposed.by === role) return;
      room.phase = 'over';
      room.draw = true;
      broadcast(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomId);
    if (room) {
      if (room.players[ws.role] === ws) delete room.players[ws.role];
      for (const r of Object.keys(room.players)) {
        if (room.players[r]) sendTo(room.players[r], { type: 'opponentLeft' });
      }
      if (!room.saved && Object.keys(room.players).length === 0) {
        deleteRoom(room.id);
      }
    }
    ws.roomId = null;
    ws.role = null;
  });
});

function applyAction(room, role, u, a) {
  if (a.action === 'move') {
    const dx = a.dx,
      dy = a.dy;
    if (dx === 0 && dy === 0) return;
    const maxSteps = u.type === 'cannon' ? 1 : 2;
    if (Math.abs(dx) > maxSteps || Math.abs(dy) > maxSteps) return;
    if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) return;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const stepX = Math.sign(dx),
      stepY = Math.sign(dy);
    for (let s = 1; s <= steps; s++) {
      const nx = u.x + stepX * s,
        ny = u.y + stepY * s;
      if (!inside(room.size, nx, ny)) return;
      const cell = room.map[ny][nx];
      if (cell.terrain === 'river' && !cell.bridge) return;
      if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0 && o.id !== u.id)) return;
    }
    u.x += dx;
    u.y += dy;
    u.acted = true;
  } else if (a.action === 'rotate') {
    if (a.dir < 0 || a.dir > 7 || u.dir === a.dir) return;
    u.dir = a.dir;
    u.acted = true;
  } else if (a.action === 'shoot') {
    const t = room.units.find(o => o.id === a.targetId && o.owner !== role && o.hp > 0);
    if (!t || u.type === 'cannon') return;
    if (!canShootInfantry(room, u, t)) return;
    const p = hitChanceInfantry(room, u, t);
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
    if (u.type === 'cannon') return;
    const x = a.x,
      y = a.y;
    if (!inside(room.size, x, y)) return;
    const shots = infantryShotCells(room, u);
    if (!shots.some(c => c.x === x && c.y === y)) return;
    const t = room.units.find(o => o.x === x && o.y === y && o.owner !== role && o.hp > 0);
    let hit = false,
      killed = false;
    if (t) {
      let p = hitChanceInfantry(room, u, t) * 0.75;
      p = Math.max(0.05, Math.min(0.95, p));
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
  } else if (a.action === 'shootCannon') {
    if (u.type !== 'cannon') return;
    const cells = cannonShotCells(room, u);
    if (!cells.some(c => c.x === a.x && c.y === a.y)) return;
    const dist = Math.max(Math.abs(a.x - u.x), Math.abs(a.y - u.y));
    const onHill = room.map[u.y][u.x].terrain === 'hill';
    let p = 0.80 - (dist - 5) * 0.03;
    if (onHill) p += 0.05;
    p = Math.max(0.10, Math.min(0.90, p));
    const hitExact = Math.random() < p;
    let fx = a.x,
      fy = a.y;
    if (!hitExact) {
      const shifts = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      const sh = shifts[Math.floor(Math.random() * 4)];
      if (inside(room.size, fx + sh[0], fy + sh[1])) {
        fx += sh[0];
        fy += sh[1];
      }
    }
    const killedIds = [],
      hurtIds = [];
    const target = room.units.find(o => o.x === fx && o.y === fy && o.owner !== role && o.hp > 0);
    if (hitExact && target) {
      target.hp -= 2;
      hurtIds.push(target.id);
      if (target.hp <= 0) killedIds.push(target.id);
    }
    const explosionCells = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const ex = fx + dx,
          ey = fy + dy;
        if (!inside(room.size, ex, ey)) continue;
        explosionCells.push({ x: ex, y: ey });
        if (dx === 0 && dy === 0 && hitExact) continue;
        const v = room.units.find(o => o.x === ex && o.y === ey && o.owner !== role && o.hp > 0);
        if (!v) continue;
        let chance = 0.18;
        const vc = room.map[ey][ex];
        if (vc.terrain === 'forest') chance *= 0.5;
        if (vc.terrain === 'hill') chance *= 0.9;
        chance = Math.max(0.05, Math.min(0.95, chance));
        if (Math.random() < chance) {
          v.hp -= 1;
          if (!hurtIds.includes(v.id)) hurtIds.push(v.id);
          if (v.hp <= 0 && !killedIds.includes(v.id)) killedIds.push(v.id);
        }
      }
    }
    room.units = room.units.filter(o => o.hp > 0);
    u.acted = true;
    u.reloading = true;
    room.lastEvent = {
      kind: 'shot',
      by: role,
      from: { x: u.x, y: u.y },
      to: { x: fx, y: fy },
      hit: hitExact,
      killed: killedIds.length > 0,
      cannon: true,
      explosion: { x: fx, y: fy, cells: explosionCells, hitIds: hurtIds, killedIds },
      at: Date.now()
    };
  }
}

function canShootInfantry(room, s, t) {
  const onHill = room.map[s.y][s.x].terrain === 'hill';
  const maxR = 6 + (onHill ? 2 : 0);
  const v = DIR_VECS[s.dir];
  const starts = parallelStarts(s, s.dir);
  for (const st of starts) {
    for (let k = 0; k < maxR; k++) {
      const nx = st.x + v.dx * k,
        ny = st.y + v.dy * k;
      if (!inside(room.size, nx, ny)) break;
      if (nx === t.x && ny === t.y) return true;
      if (!onHill) {
        const c = room.map[ny][nx];
        if (c.terrain === 'river' && !c.bridge) break;
        if (c.terrain === 'forest' || c.terrain === 'hill') break;
        if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0 && o.owner === s.owner && o.id !== s.id)) break;
      }
    }
  }
  return false;
}

function hitChanceInfantry(room, s, t) {
  const dist = Math.max(Math.abs(s.x - t.x), Math.abs(s.y - t.y));
  const onHill = room.map[s.y][s.x].terrain === 'hill';
  const maxR = 6 + (onHill ? 2 : 0);
  let p = 0.95 - (dist / maxR) * 0.7;
  if (onHill) p += 0.15;
  if (room.map[t.y][t.x].terrain === 'forest') p -= 0.25;
  return Math.max(0.05, Math.min(0.95, p));
}

server.listen(PORT, '0.0.0.0', () => console.log('Сервер запущен на порту ' + PORT));
