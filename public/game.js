Ниже представлены три полностью отформатированных фрагмента кода. Логика, названия переменных и структура алгоритмов сохранены без изменений.

1. Клиентский код (game.js)

const SIZE = 20;
const SHOOT_RANGE = 6;
const VIEW_RANGE = 9;
let CELL = 36;
let MAP = null;
let ws = null;
let state = null;
let myRole = null;
let selected = new Set();
let blindMode = false;
let pendingShotCell = null;
let dragStart = null, dragEnd = null;
let setupUnits = [];
let lastShotEventAt = 0;
let toastTimer = null;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

if (window.Telegram && window.Telegram.WebApp) {
    try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        if (window.Telegram.WebApp.disableVerticalSwipes) {
            window.Telegram.WebApp.disableVerticalSwipes();
        }
    } catch (e) {}
}

function showScreen(id) {
    ['lobby', 'rules', 'waitingScreen', 'gameScreen'].forEach(s => {
        const el = document.getElementById(s);
        if (el) el.classList.toggle('hidden', s !== id);
    });
}

function showRules() { 
    showScreen('rules'); 
}

function hideRules() { 
    showScreen('lobby'); 
}

function joinQueue(mode) {
    if (!ws) connectWS();
    ws._pendingMode = mode;
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'joinQueue', mode }));
    }
    showScreen('waitingScreen');
}

function cancelQueue() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancelQueue' }));
    showScreen('lobby');
}

function leaveGame() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
    state = null;
    selected.clear();
    setupUnits = [];
    pendingShotCell = null;
    blindMode = false;
    showScreen('lobby');
}

function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host);
    ws.onopen = () => {
        if (ws._pendingMode) {
            ws.send(JSON.stringify({ type: 'joinQueue', mode: ws._pendingMode }));
            ws._pendingMode = null;
        }
    };
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'matched') {
            myRole = msg.role;
            showScreen('gameScreen');
            setTimeout(resizeCanvas, 50);
        } else if (msg.type === 'waiting') {
            showScreen('waitingScreen');
        } else if (msg.type === 'queueCancelled') {
            showScreen('lobby');
        } else if (msg.type === 'state') {
            state = msg.state;
            onStateUpdate();
        } else if (msg.type === 'opponentLeft') {
            showToast('Соперник вышел из партии');
            setTimeout(leaveGame, 1500);
        } else if (msg.type === 'error') {
            showToast(msg.message);
        }
    };
}

function onStateUpdate() {
    if (!state) return;
    resizeCanvas();

    if (state.lastEvent && state.lastEvent.kind === 'shot' && state.lastEvent.by === myRole) {
        if (state.lastEvent.at !== lastShotEventAt) {
            lastShotEventAt = state.lastEvent.at;
            if (!state.lastEvent.hit) showToast('Вы не попали');
            else if (state.lastEvent.killed) showToast('Вы убили');
            else showToast('Вы ранили');
        }
    }

    if (state.phase === 'battle' && setupUnits.length > 0) {
        setupUnits = [];
    }

    render();
}

function resizeCanvas() {
    const wrap = document.getElementById('boardWrap');
    if (!wrap) return;
    const w = wrap.clientWidth - 8;
    const h = wrap.clientHeight - 8;
    const size = Math.min(w, h);
    if (size <= 0) return;
    CELL = Math.floor(size / SIZE);
    canvas.width = CELL * SIZE;
    canvas.height = CELL * SIZE;
}

