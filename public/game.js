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

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

if (window.Telegram && window.Telegram.WebApp) {
    try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
    } catch (e) {}
}

function showScreen(id) {
    ['lobby', 'rules', 'waitingScreen', 'gameScreen'].forEach(s => {
        document.getElementById(s).classList.toggle('hidden', s !== id);
    });
}

function showRules() { showScreen('rules'); }
function hideRules() { showScreen('lobby'); }

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

let lastShotEventAt = 0;
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

        setupUnits.forEach(u => drawUnit(u.x, u.y, isDef ? 4 : 0, isDef ? '#4a8' : '#c44', false, false, 2));
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
        case 'river':
            ctx.fillStyle = c.bridge ? '#8b6b3a' : '#3a6ea5';
            break;
        case 'hill':
            ctx.fillStyle = '#7a6a4a';
            break;
        case 'forest':
            ctx.fillStyle = '#2e5a2e';
            break;
        default:
            ctx.fillStyle = '#4a6a4a';
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

    const v = [
        [0,-1],[1,-1],[1,0],[1,1],
        [0,1],[-1,1],[-1,0],[-1,-1]
    ][dir];
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

function getMoveCells(u) {
    const dirs = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    const out = [];
    for (const [dx, dy] of dirs) {
        const nx = u.x + dx, ny = u.y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        const c = MAP[ny][nx];
        if (!c || c.terrain === 'unknown') continue;
        if (c.terrain === 'river' && !c.bridge) continue;
        if (state.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) continue;
        out.push({ x: nx, y: ny });
    }
    return out;
}

const DIR_VECS = [
    { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
    { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 }
];

function viewLineDirs(dir) {
    return [(dir + 7) % 8, dir, (dir + 1) % 8];
}

function getShotCells(u) {
    const onHill = MAP[u.y][u.x].terrain === 'hill';
    const range = SHOOT_RANGE + (onHill ? 2 : 0);
    const dirs = viewLineDirs(u.dir);
    const out = [];
    for (const d of dirs) {
        const v = DIR_VECS[d];
        for (let k = 1; k <= range; k++) {
            const nx = u.x + v.dx * k, ny = u.y + v.dy * k;
            if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) break;
            out.push({ x: nx, y: ny });
            if (!onHill) {
                const c = MAP[ny][nx];
                if (c && (c.terrain === 'forest' || c.terrain === 'hill')) break;
            }
        }
    }
    return out;
}

function updateTopBar() {
    const dot = document.getElementById('turnDot');
    const info = document.getElementById('turnInfo');
    if (!state) return;
    if (state.phase === 'setup') {
        dot.className = myRole === 'defender' ? 'blue' : 'red';
        info.textContent = 'Расстановка: ' + (myRole === 'defender' ? 'Защитник' : 'Атакующий');
    } else if (state.phase === 'battle') {
        dot.className = state.turn === 'defender' ? 'blue' : 'red';
        info.textContent = 'Ход ' + (state.turn === 'defender' ? 'защитника' : 'атакующего');
    } else if (state.phase === 'over') {
        dot.className = state.winner === 'defender' ? 'blue' : 'red';
        info.textContent = state.winner === myRole ? '🏆 Победа!' : '💀 Поражение';
    }
}

function updateBottomPanel() {
    const stats = document.getElementById('stats');
    const actions = document.getElementById('actionRow');
    const dirs = document.getElementById('dirRow');
    actions.innerHTML = '';
    dirs.innerHTML = '';
    if (!state) return;

    if (state.phase === 'setup') {
        const isDef = myRole === 'defender';
        const spec = state.mode === '10v20' ? { defender: 10, attacker: 20 } : { defender: 15, attacker: 30 };
        const need = isDef ? spec.defender : spec.attacker;
        stats.textContent = 'Поставлено: ' + setupUnits.length + '/' + need + ' бойцов';
        addBtn(actions, '🎲 Авто-расстановка', autoSetup);
        addBtn(actions, 'Очистить', () => { setupUnits = []; render(); });
        const ready = setupUnits.length === need;
        const b = addBtn(actions, '✅ Готов', commitSetup, 'primary');
        b.disabled = !ready;
        return;
    }

    if (state.phase === 'battle') {
        const mine = state.units.filter(u => u.owner === myRole);
        const notMoved = mine.filter(u => !u.acted).length;
        stats.textContent = 'Моих бойцов: ' + mine.length + ' · Ещё не сходили: ' + notMoved + ' · Всего на поле: ' + state.units.length;

        if (state.turn !== myRole) {
            const b = addBtn(actions, '⏳ Ожидание соперника', null);
            b.disabled = true;
            return;
        }

        addBtn(actions, '👥 Выделить всех не ходивших', () => {
            selected.clear();
            mine.forEach(u => { if (!u.acted) selected.add(u.id); });
            render();
        });
        addBtn(actions, '✖ Снять выделение', () => {
            selected.clear();
            pendingShotCell = null;
            blindMode = false;
            render();
        });
    }
}
