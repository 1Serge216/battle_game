const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

const MODES = {
    '10v20': {
        size: 20, riverWidth: 2, bridges: 4,
        defender: { infantry: 10, cannons: 2 },
        attacker: { infantry: 20, cannons: 3 },
        roles: ['defender', 'attacker'],
        firstTurn: 'defender',
        defZone: [1, 8], atkZone: [12, 18]
    },
    '15v15': {
        size: 20, riverWidth: 2, bridges: 3,
        player1: { infantry: 15, cannons: 0 },
        player2: { infantry: 15, cannons: 0 },
        roles: ['player1', 'player2'],
        drawLimit: 100,
        defZone: [1, 6], atkZone: [14, 18]
    },
    'capture': {
        size: 15, riverWidth: 1, bridges: 3,
        player1: { infantry: 15, cannons: 0 },
        player2: { infantry: 15, cannons: 0 },
        roles: ['player1', 'player2'],
        turnLimit: 30,
        defZone: [1, 5], atkZone: [10, 13]
    }
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

function inside(size, x, y) { return x >= 0 && y >= 0 && x < size && y < size; }

function generateMap(size, riverWidth, bridgesCount) {
    const m = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => ({ terrain: 'plain', bridge: false }))
    );
    const center = Math.floor(size / 2);
    const startX = center - Math.floor(riverWidth / 2);
    let rx = startX;
    for (let y = 0; y < size; y++) {
        rx += Math.floor(Math.random() * 3) - 1;
        rx = Math.max(startX - 2, Math.min(startX + 2, rx));
        for (let w = 0; w < riverWidth; w++) {
            const x = rx + w;
            if (x >= 0 && x < size) m[y][x].terrain = 'river';
        }
    }
    const usedRows = [];
    let placed = 0, attempts = 0;
    while (placed < bridgesCount && attempts < 500) {
        attempts++;
        const y = 3 + Math.floor(Math.random() * (size - 7));
        if (usedRows.some(r => Math.abs(r - y) < 3)) continue;
        let bestX = -1;
        for (let x = 0; x < size - 1; x++) {
            if (m[y][x].terrain === 'river' && m[y + 1][x].terrain === 'river') { bestX = x; break; }
        }
        if (bestX < 0) continue;
        m[y][bestX].bridge = true;
        m[y + 1][bestX].bridge = true;
        if (bestX + 1 < size && m[y][bestX + 1].terrain === 'river' && m[y + 1][bestX + 1].terrain === 'river') {
            m[y][bestX + 1].bridge = true;
            m[y + 1][bestX + 1].bridge = true;
        }
        usedRows.push(y);
        placed++;
    }
    const hillCount = Math.max(8, Math.floor(size * size * 0.045));
    const forestCount = Math.max(20, Math.floor(size * size * 0.11));
    const place = (t, n) => {
        let c = 0, att = 0;
        while (c < n && att < n * 30) {
            att++;
            const y = 1 + Math.floor(Math.random() * (size - 2));
            const x = Math.floor(Math.random() * size);
            const cell = m[y][x];
            if (cell.terrain === 'plain' && !cell.bridge) { cell.terrain = t; c++; }
        }
    };
    place('hill', hillCount);
    place('forest', forestCount);
    return m;
}