function render() {
    if (!state || !state.map) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    MAP = state.map;

    for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
            drawTerrain(x, y, MAP[y][x]);
        }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= SIZE; i++) {
        ctx.beginPath();
        ctx.moveTo(i * CELL, 0);
        ctx.lineTo(i * CELL, canvas.height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * CELL);
        ctx.lineTo(canvas.width, i * CELL);
        ctx.stroke();
    }

    if (state.phase === 'setup') {
        const isDef = myRole === 'defender';
        const z = isDef ? [0, 6] : [13, SIZE - 1];
        ctx.fillStyle = 'rgba(100,200,100,0.12)';
        ctx.fillRect(0, z[0] * CELL, canvas.width, (z[1] - z[0] + 1) * CELL);
        ctx.strokeStyle = 'rgba(100,200,100,0.5)';
        ctx.strokeRect(0, z[0] * CELL, canvas.width, (z[1] - z[0] + 1) * CELL);

        const color = isDef ? '#4a8' : '#c44';
        // уже отправленная расстановка (если myReady)
        state.units.filter(u => u.owner === myRole).forEach(u => {
            drawUnit(u.x, u.y, u.dir, color, false, false, u.hp);
        });
        // текущая локальная расстановка (пока не нажал Готов)
        if (!state.myReady) {
            setupUnits.forEach(u => {
                drawUnit(u.x, u.y, isDef ? 4 : 0, color, false, false, 2);
            });
        }
    }

    if (state.phase !== 'setup') {
        state.units.forEach(u => {
            const isMine = u.owner === myRole;
            const baseColor = u.owner === 'defender' ? '#4a8' : '#c44';
            drawUnit(u.x, u.y, u.dir, baseColor, selected.has(u.id), !isMine, u.hp);
        });
    }

    if (state.phase === 'battle' && selected.size === 1) {
        const u = state.units.find(x => selected.has(x.id));
        if (u && u.owner === myRole) highlightUnit(u);
    }

    if (dragStart && dragEnd) {
        const x1 = Math.min(dragStart.x, dragEnd.x) * CELL;
        const y1 = Math.min(dragStart.y, dragEnd.y) * CELL;
        const x2 = Math.max(dragStart.x, dragEnd.x) * CELL;
        const y2 = Math.max(dragStart.y, dragEnd.y) * CELL;
        ctx.strokeStyle = '#4a8';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    updateTopBar();
    updateBottomPanel();
}

function drawTerrain(x, y, c) {
    const px = x * CELL, py = y * CELL;
    if (c.terrain === 'unknown') {
        ctx.fillStyle = '#0a0a0f';
        ctx.fillRect(px, py, CELL, CELL);
        return;
    }
    switch (c.terrain) {
        case 'river': ctx.fillStyle = c.bridge ? '#8b6b3a' : '#3a6ea5'; break;
        case 'hill': ctx.fillStyle = '#7a6a4a'; break;
        case 'forest': ctx.fillStyle = '#2e5a2e'; break;
        default: ctx.fillStyle = '#4a6a4a';
    }
    ctx.fillRect(px, py, CELL, CELL);

    if (c.bridge) {
        ctx.strokeStyle = '#3a2410';
        ctx.lineWidth = Math.max(2, CELL * 0.08);
        ctx.beginPath();
        ctx.moveTo(px, py + CELL * 0.15);
        ctx.lineTo(px + CELL, py + CELL * 0.15);
        ctx.moveTo(px, py + CELL * 0.85);
        ctx.lineTo(px + CELL, py + CELL * 0.85);
        ctx.stroke();
    }
    if (c.terrain === 'forest') {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.arc(px + CELL * 0.25 + i * CELL * 0.25, py + CELL * 0.4 + (i % 2) * CELL * 0.25, CELL * 0.13, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    if (c.terrain === 'hill') {
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        ctx.moveTo(px + CELL * 0.1, py + CELL * 0.75);
        ctx.quadraticCurveTo(px + CELL * 0.25, py + CELL * 0.35, px + CELL * 0.4, py + CELL * 0.6);
        ctx.quadraticCurveTo(px + CELL * 0.55, py + CELL * 0.25, px + CELL * 0.7, py + CELL * 0.55);
        ctx.quadraticCurveTo(px + CELL * 0.85, py + CELL * 0.4, px + CELL * 0.9, py + CELL * 0.75);
        ctx.closePath();
        ctx.fill();
    }
}

function drawUnit(x, y, dir, color, isSel, dim, hp) {
    const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
    ctx.globalAlpha = dim ? 0.7 : 1;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(px, py, CELL * 0.34, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = isSel ? '#ff0' : '#000';
    ctx.lineWidth = isSel ? 3 : 1.5;
    ctx.stroke();

    ctx.fillStyle = '#000';
    const dotR = CELL * 0.08;
    if (hp === 2) {
        ctx.beginPath(); ctx.arc(px - CELL * 0.09, py, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px + CELL * 0.09, py, dotR, 0, Math.PI * 2); ctx.fill();
    } else if (hp === 1) {
        ctx.beginPath(); ctx.arc(px, py, dotR, 0, Math.PI * 2); ctx.fill();
    }

    const v = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]][dir];
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + v[0] * CELL * 0.22, py + v[1] * CELL * 0.22);
    ctx.lineTo(px + v[0] * CELL * 0.42, py + v[1] * CELL * 0.42);
    ctx.stroke();
    ctx.globalAlpha = 1;
}

