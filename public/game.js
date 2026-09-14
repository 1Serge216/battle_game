const SIZE = 20;
const SHOOT_RANGE = 6;
const VIEW_RANGE = 9;
let CELL = 36;
let MAP = null;
let ws = null;
let state = null;
let myRole = null;
let selected = new Set();
let aimMode = false;
let confirmEndArmed = false;
let dragStart = null, dragEnd = null;
let lastShotEventAt = 0;
let toastTimer = null;
let shotToastTimer = null;
let animation = null;

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');

if (window.Telegram && window.Telegram.WebApp) {
    try {
        window.Telegram.WebApp.ready();
        window.Telegram.WebApp.expand();
        if (window.Telegram.WebApp.disableVerticalSwipes) window.Telegram.WebApp.disableVerticalSwipes();
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
    state = null; selected.clear(); aimMode = false;
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
            showToast('Соперник вышел из партии', 'info');
            setTimeout(leaveGame, 1500);
        } else if (msg.type === 'error') {
            showToast(msg.message, 'error');
        }
    };
}

function onStateUpdate() {
    if (!state) return;
    resizeCanvas();
    if (state.lastEvent && state.lastEvent.kind === 'shot' && state.lastEvent.by === myRole) {
        if (state.lastEvent.at !== lastShotEventAt) {
            lastShotEventAt = state.lastEvent.at;
            playShotAnimation(state.lastEvent);
            const e = state.lastEvent;
            let msg = '';
            if (e.blind) {
                if (!e.hit) msg = 'Выстрел вслепую. Мимо.';
                else if (e.killed) msg = 'Выстрел вслепую. Убит!';
                else msg = 'Выстрел вслепую. Ранен.';
            } else {
                if (!e.hit) msg = 'Вы промахнулись';
                else if (e.killed) msg = 'Вы убили!';
                else msg = 'Вы ранили';
            }
            const kind = !e.hit ? 'miss' : (e.killed ? 'killed' : 'hit');
            showShotToast(msg, kind);
        }
    }
    render();
}

function playShotAnimation(ev) {
    animation = {
        fx: ev.from.x, fy: ev.from.y,
        tx: ev.to.x, ty: ev.to.y,
        start: performance.now(),
        duration: 350
    };
    animateShot();
}

function animateShot() {
    if (!animation) return;
    const t = (performance.now() - animation.start) / animation.duration;
    if (t >= 1) { animation = null; render(); return; }
    render();
    requestAnimationFrame(animateShot);
}

