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

function getMoveCells(u) {
    const dirs = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    const out = [];
    const map = state ? state.map : MAP;
    if (!map) return out;

    for (const [dx, dy] of dirs) {
        const nx = u.x + dx, ny = u.y + dy;
        if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
        
        const cell = map[ny][nx];
        if (!cell || cell.terrain === 'unknown') continue;
        if (cell.terrain === 'river' && !cell.bridge) continue;
        if (state.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) continue;
        
        out.push({ x: nx, y: ny });
    }
    return out;
}

const DIR_VECS = [
    { dx: 0, dy: -1 }, { dx: 1, dy: -1 }, { dx: 1, dy: 0 }, { dx: 1, dy: 1 },
    { dx: 0, dy: 1 }, { dx: -1, dy: 1 }, { dx: -1, dy: 0 }, { dx: -1, dy: -1 }
];

function viewLineDirs(dir) { return [(dir + 7) % 8, dir, (dir + 1) % 8]; }

function getShotCells(u) {
    const onHill = (state ? state.map[u.y][u.x].terrain : MAP[u.y][u.x].terrain) === 'hill';
    const range = SHOOT_RANGE + (onHill ? 2 : 0);
    const dirs = viewLineDirs(u.dir);
    const out = [];
    const map = state ? state.map : MAP;
    if (!map) return out;

    for (const d of dirs) {
        const v = DIR_VECS[d];
        for (let k = 1; k <= range; k++) {
            const nx = u.x + v.dx * k, ny = u.y + v.dy * k;
            if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) break;
            
            out.push({ x: nx, y: ny });
            
            if (!onHill) {
                const c = map[ny][nx];
                if (c && (c.terrain === 'forest' || c.terrain === 'hill')) break;
            }
        }
    }
    return out;
}

function updateTopBar() {
    const dot = document.getElementById('turnDot');
    const info = document.getElementById('turnInfo');
    if (!dot || !info) return;
    
    if (!state) {
        dot.className = '';
        info.textContent = '';
        return;
    }

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
    if (!stats || !actions || !dirs) return;

    actions.innerHTML = '';
    dirs.innerHTML = '';
    if (!state) return;

    if (state.phase === 'setup') {
        const isDef = myRole === 'defender';
        const spec = state.mode === '10v20' ? { defender: 10, attacker: 20 } : { defender: 15, attacker: 30 };
        const need = isDef ? spec.defender : spec.attacker;

        if (state.myReady) {
            stats.innerHTML = '<b style="color:#4a8">✅ Вы готовы.</b> Ожидание соперника…';
            addBtn(actions, '⏳ Ожидание соперника', null, 'waitingBtn').disabled = true;
            return;
        }

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
            addBtn(actions, '⏳ Ожидание соперника', null, 'waitingBtn').disabled = true;
            return;
        }

        addBtn(actions, '👥 Выделить всех не ходивших', () => {
            selected.clear();
            mine.forEach(u => { if (!u.acted) selected.add(u.id); });
            render();
        });
        addBtn(actions, '✖ Снять выделение', () => { selected.clear(); pendingShotCell = null; blindMode = false; render(); });

        const lbl = document.createElement('div');
        lbl.style.width = '100%';
        lbl.style.fontSize = '12px';
        lbl.style.color = '#aaa';
        lbl.textContent = 'Повернуть:';
        dirs.appendChild(lbl);
        ['↖','↑','↗','→','↘','↓','↙','←'].forEach(s => {
            const mapD = { '↑':0, '↗':1, '→':2, '↘':3, '↓':4, '↙':5, '←':6, '↖':7 };
            addBtn(dirs, s, () => rotateSelected(mapD[s]), 'arrowBtn');
        });

        if (selected.size === 1) {
            addBtn(actions, blindMode ? '🎯 Клик по клетке…' : '🎯 Выстрел вслепую', () => {
                blindMode = !blindMode;
                pendingShotCell = null;
                render();
            }, blindMode ? 'primary' : '');
        }

        addBtn(actions, '✅ Завершить ход', () => {
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endTurn'}));
            selected.clear();
            pendingShotCell = null;
            blindMode = false;
        }, 'primary');
    }

    if (state.phase === 'over') {
        addBtn(actions, '🔄 В лобби', () => leaveGame(), 'primary');
    }
}

function addBtn(parent, text, fn, cls) {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    if (fn) b.onclick = fn;
    parent.appendChild(b);
    return b;
}

