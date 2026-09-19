const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Конфигурации игровых режимов
const MODES = {
    '10v20': {
        size: 15, riverWidth: 1, bridges: 4, riverDir: 'horizontal',
        defender: { infantry: 10, cannons: 2 },
        attacker: { infantry: 20, cannons: 3 },
        roles: ['defender', 'attacker'],
        firstTurn: 'attacker',
        attackerTurnLimit: 25,
        allowDraw: false
    },
    '15v15': {
        size: 15, riverWidth: 1, bridges: 3, riverDir: 'horizontal',
        player1: { infantry: 13, cannons: 3 },
        player2: { infantry: 13, cannons: 3 },
        roles: ['player1', 'player2'],
        drawLimit: 100,
        allowDraw: true
    },
    'capture': {
        size: 15, riverWidth: 1, bridges: 3, riverDir: 'horizontal',
        player1: { infantry: 13, cannons: 3 },
        player2: { infantry: 13, cannons: 3 },
        roles: ['player1', 'player2'],
        turnLimitPerSide: 10,
        allowDraw: true
    },
    'ffa4': {
        size: 18, noRiver: true, extraTerrain: true,
        player1: { infantry: 8, cannons: 2 },
        player2: { infantry: 8, cannons: 2 },
        player3: { infantry: 8, cannons: 2 },
        player4: { infantry: 8, cannons: 2 },
        roles: ['player1', 'player2', 'player3', 'player4'],
        firstTurn: 'player1',
        allowDraw: true,
        passwordRequired: true
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
        // Добавлен MIME-тип для WOFF/woff2 шрифтов, чтобы избежать ошибок загрузки фронтенда
        const mime = { 
            '.html': 'text/html', 
            '.js': 'application/javascript', 
            '.css': 'text/css',
            '.woff': 'font/woff',
            '.woff2': 'font/woff2'
        }[ext] || 'text/plain';
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8' });
        res.end(data);
    });
});

function inside(size, x, y) {
    return x >= 0 && y >= 0 && x < size && y < size;
}

const FFA_BASE_SIZE = 4;
function getFFABase(role, size) {
    const c = FFA_BASE_SIZE;
    switch (role) {
        case 'player1': return { y0: 0, y1: c - 1, x0: 0, x1: c - 1 };
        case 'player2': return { y0: 0, y1: c - 1, x0: size - c, x1: size - 1 };
        case 'player3': return { y0: size - c, y1: size - 1, x0: 0, x1: c - 1 };
        case 'player4': return { y0: size - c, y1: size - 1, x0: size - c, x1: size - 1 };
    }
    return null;
}
function isInAnyFFABase(size, x, y) {
    return ['player1', 'player2', 'player3', 'player4'].some(r => {
        const b = getFFABase(r, size);
        return x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;
    });
}
function ffaFaceDir(role) {
    switch (role) {
        case 'player1': return 3;
        case 'player2': return 5;
        case 'player3': return 1;
        case 'player4': return 7;
    }
    return 0;
}