function resizeCanvas() {
    const wrap = document.getElementById('boardWrap');
    if (!wrap) return;
    const w = wrap.clientWidth - 16;
    const h = wrap.clientHeight - 16;
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
        for (let x = 0; x < SIZE; x++) drawTerrain(x, y, MAP[y][x]);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i <= SIZE; i++) {
        ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(canvas.width, i * CELL); ctx.stroke();
    }

    if (selected.size === 1) {
        const u = state.units.find(x => selected.has(x.id));
        if (u && u.owner === myRole) highlightUnit(u);
    }

    state.units.forEach(u => {
        const isMine = u.owner === myRole;
        const baseColor = isMine ? '#4a80d0' : '#c44';
        const dim = !isMine && state.turn === myRole;
        drawUnit(u.x, u.y, u.dir, baseColor, selected.has(u.id), dim, u.hp);
    });

    if (dragStart && dragEnd) {
        const x1 = Math.min(dragStart.x, dragEnd.x) * CELL;
        const y1 = Math.min(dragStart.y, dragEnd.y) * CELL;
        const x2 = Math.max(dragStart.x, dragEnd.x) * CELL;
        const y2 = Math.max(dragStart.y, dragEnd.y) * CELL;
        ctx.strokeStyle = '#4a80d0';
        ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    if (animation) {
        const t = (performance.now() - animation.start) / animation.duration;
        const px = (animation.fx + (animation.tx - animation.fx) * t) * CELL + CELL / 2;
        const py = (animation.fy + (animation.ty - animation.fy) * t) * CELL + CELL / 2;
        ctx.strokeStyle = 'rgba(255,255,80,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(animation.fx * CELL + CELL / 2, animation.fy * CELL + CELL / 2);
        ctx.lineTo(px, py);
        ctx.stroke();
        ctx.fillStyle = '#ff4';
        ctx.beginPath();
        ctx.arc(px, py, CELL * 0.15, 0, Math.PI * 2);
        ctx.fill();
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
        ctx.moveTo(px, py + CELL * 0.15); ctx.lineTo(px + CELL, py + CELL * 0.15);
        ctx.moveTo(px, py + CELL * 0.85); ctx.lineTo(px + CELL, py + CELL * 0.85);
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
    ctx.globalAlpha = dim ? 0.75 : 1;
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

function getShotCells(u) {
    const onHill = MAP[u.y][u.x].terrain === 'hill';
    const range = SHOOT_RANGE + (onHill ? 2 : 0);
    const v = DIR_VECS[u.dir];
    const starts = parallelStarts(u, u.dir);
    const out = [];
    for (const s of starts) {
        for (let k = 0; k < range; k++) {
            const nx = s.x + v.dx * k, ny = s.y + v.dy * k;
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

function highlightUnit(u) {
    const moves = getMoveCells(u);
    ctx.fillStyle = 'rgba(120,255,120,0.35)';
    moves.forEach(c => ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL));

    const shots = getShotCells(u);
    ctx.fillStyle = aimMode ? 'rgba(255,150,50,0.4)' : 'rgba(180,180,180,0.15)';
    shots.forEach(c => {
        if (!moves.some(m => m.x === c.x && m.y === c.y)) {
            ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
        }
    });
}

function updateTopBar() {
    const dot = document.getElementById('turnDot');
    const info = document.getElementById('turnInfo');
    if (!state) return;
    if (state.phase === 'battle') {
        const myTurn = state.turn === myRole;
        dot.className = myTurn ? 'blue' : 'red';
        info.textContent = myTurn ? '🟢 Ваш ход' : '🔴 Ход соперника';
    } else if (state.phase === 'over') {
        if (state.draw) {
            dot.className = 'blue';
            info.textContent = '🤝 Ничья';
        } else {
            dot.className = state.winner === myRole ? 'blue' : 'red';
            info.textContent = state.winner === myRole ? '🏆 Победа!' : '💀 Поражение';
        }
    }
}

function updateBottomPanel() {
    const stats = document.getElementById('stats');
    const toolbar = document.getElementById('toolbar');
    toolbar.innerHTML = '';
    if (!state) return;

    const is15 = state.mode === '15v15';
    const myTurn = state.turn === myRole;

    if (state.phase === 'battle') {
        const mine = state.units.filter(u => u.owner === myRole);
        const notMoved = mine.filter(u => !u.acted).length;
        const enemy = state.units.filter(u => u.owner !== myRole).length;
        let html = 'Моих бойцов: <b>' + mine.length + '</b><br>Ещё не ходили: <b>' + notMoved + '</b><br>Врагов в обзоре: <b>' + enemy + '</b>';
        if (is15) {
            const myMoves = state.movesCount[myRole] || 0;
            html += '<br>Ходов до ничьей: <b>' + Math.max(0, state.drawLimit - myMoves) + '</b>';
        }
        stats.innerHTML = html;

        if (!myTurn) {
            addBtn(toolbar, '⏳ Ожидание соперника', null, 'waitingBtn wide');
            return;
        }

        const row1 = mkRow(toolbar);
        addBtn(row1, '👥 Выделить всех', () => {
            selected.clear();
            mine.forEach(u => { if (!u.acted) selected.add(u.id); });
            if (selected.size === 0) showToast('Все бойцы уже сходили', 'info');
            else showToast('Выделено: ' + selected.size + ' бойцов', 'success');
            render();
        });
        addBtn(row1, '✖ Снять', () => { selected.clear(); aimMode = false; render(); });

        const row2 = mkRow(toolbar);
        addBtn(row2, aimMode ? '🎯 Клик по цели…' : '🎯 Выстрел', () => {
            if (selected.size === 0) { showToast('Сначала выбери бойца', 'error'); return; }
            const u = state.units.find(x => selected.has(x.id));
            if (!u || u.acted) { showToast('Этот боец уже сходил', 'error'); return; }
            aimMode = !aimMode;
            if (aimMode) showToast('Клик по врагу или по пустой клетке — выстрел', 'info');
            render();
        }, aimMode ? 'primary wide' : 'wide');

        mkLabel(toolbar, 'Повернуть:');
        const rowDir = mkRow(toolbar);
        ['↖','↑','↗','→','↘','↓','↙','←'].forEach(s => {
            const mapD = { '↑':0, '↗':1, '→':2, '↘':3, '↓':4, '↙':5, '←':6, '↖':7 };
            addBtn(rowDir, s, () => rotateSelected(mapD[s]), 'arrowBtn');
        });

        if (is15) {
            const rowDraw = mkRow(toolbar);
            if (state.drawProposed && state.drawProposed.by !== myRole) {
                addBtn(rowDraw, '🤝 Принять ничью', () => {
                    ws.send(JSON.stringify({ type: 'acceptDraw' }));
                }, 'primary wide');
            } else if (state.drawProposed && state.drawProposed.by === myRole) {
                addBtn(rowDraw, '⏳ Ждём ответа на ничью…', null, 'waitingBtn wide');
            } else {
                addBtn(rowDraw, '🤝 Предложить ничью', () => {
                    ws.send(JSON.stringify({ type: 'proposeDraw' }));
                }, 'wide');
            }
        }

        const rowEnd = mkRow(toolbar);
        const endBtnText = confirmEndArmed ? '✅ Точно завершить?' : '✅ Завершить ход';
        const endBtnCls = confirmEndArmed ? 'confirmEnd wide' : 'primary wide';
        addBtn(rowEnd, endBtnText, () => {
            const mineU = state.units.filter(u => u.owner === myRole);
            const notMovedU = mineU.filter(u => !u.acted).length;
            if (notMovedU > 0 && !confirmEndArmed) {
                confirmEndArmed = true;
                showToast('Ещё ' + notMovedU + ' бойцов не ходили. Нажми ещё раз, чтобы завершить', 'info');
                render();
                return;
            }
            confirmEndArmed = false;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endTurn' }));
            selected.clear(); aimMode = false;
        }, endBtnCls);
    }

    if (state.phase === 'over') {
        stats.textContent = state.draw ? 'Ничья' : (state.winner === myRole ? '🏆 Вы победили!' : '💀 Вы проиграли');
        const row = mkRow(toolbar);
        addBtn(row, '🔄 В лобби', () => leaveGame(), 'primary wide');
    }
}

function mkRow(parent) {
    const r = document.createElement('div');
    r.className = 'row';
    parent.appendChild(r);
    return r;
}

function mkLabel(parent, text) {
    const d = document.createElement('div');
    d.className = 'row label';
    d.textContent = text;
    parent.appendChild(d);
}

function addBtn(parent, text, fn, cls) {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    if (fn) b.onclick = fn;
    parent.appendChild(b);
    return b;
}

function rotateSelected(dir) {
    if (!state || state.turn !== myRole) return;
    if (selected.size === 0) { showToast('Сначала выбери бойца', 'error'); return; }
    let rotated = 0;
    let alreadyFacing = 0;
    let blocked = 0;
    selected.forEach(id => {
        const u = state.units.find(x => x.id === id);
        if (!u || u.acted) { blocked++; return; }
        if (u.dir === dir) { alreadyFacing++; return; }
        ws.send(JSON.stringify({ type: 'action', action: 'rotate', id, dir }));
        rotated++;
    });
    if (rotated === 0) {
        if (alreadyFacing > 0) showToast('Боец уже смотрит туда', 'info');
        else if (blocked > 0) showToast('Эти бойцы уже сходили', 'info');
        else showToast('Нечего поворачивать', 'info');
    }
    render();
}

function cellFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    let cx, cy;
    if (e.touches && e.touches[0]) { cx = e.touches[0].clientX - r.left; cy = e.touches[0].clientY - r.top; }
    else if (e.changedTouches && e.changedTouches[0]) { cx = e.changedTouches[0].clientX - r.left; cy = e.changedTouches[0].clientY - r.top; }
    else { cx = e.clientX - r.left; cy = e.clientY - r.top; }
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
        selected.clear();
        inRect.forEach(u => selected.add(u.id));
        dragStart = dragEnd = null;
        render();
        return;
    }
    dragStart = dragEnd = null;
    handleClick(c, !!(e.ctrlKey || e.shiftKey));
}

function handleClick(c, multi) {
    if (!state || state.phase !== 'battle' || state.turn !== myRole) return;
    const clicked = state.units.find(u => u.x === c.x && u.y === c.y);

    if (clicked && clicked.owner === myRole) {
        if (clicked.acted) {
            showToast('Этот боец уже сходил', 'info');
            return;
        }
        if (multi) {
            if (selected.has(clicked.id)) selected.delete(clicked.id);
            else selected.add(clicked.id);
        } else {
            selected.clear();
            selected.add(clicked.id);
        }
        aimMode = false;
        confirmEndArmed = false;
        render();
        return;
    }

    if (aimMode) {
        if (selected.size === 0) {
            aimMode = false;
            showToast('Сначала выбери бойца', 'error');
            render();
            return;
        }
        const u = state.units.find(x => selected.has(x.id));
        if (!u || u.acted) {
            aimMode = false;
            showToast('Боец недоступен', 'error');
            render();
            return;
        }
        if (clicked && clicked.owner !== myRole) {
            const shots = getShotCells(u);
            if (!shots.some(s => s.x === clicked.x && s.y === clicked.y)) {
                showToast('Цель вне зоны стрельбы', 'error');
                aimMode = false;
                render();
                return;
            }
            ws.send(JSON.stringify({ type: 'action', action: 'shoot', id: u.id, targetId: clicked.id }));
            aimMode = false;
            selected.delete(u.id);
            render();
            return;
        }
        const shots = getShotCells(u);
        if (shots.some(s => s.x === c.x && s.y === c.y)) {
            showToast('Выстрел вслепую…', 'info');
            ws.send(JSON.stringify({ type: 'action', action: 'shootAt', id: u.id, x: c.x, y: c.y }));
            aimMode = false;
            selected.delete(u.id);
            render();
            return;
        }
        showToast('Сюда стрелять нельзя — вне зоны', 'error');
        aimMode = false;
        render();
        return;
    }

    if (clicked && clicked.owner !== myRole) {
        showToast('Это враг. Нажми «🎯 Выстрел», потом клик по нему.', 'info');
        return;
    }

    if (selected.size === 1) {
        const u = state.units.find(x => selected.has(x.id));
        if (!u || u.acted) return;
        const cell = MAP[c.y] && MAP[c.y][c.x];
        if (cell && cell.terrain === 'unknown') {
            showToast('Туда не видно — неизвестная клетка', 'error');
            return;
        }
        if (cell && cell.terrain === 'river' && !cell.bridge) {
            showToast('Река — туда нельзя без моста', 'error');
            return;
        }
        if (state.units.some(o => o.x === c.x && o.y === c.y && o.hp > 0)) {
            showToast('Клетка занята', 'error');
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
        showToast('Слишком далеко — боец ходит на 1 клетку', 'info');
        return;
    }

    selected.clear();
    aimMode = false;
    confirmEndArmed = false;
    render();
}

document.addEventListener('keydown', (e) => {
    if (!state || state.phase !== 'battle' || state.turn !== myRole) return;
    const keyMap = { 'ArrowUp': 0, 'ArrowRight': 2, 'ArrowDown': 4, 'ArrowLeft': 6 };
    if (e.key in keyMap) {
        rotateSelected(keyMap[e.key]);
        e.preventDefault();
    } else if (e.key === 'Enter') {
        const mineU = state.units.filter(u => u.owner === myRole);
        const notMovedU = mineU.filter(u => !u.acted).length;
        if (notMovedU > 0 && !confirmEndArmed) {
            confirmEndArmed = true;
            showToast('Ещё ' + notMovedU + ' бойцов не ходили. Enter ещё раз — завершить', 'info');
            render();
            return;
        }
        confirmEndArmed = false;
        ws.send(JSON.stringify({ type: 'endTurn' }));
        selected.clear(); aimMode = false;
    } else if (e.key === 'Escape') {
        selected.clear(); aimMode = false; confirmEndArmed = false;
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
        const myTurn = state.turn === myRole;
        html = myTurn ? '<h3>Ваш ход</h3>' : '<h3>Ход соперника</h3>';
        html += '<b>Что делать:</b><br>' +
            '1. Клик по своему бойцу — выделить.<br>' +
            '2. Клик по зелёной клетке — шаг.<br>' +
            '3. Кнопки-стрелки — поворот.<br>' +
            '4. Кнопка «🎯 Выстрел», потом клик по врагу — выстрел.<br>' +
            '5. «Завершить ход» — передать ход.<br><br>';
        if (state.mode === '15v15') {
            html += '<b>Режим 15 vs 15.</b> У обоих туман войны. Ничья — если 100 ходов без победы, или по кнопке.<br><br>';
        } else {
            if (myRole === 'defender') {
                html += '<b>Вы — защитник (сверху, синие).</b> Видите всю карту. У вас 10 бойцов против 20.<br><br>';
            } else {
                html += '<b>Вы — атакующий (снизу, красные).</b> Видите только обзор. У вас 20 бойцов против 10.<br><br>';
            }
        }
        html += 'Свои — <b style="color:#4a80d0">синие</b>. Враги — <b style="color:#c44">красные</b> (затемнены).';
    }
    content.innerHTML = html;
    el.classList.add('show');
}

function showToast(text, type) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = text;
    t.className = 'show ' + (type || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); }, 3000);
}

function showShotToast(text, kind) {
    const t = document.getElementById('shotToast');
    const tt = document.getElementById('shotToastText');
    if (!t || !tt) return;
    tt.textContent = text;
    t.className = 'show ' + (kind || '');
    clearTimeout(shotToastTimer);
    shotToastTimer = setTimeout(hideShotToast, 3500);
}

function hideShotToast() {
    const t = document.getElementById('shotToast');
    if (t) t.classList.remove('show');
}

window.addEventListener('resize', () => { if (state) { resizeCanvas(); render(); } });
window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (state) { resizeCanvas(); render(); } }, 200);
});