const DIR_VECS = [
    { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
    { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 }
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
            const nx = s.x + v.dx * k, ny = s.y + v.dy * k;
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

function canShootInfantry(room, s, t) {
    const onHill = room.map[s.y][s.x].terrain === 'hill';
    const maxR = 6 + (onHill ? 2 : 0);
    const v = DIR_VECS[s.dir];
    const starts = parallelStarts(s, s.dir);
    for (const st of starts) {
        for (let k = 0; k < maxR; k++) {
            const nx = st.x + v.dx * k, ny = st.y + v.dy * k;
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
        const nx = unit.x + v.dx * k, ny = unit.y + v.dy * k;
        if (!inside(room.size, nx, ny)) break;
        out.push({ x: nx, y: ny });
    }
    return out;
}

function getShotCells(room, unit) {
    return unit.type === 'cannon' ? cannonShotCells(room, unit) : infantryShotCells(room, unit);
}

function autoPlaceUnits(room, role) {
    const spec = room.mode === '10v20'
        ? (role === 'defender' ? room.spec.defender : room.spec.attacker)
        : (role === 'player1' ? room.spec.player1 : room.spec.player2);
    const isTop = role === 'defender' || role === 'player1';
    const zone = isTop ? room.spec.defZone : room.spec.atkZone;
    const need = (spec.infantry || 0) + (spec.cannons || 0);
    if (need === 0) return;
    const size = room.size;
    const centerX = Math.floor(size / 2);
    const taken = new Set();
    room.units.forEach(u => taken.add(u.y + ',' + u.x));
    const positions = [];
    for (let y = zone[0]; y <= zone[1]; y++) {
        const order = [centerX];
        for (let off = 1; off < size; off++) {
            const d = Math.ceil(off / 2);
            const sign = off % 2 === 1 ? 1 : -1;
            order.push(centerX + d * sign);
        }
        for (const x of order) {
            if (x < 0 || x >= size) continue;
            if (positions.length >= need) break;
            const key = y + ',' + x;
            if (taken.has(key)) continue;
            const cell = room.map[y][x];
            if (cell.terrain === 'river' && !cell.bridge) continue;
            taken.add(key);
            positions.push({ x, y });
        }
        if (positions.length >= need) break;
    }
    let cannonPositions, infantryPositions;
    if (isTop) {
        // Защитник — пушки СВЕРХУ (в тылу), пехота ниже (фронт)
        cannonPositions = positions.slice(0, spec.cannons);
        infantryPositions = positions.slice(spec.cannons, spec.cannons + spec.infantry);
    } else {
        // Атакующий — пехота сверху (фронт), пушки ниже (тыл)
        infantryPositions = positions.slice(0, spec.infantry);
        cannonPositions = positions.slice(spec.infantry, spec.infantry + spec.cannons);
    }
    const dir = isTop ? 4 : 0;
    infantryPositions.forEach(p => {
        room.units.push({ id: room.nextUnitId++, owner: role, x: p.x, y: p.y, dir, hp: 2, acted: false, type: 'infantry', reloading: false });
    });
    cannonPositions.forEach(p => {
        room.units.push({ id: room.nextUnitId++, owner: role, x: p.x, y: p.y, dir, hp: 2, acted: false, type: 'cannon', reloading: false });
    });
}

const rooms = new Map();
const waiting = { '10v20': [], '15v15': [], 'capture': [] };
let nextRoomId = 1;

function sendTo(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function createRoom(mode) {
    const spec = MODES[mode];
    const roles = Math.random() < 0.5 ? [spec.roles[0], spec.roles[1]] : [spec.roles[1], spec.roles[0]];
    const firstTurn = spec.firstTurn || (Math.random() < 0.5 ? spec.roles[0] : spec.roles[1]);
    const room = {
        id: 'room' + (nextRoomId++),
        mode, spec, size: spec.size, roles,
        players: {},
        map: generateMap(spec.size, spec.riverWidth, spec.bridges),
        units: [], phase: 'setup', turn: firstTurn,
        winner: null, draw: false,
        movesCount: {}, lastEvent: null, drawProposed: null,
        nextUnitId: 1, turnNumber: 0, territory: null
    };
    if (mode === '10v20') {
        autoPlaceUnits(room, 'attacker');
        // защитник расставляет вручную
    } else {
        autoPlaceUnits(room, 'player1');
        autoPlaceUnits(room, 'player2');
        room.phase = 'battle';
    }
    if (mode === 'capture') room.territory = calcTerritory(room);
    return room;
}

function publicState(room, role) {
    const size = room.size;
    const myUnits = room.units.filter(u => u.owner === role);
    const visible = new Set();
    myUnits.forEach(u => {
        visionCells(room, u).forEach(c => visible.add(c.y + ',' + c.x));
        visible.add(u.y + ',' + u.x);
    });
    const seesAll = room.mode === '10v20' && role === 'defender';
    const mapOut = [];
    for (let y = 0; y < size; y++) {
        const row = [];
        for (let x = 0; x < size; x++) {
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
        .map(u => ({
            id: u.id, owner: u.owner, x: u.x, y: u.y, dir: u.dir, hp: u.hp,
            acted: u.acted, type: u.type, reloading: u.reloading
        }));
    let territory = null;
    if (room.mode === 'capture' && room.territory) {
        const opp = getOpponent(room, role);
        territory = { me: room.territory[role] || 0, enemy: room.territory[opp] || 0 };
    }
    return {
        roomId: room.id, mode: room.mode, phase: room.phase, turn: room.turn,
        winner: room.winner, draw: room.draw, size, map: mapOut, units, role,
        lastEvent: room.lastEvent, drawProposed: room.drawProposed, movesCount: room.movesCount,
        drawLimit: room.spec.drawLimit || 0, turnLimit: room.spec.turnLimit || 0,
        turnNumber: room.turnNumber, territory
    };
}

function broadcast(room) {
    for (const role of Object.keys(room.players)) {
        const ws = room.players[role];
        if (ws) sendTo(ws, { type: 'state', state: publicState(room, role) });
    }
}

function getOpponent(room, role) {
    return role === room.roles[0] ? room.roles[1] : room.roles[0];
}

function checkEnd(room) {
    const counts = {};
    room.roles.forEach(r => counts[r] = room.units.filter(u => u.owner === r).length);
    const alive = room.roles.filter(r => counts[r] > 0);
    if (alive.length === 0) { room.phase = 'over'; room.draw = true; }
    else if (alive.length === 1) { room.phase = 'over'; room.winner = alive[0]; }
}

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'joinQueue') {
            const mode = msg.mode;
            if (!MODES[mode] || ws.roomId) return;
            const q = waiting[mode];
            if (q.length > 0) {
                const opponent = q.shift();
                const room = createRoom(mode);
                const [r1, r2] = room.roles;
                room.players[r1] = opponent; room.players[r2] = ws;
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
            Object.keys(waiting).forEach(m => {
                const i = waiting[m].indexOf(ws);
                if (i >= 0) waiting[m].splice(i, 1);
            });
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
                rooms.delete(room.id);
            }
            ws.roomId = null; ws.role = null;
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
            if (infList.length !== room.spec.defender.infantry || canList.length !== room.spec.defender.cannons) {
                sendTo(ws, { type: 'error', message: 'Неверное число пехоты/пушек' });
                return;
            }
            const taken = new Set();
            const zone = room.spec.defZone;
            for (const u of units) {
                if (!inside(room.size, u.x, u.y)) {
                    sendTo(ws, { type: 'error', message: 'Вне поля' });
                    return;
                }
                if (u.y < zone[0] || u.y > zone[1]) {
                    sendTo(ws, { type: 'error', message: 'Вне зоны расстановки' });
                    return;
                }
                const cell = room.map[u.y][u.x];
                if (cell.terrain === 'river' && !cell.bridge) {
                    sendTo(ws, { type: 'error', message: 'Река' });
                    return;
                }
                const k = u.y + ',' + u.x;
                if (taken.has(k)) {
                    sendTo(ws, { type: 'error', message: 'Клетка занята' });
                    return;
                }
                taken.add(k);
            }
            room.units = room.units.filter(u => u.owner !== 'defender');
            units.forEach(u => {
                room.units.push({
                    id: room.nextUnitId++, owner: 'defender', x: u.x, y: u.y, dir: 4, hp: 2,
                    acted: false, type: u.type, reloading: false
                });
            });
            room.phase = 'battle';
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
                sendTo(ws, { type: 'error', message: 'Боец недоступен' });
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
                    room.phase = 'over'; room.draw = true;
                }
            }

            if (room.mode === 'capture' && room.spec.turnLimit) {
                if (room.turnNumber >= room.spec.turnLimit * 2) {
                    room.phase = 'over';
                    const scores = calcTerritory(room);
                    const diff = (scores[room.roles[0]] || 0) - (scores[room.roles[1]] || 0);
                    if (diff > 0) room.winner = room.roles[0];
                    else if (diff < 0) room.winner = room.roles[1];
                    else room.draw = true;
                }
            }

            if (room.phase === 'battle') {
                room.turn = nextPlayer;
                room.lastEvent = { kind: 'turnEnded', by: role, at: Date.now() };
            }

            if (room.mode === 'capture') room.territory = calcTerritory(room);
            broadcast(room);
            return;
        }

        if (msg.type === 'proposeDraw') {
            if (room.phase !== 'battle' || room.mode !== '15v15' || room.drawProposed) return;
            room.drawProposed = { by: role, at: Date.now() };
            broadcast(room);
            return;
        }
        if (msg.type === 'acceptDraw') {
            if (room.phase !== 'battle' || room.mode !== '15v15') return;
            if (!room.drawProposed || room.drawProposed.by === role) return;
            room.phase = 'over'; room.draw = true;
            broadcast(room);
            return;
        }
    });

    ws.on('close', () => {
        Object.keys(waiting).forEach(m => {
            const i = waiting[m].indexOf(ws);
            if (i >= 0) waiting[m].splice(i, 1);
        });
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
        const dx = a.dx, dy = a.dy;
        if (dx === 0 && dy === 0) return;
        const maxSteps = u.type === 'cannon' ? 1 : 2;
        if (Math.abs(dx) > maxSteps || Math.abs(dy) > maxSteps) return;
        if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) return;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));
        const stepX = Math.sign(dx), stepY = Math.sign(dy);
        for (let s = 1; s <= steps; s++) {
            const nx = u.x + stepX * s, ny = u.y + stepY * s;
            if (!inside(room.size, nx, ny)) return;
            const cell = room.map[ny][nx];
            if (cell.terrain === 'river' && !cell.bridge) return;
            if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0 && o.id !== u.id)) return;
        }
        u.x += dx; u.y += dy; u.acted = true;
    } else if (a.action === 'rotate') {
        if (a.dir < 0 || a.dir > 7 || u.dir === a.dir) return;
        u.dir = a.dir; u.acted = true;
    } else if (a.action === 'shoot') {
        const t = room.units.find(o => o.id === a.targetId && o.owner !== role && o.hp > 0);
        if (!t || u.type === 'cannon') return;
        if (!canShootInfantry(room, u, t)) return;
        const p = hitChanceInfantry(room, u, t);
        const hit = Math.random() < p;
        let killed = false;
        if (hit) {
            t.hp -= 1;
            if (t.hp <= 0) { room.units = room.units.filter(o => o.id !== t.id); killed = true; }
        }
        u.acted = true;
        room.lastEvent = {
            kind: 'shot', by: role, from: { x: u.x, y: u.y }, to: { x: t.x, y: t.y },
            hit, killed, at: Date.now()
        };
    } else if (a.action === 'shootAt') {
        if (u.type === 'cannon') return;
        const x = a.x, y = a.y;
        if (!inside(room.size, x, y)) return;
        const shots = infantryShotCells(room, u);
        if (!shots.some(c => c.x === x && c.y === y)) return;
        const t = room.units.find(o => o.x === x && o.y === y && o.owner !== role && o.hp > 0);
        let hit = false, killed = false;
        if (t) {
            let p = hitChanceInfantry(room, u, t) * 0.75;
            p = Math.max(0.05, Math.min(0.95, p));
            hit = Math.random() < p;
            if (hit) {
                t.hp -= 1;
                if (t.hp <= 0) { room.units = room.units.filter(o => o.id !== t.id); killed = true; }
            }
        }
        u.acted = true;
        room.lastEvent = {
            kind: 'shot', by: role, from: { x: u.x, y: u.y }, to: { x, y },
            hit, killed, blind: true, at: Date.now()
        };
    } else if (a.action === 'shootCannon') {
        if (u.type !== 'cannon') return;
        const cells = cannonShotCells(room, u);
        if (!cells.some(c => c.x === a.x && c.y === a.y)) return;
        const dist = Math.max(Math.abs(a.x - u.x), Math.abs(a.y - u.y));
        const onHill = room.map[u.y][u.x].terrain === 'hill';
        let p = 0.95 - (dist - 5) * 0.05;
        if (onHill) p += 0.05;
        p = Math.max(0.05, Math.min(0.95, p));
        const hitExact = Math.random() < p;
        let finalX = a.x, finalY = a.y;
        if (!hitExact) {
            const shifts = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            const sh = shifts[Math.floor(Math.random() * 4)];
            if (inside(room.size, finalX + sh[0], finalY + sh[1])) { finalX += sh[0]; finalY += sh[1]; }
        }
        const killedIds = [], hurtIds = [];
        const target = room.units.find(o => o.x === finalX && o.y === finalY && o.owner !== role && o.hp > 0);
        if (hitExact && target) {
            target.hp -= 2;
            hurtIds.push(target.id);
            if (target.hp <= 0) killedIds.push(target.id);
        }
        const explosionCells = [];
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const ex = finalX + dx, ey = finalY + dy;
                if (!inside(room.size, ex, ey)) continue;
                explosionCells.push({ x: ex, y: ey });
                if (dx === 0 && dy === 0 && hitExact) continue;
                const victim = room.units.find(o => o.x === ex && o.y === ey && o.owner !== role && o.hp > 0);
                if (!victim) continue;
                let chance = 0.12;
                const vCell = room.map[ey][ex];
                if (vCell.terrain === 'forest') chance *= 0.5;
                if (vCell.terrain === 'hill') chance *= 0.9;
                chance = Math.max(0.05, Math.min(0.95, chance));
                if (Math.random() < chance) {
                    victim.hp -= 1;
                    if (!hurtIds.includes(victim.id)) hurtIds.push(victim.id);
                    if (victim.hp <= 0 && !killedIds.includes(victim.id)) killedIds.push(victim.id);
                }
            }
        }
        room.units = room.units.filter(o => o.hp > 0);
        u.acted = true;
        u.reloading = true;
        room.lastEvent = {
            kind: 'shot', by: role, from: { x: u.x, y: u.y }, to: { x: finalX, y: finalY },
            hit: hitExact, killed: killedIds.length > 0, cannon: true,
            explosion: { x: finalX, y: finalY, cells: explosionCells, hitIds: hurtIds, killedIds },
            at: Date.now()
        };
    }
}