function generateMap(size, riverWidth, bridgesCount, riverDir, opts) {
    opts = opts || {};
    const m = Array.from({ length: size }, () =>
        Array.from({ length: size }, () => ({ terrain: 'plain', bridge: false }))
    );

    if (!opts.noRiver) {
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
        let placed = 0, attempts = 0;
        while (placed < bridgesCount && attempts < 500) {
            attempts++;
            if (riverDir === 'horizontal') {
                const x = 2 + Math.floor(Math.random() * (size - 5));
                if (used.some(c => Math.abs(c - x) < 3)) continue;
                let by = -1;
                for (let y = 0; y < size; y++) if (m[y][x].terrain === 'river') { by = y; break; }
                if (by < 0) continue;
                m[by][x].bridge = true;
                if (x + 1 < size && m[by][x + 1].terrain === 'river') m[by][x + 1].bridge = true;
                used.push(x); placed++;
            } else {
                const y = 2 + Math.floor(Math.random() * (size - 5));
                if (used.some(c => Math.abs(c - y) < 3)) continue;
                let bx = -1;
                for (let x = 0; x < size; x++) if (m[y][x].terrain === 'river') { bx = x;break; }
                if (bx < 0) continue;
                m[y][bx].bridge = true;
                if (y + 1 < size && m[y + 1][bx].terrain === 'river') m[y + 1][bx].bridge = true;
                used.push(y); placed++;
            }
        }
    }

    const scale = (size * size) / 225;
    const mult = opts.extraTerrain ? 1.2 : 1;
    const hillsN = Math.round(9 * scale * mult);
    const forestsN = Math.round(29 * scale * mult);
    const avoidBases = !!opts.noRiver;
    const place = (t, n) => {
        let c = 0, att = 0;
        while (c < n && att < n * 60) {
            att++;
            const y = 1 + Math.floor(Math.random() * (size - 2));
            const x = Math.floor(Math.random() * size);
            const cell = m[y][x];
            if (cell.terrain !== 'plain' || cell.bridge) continue;
            if (avoidBases && isInAnyFFABase(size, x, y)) continue;
            cell.terrain = t;
            c++;
        }
    };
    place('hill', hillsN);
    place('forest', forestsN);
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

function castLine(room, unit, starts, range, opts) {
    opts = opts || {};
    const size = room.size;
    const v = DIR_VECS[unit.dir];
    const onHill = !!opts.fromHill;
    const blockOwn = !!opts.blockOwnUnits;
    const out = [];
    for (const s of starts) {
        for (let k = 0; k < range; k++) {
            const nx = s.x + v.dx * k, ny = s.y + v.dy * k;
            if (!inside(size, nx, ny)) break;
            out.push({ x: nx, y: ny });
            const t = room.map[ny][nx].terrain;
            if (t === 'hill') break;
            if (t === 'forest' && !onHill) break;
            if (blockOwn && room.units.some(o =>
                o.x === nx && o.y === ny && o.hp > 0 && o.owner === unit.owner && o.id !== unit.id
            )) break;
        }
    }
    return out;
}

function visionCells(room, unit) {
    const onHill = room.map[unit.y][unit.x].terrain === 'hill';
    const range = 9 + (onHill ? 3 : 0);
    return castLine(room, unit, parallelStarts(unit, unit.dir), range, { fromHill: onHill });
}

function infantryShotCells(room, unit) {
    const onHill = room.map[unit.y][unit.x].terrain === 'hill';
    const range = 6 + (onHill ? 2 : 0);
    return castLine(room, unit, parallelStarts(unit, unit.dir), range, { fromHill: onHill, blockOwnUnits: true });
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
    const isTop = role === 'defender' || role === 'player1';
    const spec =
        room.mode === '10v20'
            ? (role === 'defender' ? room.spec.defender : room.spec.attacker)
            : (role === 'player1' ? room.spec.player1 : room.spec.player2);
    const need = spec.infantry + spec.cannons;
    if (need === 0) return;
    const size = room.size;
    const center = Math.floor(size / 2);
    const taken = new Set();
    room.units.forEach(u => taken.add(u.y + ',' + u.x));
    const positions = [];

    const rows = [];
    if (isTop) { for (let y = 1; y <= center - 2; y++) rows.push(y); }
    else { for (let y = size - 2; y >= center + 2; y--) rows.push(y); }

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
            const k = y + ',' + x;
            if (taken.has(k)) continue;
            const cell = room.map[y][x];
            if (cell.terrain === 'river' && !cell.bridge) continue;
            taken.add(k);
            positions.push({ x: x, y: y });
        }
    }

    const cannonPositions = positions.slice(0, spec.cannons);
    const infantryPositions = positions.slice(spec.cannons, spec.cannons + spec.infantry);
    const dir = isTop ? 4 : 0;
    cannonPositions.forEach(p => room.units.push({
        id: room.nextUnitId++, owner: role, x: p.x, y: p.y, dir: dir,
        hp: 2, acted: false, type: 'cannon', reloading: false
    }));
    infantryPositions.forEach(p => room.units.push({
        id: room.nextUnitId++, owner: role, x: p.x, y: p.y, dir: dir,
        hp: 2, acted: false, type: 'infantry', reloading: false
    }));
}