function autoSetup() {
    const isDef = myRole === 'defender';
    const spec = state.mode === '10v20' ? { defender: 10, attacker: 20 } : { defender: 15, attacker: 30 };
    const need = isDef ? spec.defender : spec.attacker;
    const zone = isDef ? [0, 6] : [13, SIZE - 1];
    const taken = new Set();
    setupUnits = [];
    let attempts = 0;
    while (setupUnits.length < need && attempts < 3000) {
        attempts++;
        const y = zone[0] + Math.floor(Math.random() * (zone[1] - zone[0] + 1));
        const x = Math.floor(Math.random() * SIZE);
        const cell = MAP[y][x];
        if (!cell || cell.terrain === 'unknown') continue;
        if (cell.terrain === 'river' && !cell.bridge) continue;
        const k = y + ',' + x;
        if (taken.has(k)) continue;
        taken.add(k);
        setupUnits.push({ x, y });
    }
    render();
}

function commitSetup() {
    if (!ws || ws.readyState !== WebSocket.OPEN) { showToast('Нет соединения'); return; }
    const isDef = myRole === 'defender';
    const spec = state.mode === '10v20' ? { defender: 10, attacker: 20 } : { defender: 15, attacker: 30 };
    const need = isDef ? spec.defender : spec.attacker;
    if (setupUnits.length !== need) { showToast('Поставьте всех бойцов'); return; }
    ws.send(JSON.stringify({ type: 'setup', units: setupUnits }));
}

function rotateSelected(dir) {
    if (!state || state.turn !== myRole) return;
    if (selected.size === 0) { showToast('Выберите бойца'); return; }
    selected.forEach(id => {
        const u = state.units.find(x => x.id === id);
        if (u && !u.acted) {
            ws.send(JSON.stringify({ type: 'action', action: 'rotate', id, dir }));
        }
    });
    render();
}

function cellFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    let cx, cy;
    if (e.touches && e.touches[0]) {
        cx = e.touches[0].clientX - r.left; cy = e.touches[0].clientY - r.top;
    } else if (e.changedTouches && e.changedTouches[0]) {
        cx = e.changedTouches[0].clientX - r.left; cy = e.changedTouches[0].clientY - r.top;
    } else {
        cx = e.clientX - r.left; cy = e.clientY - r.top;
    }
    return { x: Math.floor(cx / CELL), y: Math.floor(cy / CELL) };
}

canvas.addEventListener('mousedown', (e) => {
    if (!state || state.phase !== 'battle') return;
    dragStart = cellFromEvent(e); dragEnd = null;
});
canvas.addEventListener('mousemove', (e) => {
    if (dragStart) { dragEnd = cellFromEvent(e); render(); }
});
canvas.addEventListener('mouseup', (e) => handlePointerUp(e));

canvas.addEventListener('touchstart', (e) => {
    if (!state || state.phase !== 'battle') return;
    dragStart = cellFromEvent(e); dragEnd = null;
}, { passive: true });
canvas.addEventListener('touchmove', (e) => {
    if (dragStart) { dragEnd = cellFromEvent(e); render(); }
}, { passive: true });
canvas.addEventListener('touchend', (e) => handlePointerUp(e), { passive: true });

function handlePointerUp(e) {
    const c = cellFromEvent(e);
    const isDrag = dragStart && (Math.abs(c.x - dragStart.x) > 1 || Math.abs(c.y - dragStart.y) > 1);
    if (isDrag && state && state.phase === 'battle') {
        const x1 = Math.min(dragStart.x, c.x), y1 = Math.min(dragStart.y, c.y);
        const x2 = Math.max(dragStart.x, c.x), y2 = Math.max(dragStart.y, c.y);
        const inRect = state.units.filter(u =>
            u.owner === myRole && !u.acted &&
            u.x >= x1 && u.x <= x2 && u.y >= y1 && u.y <= y2
        );
        const multi = !!(e.ctrlKey || e.shiftKey);
        if (!multi) selected.clear();
        inRect.forEach(u => selected.add(u.id));
        dragStart = dragEnd = null;
        render();
        return;
    }
    dragStart = dragEnd = null;
    handleClick(c, !!(e.ctrlKey || e.shiftKey));
}