function highlightUnit(u) {
    const moves = getMoveCells(u);
    ctx.fillStyle = 'rgba(120,255,120,0.35)';
    moves.forEach(c => ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL));
    const shots = getShotCells(u);
    ctx.fillStyle = 'rgba(180,180,180,0.22)';
    shots.forEach(c => {
        if (!moves.some(m => m.x === c.x && m.y === c.y)) {
            ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
        }
    });
    if (pendingShotCell) {
        ctx.strokeStyle = '#f0a020';
        ctx.lineWidth = 3;
        ctx.strokeRect(pendingShotCell.x * CELL + 1.5, pendingShotCell.y * CELL + 1.5, CELL - 3, CELL - 3);
    }
}

// Внимание: функция ниже восстановлена до рабочего состояния на основе контекста вашего первого сообщения
function getMoveCells(u) {
    const dirs = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    const out = [];
    for (const [dx, dy] of dirs) {
        const nx = u.x + dx, ny = u.y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const cell = state.map[ny][nx];
        if (cell.terrain === 'river' && !cell.bridge) continue;
        if (state.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) continue;
        out.push({ x: nx, y: ny });
    }
    return out;
}

2. Серверный код (server.js — часть с инициализацией и генерацией карты)

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
            const nx = unit.x + v.dx * k, ny = unit.y + v.dy * k;
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
        mode, spec, roles,
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
        size: SIZE,
        map: mapOut,
        units,
        role,
        lastEvent: room.lastEvent,
        myReady: !!room.ready[role],
        opponentReady: !!room.ready[role === 'defender' ? 'attacker' : 'defender']
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
    if (d === 0) { room.phase = 'over'; room.winner = 'attacker'; }
    else if (a === 0) { room.phase = 'over'; room.winner = 'defender'; }
}

3. Серверный код (server.js — обработчики WS и логика боя)

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
                for (const r of ['defender', 'attacker']) {
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

        if (msg.type === 'setup') {
            if (room.phase !== 'setup') return;
            if (room.ready[role]) { sendTo(ws, { type: 'error', message: 'Вы уже готовы' }); return; }

            const isDef = role === 'defender';
            const need = isDef ? room.spec.defender : room.spec.attacker;
            const zone = isDef ? [0, 6] : [13, SIZE - 1];
            const units = msg.units || [];

            if (units.length !== need) {
                sendTo(ws, { type: 'error', message: 'Нужно ' + need + ' бойцов, отправлено ' + units.length });
                return;
            }

            const taken = new Set();
            for (const u of units) {
                if (!inside(u.x, u.y)) { sendTo(ws, { type: 'error', message: 'Боец вне поля' }); return; }
                if (u.y < zone[0] || u.y > zone[1]) { sendTo(ws, { type: 'error', message: 'Боец вне зоны расстановки' }); return; }
                const cell = room.map[u.y][u.x];
                if (cell.terrain === 'river' && !cell.bridge) { sendTo(ws, { type: 'error', message: 'Боец на реке' }); return; }
                const k = u.y + ',' + u.x;
                if (taken.has(k)) { sendTo(ws, { type: 'error', message: 'Два бойца на одной клетке' }); return; }
                taken.add(k);
            }

            room.units = room.units.filter(u => u.owner !== role);
            units.forEach(u => {
                room.units.push({
                    id: nextUnitId++, owner: role, x: u.x, y: u.y,
                    dir: isDef ? 4 : 0, hp: 2, acted: false
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
        const nx = u.x + a.dx, ny = u.y + a.dy;
        if (!inside(nx, ny)) return;
        const cell = room.map[ny][nx];
        if (cell.terrain === 'river' && !cell.bridge) return;
        if (room.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) return;
        u.x = nx; u.y = ny; u.acted = true;
    } else if (a.action === 'rotate') {
        if (a.dir < 0 || a.dir > 7) return;
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
    const cells = lineCells(room, s, maxR, onHill);
    if (!cells.some(c => c.x === t.x && c.y === t.y)) return false;
    if (onHill) return true;
    for (const d of viewLineDirs(s.dir)) {
        const v = DIR_VECS[d];
        for (let k = 1; k <= maxR; k++) {
            const nx = s.x + v.dx * k, ny = s.y + v.dy * k;
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