function autoPlaceFFA(room, role) {
    const size = room.size;
    const base = getFFABase(role, size);
    const spec = room.spec[role];
    const dir = ffaFaceDir(role);
    const positions = [];
    for (let y = base.y0; y <= base.y1; y++) {
        for (let x = base.x0; x <= base.x1; x++) {
            if (room.units.some(u => u.x === x && u.y === y)) continue;
            positions.push({ x: x, y: y });
        }
    }
    const cannonPositions = positions.slice(0, spec.cannons);
    const infantryPositions = positions.slice(spec.cannons, spec.cannons + spec.infantry);
    cannonPositions.forEach(p => room.units.push({
        id: room.nextUnitId++, owner: role, x: p.x, y: p.y, dir: dir,
        hp: 2, acted: false, type: 'cannon', reloading: false
    }));
    infantryPositions.forEach(p => room.units.push({
        id: room.nextUnitId++, owner: role, x: p.x, y: p.y, dir: dir,
        hp: 2, acted: false, type: 'infantry', reloading: false
    }));
}

const rooms = new Map();
const passwordIndex = new Map();
const waitingRoomByMode = { '10v20': null, '15v15': null, 'capture': null, 'ffa4': null };
let nextRoomId = 1;

function sendTo(ws, obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function clearPasswordIndexFor(roomId) {
    for (const entry of passwordIndex) {
        const pass = entry[0], val = entry[1];
        if (val.roomId === roomId) passwordIndex.delete(pass);
    }
}

function deleteRoom(roomId) {
    rooms.delete(roomId);
    clearPasswordIndexFor(roomId);
    for (const m of Object.keys(waitingRoomByMode)) {
        if (waitingRoomByMode[m] === roomId) waitingRoomByMode[m] = null;
    }
}

function refreshWaitingSlot(room) {
    const mode = room.mode;
    if (waitingRoomByMode[mode] !== room.id) return;
    const canAccept = !room.saved
        && room.roles.some(r => !room.players[r] && !room.passwords[r]);
    if (!canAccept) waitingRoomByMode[mode] = null;
}

function endGame(room, opts) {
    opts = opts || {};
    if (room.phase === 'over') return;
    room.phase = 'over';
    if (opts.winner !== undefined) room.winner = opts.winner;
    if (opts.draw !== undefined) room.draw = opts.draw;
    if (opts.endReason) room.endReason = opts.endReason;
    room.lastEvent = { kind: 'gameEnded', at: Date.now(), endReason: room.endReason || null };
    clearPasswordIndexFor(room.id);
    room.passwords = {};
    room.saved = false;
    refreshWaitingSlot(room);
}

function createRoom(mode) {
    const spec = MODES[mode];
    const roles = spec.roles.slice();
    if (roles.length === 2 && Math.random() < 0.5) roles.reverse();
    const firstTurn = spec.firstTurn || roles[0];

    const room = {
        id: 'room' + nextRoomId++,
        mode: mode, spec: spec,
        size: spec.size,
        roles: roles,
        players: {},
        passwords: {},
        map: generateMap(spec.size, spec.riverWidth, spec.bridges, spec.riverDir,
            { noRiver: !!spec.noRiver, extraTerrain: !!spec.extraTerrain }),
        units: [],
        phase: 'setup',
        turn: firstTurn,
        winner: null,
        draw: false,
        endReason: null,
        movesCount: {},
        lastEvent: null,
        drawProposed: null,
        nextUnitId: 1,
        turnNumber: 0,
        territory: null,
        saved: false,
        defeatedRoles: new Set(),
        disconnectedRoles: new Set()
    };

    if (mode === 'ffa4') {
        roles.forEach(r => autoPlaceFFA(room, r));
        room.phase = 'battle';
    } else if (mode === '10v20') {
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
    if (room.mode === 'ffa4') return role === 'player1' || role === 'player2';
    return role === 'player1';
}

function territoryCells(room, role) {
    const size = room.size;
    const cells = new Set();
    const isTop = isTopRole(room, role);
    room.units.filter(u => u.owner === role).forEach(u => {
        cells.add(u.y + ',' + u.x);
        getShotCells(room, u).forEach(c => cells.add(c.y + ',' + c.x));
        const backDy = isTop ? -1 : 1;
        let k = 1;
        while (true) {
            const ny = u.y + backDy * k;
            if (ny < 0 || ny >= size) break;
            for (let off = -1; off <= 1; off++) {
                const nx = u.x + off;
                if (nx < 0 || nx >= size) continue;
                cells.add(ny + ',' + nx);
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
        cellsMe.forEach(k => { if (!cellsOpp.has(k)) mine.push(k); });
        result[r] = { cells: mine, count: mine.length, percent: Math.round((mine.length / total) * 100) };
    });
    return result;
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
  }))
        
        .map(u => ({
            id: u.id, owner: u.owner, x: u.x, y: u.y, dir: u.dir,
            hp: u.hp, acted: u.acted, type: u.type, reloading: u.reloading
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

    const unitCounts = {};
    room.roles.forEach(r => {
        unitCounts[r] = room.units.filter(u => u.owner === r && u.hp > 0).length;
    });

    return {
        roomId: room.id,
        mode: room.mode,
        phase: room.phase,
        turn: room.turn,
        winner: room.winner,
        draw: room.draw,
        endReason: room.endReason,
        size: size,
        map: mapOut,
        units: units,
        role: role,
        roles: room.roles,
        lastEvent: room.lastEvent,
        drawProposed: room.drawProposed,
        movesCount: room.movesCount,
        drawLimit: room.spec.drawLimit || 0,
        turnLimit: room.spec.turnLimitPerSide || 0,
        attackerTurnLimit: room.spec.attackerTurnLimit || 0,
        turnNumber: room.turnNumber,
        territory: territory,
        setupZone: setupZone,
        saved: room.saved,
        unitCounts: unitCounts,
        disconnectedRoles: Array.from(room.disconnectedRoles),
        defeatedRoles: Array.from(room.defeatedRoles)
    };
}

function broadcast(room) {
    for (const role of Object.keys(room.players)) {
        const ws = room.players[role];
        if (ws) sendTo(ws, { type: 'state', state: publicState(room, role) });
    }
}

function nextAliveRole(room, afterRole) {
    const idx = room.roles.indexOf(afterRole);
    const n = room.roles.length;
    for (let i = 1; i <= n; i++) {
        const r = room.roles[(idx + i) % n];
        if (room.units.some(u => u.owner === r && u.hp > 0)) return r;
    }
    return null;
}

function notifyDefeated(room) {
    room.roles.forEach(r => {
        const alive = room.units.some(u => u.owner === r && u.hp > 0);
        if (!alive && !room.defeatedRoles.has(r)) {
            room.defeatedRoles.add(r);
            Object.keys(room.players).forEach(rr => {
                const w = room.players[rr];
                if (w) sendTo(w, { type: 'playerDefeated', role: r });
            });
        }
    });
}

function checkEnd(room) {
    if (room.phase !== 'battle') return;
    const counts = {};
    room.roles.forEach(r => counts[r] = room.units.filter(u => u.owner === r && u.hp > 0).length);
    const alive = room.roles.filter(r => counts[r] > 0);

    notifyDefeated(room);

    if (room.mode === 'ffa4') {
        if(alive.length <= 1) {
            if (alive.length === 1) endGame(room, { winner: alive[0], endReason: 'lastStanding' });
            else endGame(room, { draw: true, endReason: 'allDead' });
        }
    } else {
        if (alive.length === 0) endGame(room, { draw: true, endReason: 'allDead' });
        else if (alive.length === 1) endGame(room, { winner: alive[0], endReason: 'destroyed' });
    }
}

const wss = new WebSocket.Server({ server: server });

// --- Исправление критической ошибки ---
// В исходном коде отсутствовала функция applyAction, на которую ссылался обработчик сообщений.
// Также были пропущены логические операторы "||" в условиях проверок типов действий.
// Ниже восстановлена полная реализация этой функции.

function trySpawnInfantry(room, ownerRole) {
    if (room.mode !== 'ffa4') return null;
    const base = getFFABase(ownerRole, room.size);
    if (!base) return null;
    const free = [];
    for (let y = base.y0; y <= base.y1; y++) {
        for (let x = base.x0; x <= base.x1; x++) {
            if (room.map[y][x].terrain === 'river' && !room.map[y][x].bridge) continue;
            if (room.units.some(u => u.x === x && u.y === y && u.hp > 0)) continue;
            free.push({ x: x, y: y });
        }
    }
    if (free.length === 0) return null;
    const p = free[Math.floor(Math.random() * free.length)];
    const newUnit = {
        id: room.nextUnitId++,
        owner: ownerRole,
        x: p.x, y: p.y,
        dir: ffaFaceDir(ownerRole),
        hp: 2,
        acted: true,
        type: 'infantry',
        reloading: false
    };
    room.units.push(newUnit);
    return newUnit;
}

function applyAction(room, role, u, a) {
    try {
        if (a.action === 'move') {
            const dx = a.dx, dy = a.dy;
            if (!Number.isInteger(dx) || !Number.isInteger(dy)) return;
            if (dx === 0 && dy === 0) return;
            const maxSteps = u.type === 'cannon' ? 1 : 2;
            if (Math.abs(dx) > maxSteps || Math.abs(dy) > maxSteps) return;
            // Разрешаем движение по диагонали (условие изменено: разрешаем равенство модулей или нулевое значение одной из осей)
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
            u.x += dx; u.y += dy;
            u.acted = true;

        } else if (a.action === 'rotate') {
            if (!Number.isInteger(a.dir) || a.dir < 0 || a.dir > 7 || u.dir === a.dir) return;
            u.dir = a.dir;
            u.acted = true;

        } else if (a.action === 'shoot') {
            const t = room.units.find(o => o.id === a.targetId && o.owner !== role && o.hp > 0);
            if (!t || u.type === 'cannon') return;
            if (!canShootInfantry(room, u, t)) return;
            const p = hitChanceInfantry(room, u, t);
            const hit = Math.random() < p;
            let killed = false, killedType = null;
            if (hit) {
                t.hp -= 1;
                if (t.hp <= 0) {
                    killedType = t.type;
                    room.units = room.units.filter(o => o.id !== t.id);
                    killed = true;
                }
            }
            if (killed && killedType === 'infantry') trySpawnInfantry(room, role);
            u.acted = true;
            room.lastEvent = {
                kind: 'shot', by: role,
                from: { x: u.x, y: u.y }, to: { x: t.x, y: t.y },
                hit: hit, killed: killed, at: Date.now()
            };

        } else if (a.action === 'shootAt') {
            if (u.type === 'cannon') return;
            const x = a.x, y = a.y;
            if (!Number.isInteger(x) || !Number.isInteger(y)) return;
            if (!inside(room.size, x, y)) return;
            const shots = infantryShotCells(room, u);
            if (!shots.some(c => c.x === x && c.y === y)) return;
            const t = room.units.find(o => o.x === x && o.y === y && o.owner !== role && o.hp > 0);
            let hit = false, killed = false, killedType = null;
            if (t) {
                let p = hitChanceInfantry(room, u, t) * 0.75;
                p = Math.max(0.05, Math.min(0.95, p));
                hit = Math.random() < p;
                if (hit) {
                    t.hp -= 1;
                    if (t.hp <= 0) {
                        killedType = t.type;
                        room.units = room.units.filter(o => o.id !== t.id);
                        killed = true;
                    }
                }
            }
            if (killed && killedType === 'infantry') trySpawnInfantry(room, role);
            u.acted = true;
            room.lastEvent = {
                kind: 'shot', by: role,
                from: { x: u.x, y: u.y }, to: { x: x, y: y },
                hit: hit, killed: killed, blind: true, at: Date.now()
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
            let fx = a.x, fy = a.y;
            if (!hitExact) {
                const shifts = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                const sh = shifts[Math.floor(Math.random() * 4)];
                if (inside(room.size, fx + sh[0], fy + sh[1])) { fx += sh[0]; fy += sh[1]; }
            }
            const hurtIds = [], killedIds = [], killedTypes = {};
            const target = room.units.find(o => o.x === fx && o.y === fy && o.owner !== role && o.hp > 0);
            if (hitExact && target) {
                target.hp -= 2;
                hurtIds.push(target.id);
                if (target.hp <= 0) { killedIds.push(target.id); killedTypes[target.id] = target.type; }
            }
            const explosionCells = [];
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const ex = fx + dx, ey = fy + dy;
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
                        if (hurtIds.indexOf(v.id) === -1) hurtIds.push(v.id);
                        if (v.hp <= 0 && killedIds.indexOf(v.id) === -1) {
                            killedIds.push(v.id);
                            killedTypes[v.id] = v.type;
                        }
                    }
                }
            }
            room.units = room.units.filter(o => o.hp > 0);
            killedIds.forEach(id => {
                if (killedTypes[id] === 'infantry') trySpawnInfantry(room, role);
            });
            u.acted = true;
            u.reloading = true;
            room.lastEvent = {
                kind: 'shot', by: role,
                from: { x: u.x, y: u.y }, to: { x: fx, y: fy },
                hit: hitExact,
                killed: killedIds.length > 0,
                cannon: true,
                explosion: { x: fx, y: fy, cells: explosionCells, hitIds: hurtIds, killedIds: killedIds },
                at: Date.now()
            };
        }
    } catch (e) {
        console.error('applyAction error:', e, a);
        sendTo(room.players[role], { type: 'error', message: 'Ошибка действия' });
    }
}

function canShootInfantry(room, s, t) {
    return infantryShotCells(room, s).some(c => c.x === t.x && c.y === t.y);
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

wss.on('connection', ws => {
    ws.on('message', raw => {
        try {
            let msg;
            try { msg = JSON.parse(raw); } catch (e) { return; }

            if (msg.type === 'joinQueue') {
                const mode = msg.mode;
                if (!MODES[mode] || ws.roomId) return;
                const spec = MODES[mode];
                const password = (msg.password || '').trim();

                if (spec.passwordRequired && !password) {
                    sendTo(ws, { type: 'error', message: 'Для этого режима нужен пароль' });
                    return;
                }
                if (password && passwordIndex.has(password)) {
                    sendTo(ws, { type: 'error', message: 'Такой пароль уже занят, введите другой' });
                    return;
                }

                const waitingId = waitingRoomByMode[mode];
                if (waitingId) {
                    const r = rooms.get(waitingId);
                    const freeRole = r && !r.saved
                        ? r.roles.find(ro => !r.players[ro] && !r.passwords[ro])
                        : null;

                    if (r && !r.saved && freeRole) {
                        r.players[freeRole] = ws;
                        ws.roomId = r.id;
                        ws.role = freeRole;
                        r.passwords[freeRole] = password || null;
                        if (password) passwordIndex.set(password, { roomId: r.id, role: freeRole });
                        r.saved = r.roles.every(ro => r.passwords[ro]);
                        if (!r.saved) {
                            for (const ro of r.roles) {
                                if (r.passwords[ro] && r.players[ro]) {
                                    sendTo(r.players[ro], { type: 'warnPassword' });
                                }
                            }
                        }
                        const full = r.roles.every(ro => r.players[ro]);
                        if (full) {
                            refreshWaitingSlot(r);
                            checkEnd(r);
                            for (const ro of r.roles) {
                                sendTo(r.players[ro], { type: 'matched', role: ro, roomId: r.id, mode: mode });
                            }
                            broadcast(r);
                        } else {
                            refreshWaitingSlot(r);
                            sendTo(ws, { type: 'waiting' });
                        }
                        return;
                    } else {
                        waitingRoomByMode[mode] = null;
                    }
                }

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
                sendTo(ws, { type: 'waiting' });
                return;
            }

            if (msg.type === 'resumeByPassword') {
                const password = (msg.password || '').trim();
                if (!password) { sendTo(ws, { type: 'error', message: 'Введите пароль' }); return; }
                const entry = passwordIndex.get(password);
                if (!entry) { sendTo(ws, { type: 'error', message: 'Партия не найдена' }); return; }
                const room = rooms.get(entry.roomId);
                if (!room) {
                    clearPasswordIndexFor(entry.roomId);
                    sendTo(ws, { type: 'error', message: 'Партия закрыта' });
                    return;
                }
                if (room.phase === 'over') {
                    clearPasswordIndexFor(entry.roomId);
                    sendTo(ws, { type: 'error', message: 'Партия закончена' });
                    return;
                }
                if (room.players[entry.role]) {
                    sendTo(ws, { type: 'error', message: 'Эта сторона занята' });
                    return;
                }
                room.players[entry.role] = ws;
                ws.roomId = room.id;
                ws.role = entry.role;
                room.disconnectedRoles.delete(entry.role);
                refreshWaitingSlot(room);
                for (const ro of room.roles) {
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
                        refreshWaitingSlot(r);
                        if (Object.keys(r.players).filter(k => r.players[k]).length === 0 && !r.saved) {
                            deleteRoom(rid);
                        }
                    }
                }
                ws.roomId = null;
                ws.role = null;
                sendTo(ws, { type: 'queueCancelled' });
                return;
            }

            if (msg.type === 'surrender') {
                const room = rooms.get(ws.roomId);
                if (!room) { ws.roomId = null; ws.role = null; return; }
                const myRole = ws.role;

                room.roles.forEach(r => {
                    if (r === myRole) return;
                    const w = room.players[r];
                    if (w) sendTo(w, { type: 'playerSurrendered', role: myRole });
                });

                room.units = room.units.filter(u => u.owner !== myRole);
                room.defeatedRoles.add(myRole);

                if (room.passwords[myRole]) passwordIndex.delete(room.passwords[myRole]);
                delete room.passwords[myRole];
                delete room.players[myRole];

                const aliveRoles = room.roles.filter(r => room.units.some(u => u.owner === r && u.hp > 0));
                room.saved = aliveRoles.length > 0 && aliveRoles.every(r => !!room.passwords[r]);

                if (room.phase === 'battle' && room.turn === myRole) {
                    const nxt = nextAliveRole(room, myRole);
                    if (nxt) {
                        room.turn = nxt;
                        room.units.forEach(x => {
                            if (x.owner === nxt) { x.acted = false; x.reloading = false; }
                        });
                    }
                }

                checkEnd(room);
                refreshWaitingSlot(room);

                if (!room.saved && !room.roles.some(r => room.players[r])) deleteRoom(room.id);

                ws.roomId = null; ws.role = null;
                return;
            }

            if (msg.type === 'leave') {
                const room = rooms.get(ws.roomId);
                if (room) {
                    const myRole = ws.role;
                    room.roles.forEach(r => {
                        if (r === myRole) return;
                        const w = room.players[r];
                        if (w) sendTo(w, { type: 'playerLeft', role: myRole });
                    });
                    room.disconnectedRoles.add(myRole);
                    room.players[myRole] = null;
                    refreshWaitingSlot(room);
                    broadcast(room);
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
                if (units.length !== need) { sendTo(ws, { type: 'error', message: 'Нужно ' + need + ' бойцов' }); return; }
                const infList = units.filter(u => u.type === 'infantry');
                const canList = units.filter(u => u.type === 'cannon');
                if (infList.length !== room.spec.defender.infantry || canList.length !== room.spec.defender.cannons) {
                    sendTo(ws, { type: 'error', message: 'Неверное число' }); return;
                }
                const taken = new Set();
                const centerY = Math.floor(room.size / 2);
                for (const u of units) {
                    if (!inside(room.size, u.x, u.y)) { sendTo(ws, { type: 'error', message: 'Вне поля' }); return; }
                    if (u.y < 1 || u.y > centerY - 2) { sendTo(ws, { type: 'error', message: 'Вне зоны' }); return; }
                    const cell = room.map[u.y][u.x];
                    if (cell.terrain === 'river' && !cell.bridge) { sendTo(ws, { type: 'error', message: 'Река' }); return; }
                    const k = u.y + ',' + u.x;
                    if (taken.has(k)) { sendTo(ws, { type: 'error', message: 'Занято' }); return; }
                    taken.add(k);
                }
                room.units = room.units.filter(u => u.owner !== 'defender');
                units.forEach(u => room.units.push({
                    id: room.nextUnitId++, owner: 'defender',
                    x: u.x, y: u.y, dir: 4, hp: 2, acted: false,
                    type: u.type, reloading: false
                }));
                room.phase = 'battle';
                checkEnd(room);
                broadcast(room);
                return;
            }

            if (msg.type === 'action') {
                if (room.phase !== 'battle') return;
                if (room.turn !== role) { sendTo(ws, { type: 'error', message: 'Не ваш ход' }); return; }
                const u = room.units.find(x => x.id === msg.id && x.owner === role);
                if (!u || u.hp <= 0) { sendTo(ws, { type: 'error', message: 'Недоступен' }); return; }
                if (u.acted) { sendTo(ws, { type: 'error', message: 'Уже ходил' }); return; }
                if (u.reloading && (msg.action === 'shoot' || msg.action === 'shootCannon' || msg.action === 'shootAt')) {
                    sendTo(ws, { type: 'error', message: 'Перезарядка' }); return;
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
                room.drawProposed = null;

                if (room.mode === '10v20' && role === 'attacker' && room.spec.attackerTurnLimit) {
                    if ((room.movesCount.attacker || 0) >= room.spec.attackerTurnLimit) {
                        const defendersAlive = room.units.some(u => u.owner === 'defender' && u.hp > 0);
                        if (defendersAlive && room.phase === 'battle') {
                            endGame(room, { winner: 'defender', endReason: 'attackerTimeout' });
                        }
                    }
                }

                if (room.mode === 'capture' && room.spec.turnLimitPerSide) {
                    if (room.turnNumber >= room.spec.turnLimitPerSide * 2 && room.phase === 'battle') {
                        const t = calcTerritoryState(room);
                        const a = t[room.roles[0]].count;
                        const b = t[room.roles[1]].count;
                        if (a > b) endGame(room, { winner: room.roles[0], endReason: 'turnLimit' });
                        else if (b > a) endGame(room, { winner: room.roles[1], endReason: 'turnLimit' });
                        else endGame(room, { draw: true, endReason: 'turnLimit' });
                    }
                }

                if (room.mode === '15v15' && room.spec.drawLimit) {
                    const opp = getOpponent(room, role);
                    const my = room.movesCount[role] || 0;
                    const other = room.movesCount[opp] || 0;
                    if (my >= room.spec.drawLimit && other >= room.spec.drawLimit) {
                        endGame(room, { draw: true, endReason: 'drawLimit' });
                    }
                }

                if (room.phase === 'battle') {
                    const nxt = nextAliveRole(room, role);
                    if (nxt) {
                        room.turn = nxt;
                        room.units.forEach(x => {
                            if (x.owner === nxt) { x.acted = false; x.reloading = false; }
                        });
                        room.lastEvent = { kind: 'turnEnded', by: role, at: Date.now() };
                    } else {
                        checkEnd(room);
                    }
                }
                broadcast(room);
                return;
            }

            if (msg.type === 'proposeDraw') {
                if (room.phase !== 'battle') return;
                if (!room.spec.allowDraw) return;
                if (room.drawProposed) return;
                room.drawProposed = { by: role, accepts: [role] };
                broadcast(room);
                return;
            }
            if (msg.type === 'acceptDraw') {
                if (room.phase !== 'battle') return;
                if (!room.drawProposed) return;
                if (room.drawProposed.accepts.indexOf(role) !== -1) return;
                room.drawProposed.accepts.push(role);
                const alive = room.roles.filter(r => room.units.some(u => u.owner === r && u.hp > 0));
                if (alive.every(r => room.drawProposed.accepts.indexOf(r) !== -1)) {
                    endGame(room, { draw: true, endReason: 'agreement' });
                }
                broadcast(room);
                return;
            }
        } catch (e) {
            console.error('WS message error:', e);
            sendTo(ws, { type: 'error', message: 'Внутренняя ошибка' });
        }
    });

    ws.on('close', () => {
        try {
            const room = rooms.get(ws.roomId);
            if (room) {
                const myRole = ws.role;
                room.disconnectedRoles.add(myRole);
                room.players[myRole] = null;
                room.roles.forEach(r => {
                    if (r === myRole) return;
                    const w = room.players[r];
                    if (w) sendTo(w, { type: 'playerLeft', role: myRole });
                });
                refreshWaitingSlot(room);
                broadcast(room);
                const anyConnected = room.roles.some(r => room.players[r]);
                if (!room.saved && !anyConnected) deleteRoom(room.id);
            }
        } catch (e) {
            console.error('close handler error:', e);
        }
        ws.roomId = null;
        ws.role = null;
    });
});

server.listen(PORT,'0.0.0.0', () => console.log('Сервер запущен на порту ' + PORT));