function handleClick(c, multi) {
    if (!state) return;

    if (state.phase === 'setup') {
        if (state.myReady) return;
        const isDef = myRole === 'defender';
        const spec = state.mode === '10v20' ? { defender: 10, attacker: 20 } : { defender: 15, attacker: 30 };
        const need = isDef ? spec.defender : spec.attacker;
        const zone = isDef ? [0, 6] : [13, SIZE - 1];
        if (c.y < zone[0] || c.y > zone[1]) return;
        if (setupUnits.length >= need) {
            const idx0 = setupUnits.findIndex(u => u.x === c.x && u.y === c.y);
            if (idx0 < 0) return;
        }
        const cell = MAP[c.y] && MAP[c.y][c.x];
        if (!cell || cell.terrain === 'unknown') return;
        if (cell.terrain === 'river' && !cell.bridge) return;
        const idx = setupUnits.findIndex(u => u.x === c.x && u.y === c.y);
        if (idx >= 0) { setupUnits.splice(idx, 1); render(); return; }
        setupUnits.push({ x: c.x, y: c.y });
        render();
        return;
    }

    if (state.phase !== 'battle' || state.turn !== myRole) return;

    const clicked = state.units.find(u => u.x === c.x && u.y === c.y);

    if (clicked && clicked.owner === myRole) {
        if (multi) {
            if (selected.has(clicked.id)) selected.delete(clicked.id);
            else selected.add(clicked.id);
        } else {
            if (!(selected.size === 1 && selected.has(clicked.id))) {
                selected.clear();
                selected.add(clicked.id);
            }
        }
        pendingShotCell = null;
        blindMode = false;
        render();
        return;
    }

    if (selected.size === 1) {
        const u = state.units.find(x => selected.has(x.id));
        if (!u || u.acted) return;
        if (blindMode) {
            const shots = getShotCells(u);
            if (shots.some(s => s.x === c.x && s.y === c.y)) {
                ws.send(JSON.stringify({ type: 'action', action: 'shootAt', id: u.id, x: c.x, y: c.y }));
                blindMode = false;
                selected.delete(u.id);
            }
            return;
        }
        if (clicked && clicked.owner !== myRole) {
            if (pendingShotCell && pendingShotCell.x === c.x && pendingShotCell.y === c.y) {
                ws.send(JSON.stringify({ type: 'action', action: 'shoot', id: u.id, targetId: clicked.id }));
                pendingShotCell = null;
                selected.delete(u.id);
                render();
                return;
            }
            pendingShotCell = { x: c.x, y: c.y };
            render();
            return;
        }
        const moves = getMoveCells(u);
        if (moves.some(m => m.x === c.x && m.y === c.y)) {
            const dx = c.x - u.x, dy = c.y - u.y;
            ws.send(JSON.stringify({ type: 'action', action: 'move', id: u.id, dx, dy }));
            selected.delete(u.id);
            render();
            return;
        }
        selected.clear();
        pendingShotCell = null;
        render();
        return;
    }

    if (selected.size > 0) {
        selected.clear();
        pendingShotCell = null;
        render();
    }
}

document.addEventListener('keydown', (e) => {
    if (!state || state.phase !== 'battle' || state.turn !== myRole) return;
    const keyMap = { 'ArrowUp': 0, 'ArrowRight': 2, 'ArrowDown': 4, 'ArrowLeft': 6 };
    if (e.key in keyMap) {
        rotateSelected(keyMap[e.key]);
        e.preventDefault();
    } else if (e.key === 'Enter') {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endTurn' }));
        selected.clear();
        pendingShotCell = null;
    } else if (e.key === 'Escape') {
        selected.clear();
        pendingShotCell = null;
        blindMode = false;
        render();
    }
});

function toggleHint() {
    const el = document.getElementById('hintPopup');
    const content = document.getElementById('hintContent');
    if (el.classList.contains('show')) { el.classList.remove('show'); return; }
    if (!state) return;
    let html = '';
    if (state.phase === 'battle') {
        if (state.turn === 'defender') {
            html = '<b>Ход защитника (синие)</b><br>Защитник знает всю карту. Бойцы на холме видят и стреляют сквозь препятствия.';
        } else {
            html = '<b>Ход атакующего (красные)</b><br>Атакующий видит только обзор своих бойцов. Лес скрывает врагов.';
        }
        html += '<br><br><b>Что делать:</b><br>' +
            '• Клик по своему бойцу — выделить.<br>' +
            '• Ctrl+клик — добавить в группу.<br>' +
            '• Клик рядом — шаг. Кнопки-стрелки поворачивают.<br>' +
            '• Клик по врагу — выбор цели, ещё раз — выстрел.<br>' +
            '• «Выстрел вслепую» — потом клик по клетке.<br>' +
            '• «Завершить ход» — передать ход.';
    } else if (state.phase === 'setup') {
        html = '<b>Расстановка</b><br>' +
            (myRole === 'defender'
                ? 'Защитник (синие). Видит всю карту.'
                : 'Атакующий (красные). Видит только свою зону.') +
            '<br><br>Кликай по зелёной зоне, чтобы ставить бойцов. Когда все поставлены — жми «Готов».';
    }
    content.innerHTML = html;
    el.classList.add('show');
}

function showToast(text) {
    const t = document.getElementById('toast');
    const tt = document.getElementById('toastText');
    if (!t) return;
    if (tt) tt.textContent = text;
    else t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 3500);
}

function hideToast() {
    const t = document.getElementById('toast');
    if (t) t.classList.remove('show');
}

window.addEventListener('resize', () => {
    if (state) { resizeCanvas(); render(); }
});
window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (state) { resizeCanvas(); render(); } }, 200);
});