function calcTerritory(room) {
    const scores = {};
    room.roles.forEach(r => scores[r] = 0);
    const owner = new Array(room.size * room.size).fill(null);
    room.roles.forEach(r => {
        const cells = new Set();
        const myIsTop = (room.mode === 'capture' && r === 'player1') || (room.mode === '10v20' && r === 'defender');
        room.units.filter(u => u.owner === r).forEach(u => {
            cells.add(u.y + ',' + u.x);
            getShotCells(room, u).forEach(c => cells.add(c.y + ',' + c.x));
            const backDy = myIsTop ? -1 : 1;
            let k = 1;
            while (true) {
                const ny = u.y + backDy * k;
                if (ny < 0 || ny >= room.size) break;
                for (let off = -1; off <= 1; off++) {
                    const nx = u.x + off;
                    if (nx < 0 || nx >= room.size) continue;
                    cells.add(ny + ',' + nx);
                }
                k++;
            }
        });
        cells.forEach(key => {
            const [ys, xs] = key.split(',');
            const idx = parseInt(ys) * room.size + parseInt(xs);
            if (owner[idx] === null) owner[idx] = r;
            else if (owner[idx] !== r) owner[idx] = 'disputed';
        });
    });
    owner.forEach(o => { if (o && o !== 'disputed' && scores[o] !== undefined) scores[o]++; });
    return scores;
}

server.listen(PORT, '0.0.0.0', () => console.log('Сервер запущен на порту ' + PORT));
