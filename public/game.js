const SHOT_ANIM_MS = 350;
const CANNON_ANIM_MS = 600;
const EXPLOSION_ANIM_MS = 500;

let CELL = 32;
let MAP = null;
let ws = null;
let state = null;
let myRole = null;
let selected = new Set();
let aimMode = false;
let confirmEndArmed = false;
let drawArmed = false;
let dragStart = null, dragEnd = null;
let lastShotEventAt = 0;
let toastTimer = null;
let shotToastTimer = null;
let bulletAnim = null;
let explosionAnim = null;
let setupUnits = [];
let setupType = 'infantry';

// Элемент canvas берется по ID "board", как указано в HTML-разметке выше
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
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'joinQueue', mode }));
    showScreen('waitingScreen');
}

function cancelQueue() {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'cancelQueue' }));
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
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'matched') {
            myRole = msg.role;
            setupUnits = [];
            selected.clear();
            aimMode = false;
            showScreen('gameScreen');
            setTimeout(resizeCanvas, 80);
        } else if (msg.type === 'waiting') showScreen('waitingScreen');
        else if (msg.type === 'queueCancelled') showScreen('lobby');
        else if (msg.type === 'state') { state = msg.state; onStateUpdate(); }
        else if (msg.type === 'opponentLeft') {
            showModal(
                msg.surrender ? 'Соперник сдался. Вы победили!' : 'Соперник вышел из партии.',
                [{ text: 'В лобби', cls: 'safe', action: () => { hideModal(); leaveToLobby(); } }]
            );
        } else if (msg.type === 'error') showToast(msg.message, 'error');
    };
}

function leaveToLobby() {
    state = null; selected.clear(); aimMode = false;
    confirmEndArmed = false; drawArmed = false; setupUnits = [];
    showScreen('lobby');
}

function onStateUpdate() {
    if (!state) return;
    resizeCanvas();
    if (state.lastEvent && state.lastEvent.kind === 'shot' && state.lastEvent.at !== lastShotEventAt) {
        lastShotEventAt = state.lastEvent.at;
        const e = state.lastEvent;
        const fromCell = state.map[e.from.y] && state.map[e.from.y][e.from.x];
        const fromVisible = fromCell && fromCell.terrain !== 'unknown';
        const toCell = state.map[e.to.y] && state.map[e.to.y][e.to.x];
        const toVisible = toCell && toCell.terrain !== 'unknown';
        if (fromVisible || toVisible) {
            const isCannon = !!e.cannon;
            const dur = isCannon ? CANNON_ANIM_MS : SHOT_ANIM_MS;
            bulletAnim = {
                fx: fromVisible ? e.from.x : e.to.x,
                fy: fromVisible ? e.from.y : e.to.y,
                tx: e.to.x, ty: e.to.y,
                start: performance.now(), dur, isCannon, onlyTarget: !fromVisible
            };
            animateBullet();
        }
        if (e.cannon && e.explosion && toVisible) {
            explosionAnim = {
                x: e.explosion.x, y: e.explosion.y, cells: e.explosion.cells,
                start: performance.now() + CANNON_ANIM_MS, dur: EXPLOSION_ANIM_MS
            };
            setTimeout(() => animateExplosion(), CANNON_ANIM_MS);
        }
        if (e.by === myRole) {
            let msg = '';
            if (e.cannon) {
                if (e.hit) msg = e.killed ? 'Пушка: попадание, есть потери' : 'Пушка: точное попадание!';
                else msg = 'Пушка: промах, разрыв рядом';
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

function resizeCanvas() {
    const wrap = document.getElementById('boardWrap');
    if (!wrap || !state) return;
    const w = wrap.clientWidth - 8;
    const h = wrap.clientHeight - 8;
    const size = Math.min(w, h);
    if (size <= 0) return;
    CELL = Math.floor(size / state.size);
    canvas.width = CELL * state.size;
    canvas.height = CELL * state.size;
}

function isSetupPhase() {
    return state && state.phase === 'setup' && state.mode === '10v20' && myRole === 'defender';
}

function getSetupZone() {
    if (!state) return null;
    if (state.mode === '10v20') return myRole === 'defender' ? [1, 8] : [12, 18];
    if (state.mode === '15v15') return myRole === 'player1' ? [1, 6] : [14, 18];
    if (state.mode === 'capture') return myRole === 'player1' ? [1, 5] : [10, 13];
    return null;
}

/* --- РЕНДЕР ИГРОВОГО ПОЛЯ --- */

function render() {
    if (!state || !state.map) return;
    const N = state.size;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    MAP = state.map;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) drawTerrain(x, y, MAP[y][x]);
    
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 0; i <= N; i++) {
        ctx.beginPath(); ctx.moveTo(i * CELL, 0); ctx.lineTo(i * CELL, canvas.height); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, i * CELL); ctx.lineTo(canvas.width, i * CELL); ctx.stroke();
    }

    if (isSetupPhase()) {
        const color = '#4a80d0';
        const zone = getSetupZone();
        if (zone) {
            ctx.fillStyle = 'rgba(100,200,100,0.08)';
            ctx.fillRect(0, zone[0] * CELL, canvas.width, (zone[1] - zone[0] + 1) * CELL);
            ctx.strokeStyle = 'rgba(100,200,100,0.4)';
            ctx.strokeRect(0, zone[0] * CELL, canvas.width, (zone[1] - zone[0] + 1) * CELL);
        }
        setupUnits.forEach(u => drawUnit(u.x, u.y, 4, color, false, false, 2, u.type, false));
    }

    if (selected.size === 1) {
        const u = state.units.find(x => selected.has(x.id));
        if (u && u.owner === myRole) highlightUnit(u);
    }

    state.units.forEach(u => {
        if (isSetupPhase() && u.owner === myRole) return;
        const isMine = u.owner === myRole;
        const baseColor = isMine ? '#4a80d0' : '#c44';
        const dim = !isMine && state.turn === myRole;
        drawUnit(u.x, u.y, u.dir, baseColor, selected.has(u.id), dim, u.hp, u.type, u.reloading);
    });

    if (dragStart && dragEnd) {
        const x1 = Math.min(dragStart.x, dragEnd.x) * CELL;
        const y1 = Math.min(dragStart.y, dragEnd.y) * CELL;
        const x2 = Math.max(dragStart.x, dragEnd.x) * CELL;
        const y2 = Math.max(dragStart.y, dragEnd.y) * CELL;
        ctx.strokeStyle = '#4a80d0'; ctx.lineWidth = 2;
        ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }

    if (bulletAnim) {
        const t = (performance.now() - bulletAnim.start) / bulletAnim.dur;
        if (t < 1) drawBullet(t); else bulletAnim = null;
    }
    if (explosionAnim) {
        const t = (performance.now() - explosionAnim.start) / explosionAnim.dur;
        if (t >= 0 && t < 1) drawExplosion(t);
        else if (t >= 1) explosionAnim = null;
    }

    updateTopPanel();
    updateControlPanel();
}

function drawBullet(t) {
    const { fx, fy, tx, ty, isCannon, onlyTarget } = bulletAnim;
    const px1 = tx * CELL + CELL / 2, py1 = ty * CELL + CELL / 2;
    if (onlyTarget) {
        ctx.fillStyle = isCannon ? '#888' : '#ff4';
        ctx.beginPath(); ctx.arc(px1, py1, CELL * 0.15, 0, Math.PI * 2); ctx.fill();
        return;
    }
    const px0 = fx * CELL + CELL / 2, py0 = fy * CELL + CELL / 2;
    if (isCannon) {
        const midX = (px0 + px1) / 2;
        const midY = (py0 + py1) / 2 - CELL * 2.5;
        const x = (1 - t) * (1 - t) * px0 + 2 * (1 - t) * t * midX + t * t * px1;
        const y = (1 - t) * (1 - t) * py0 + 2 * (1 - t) * t * midY + t * t * py1;
        ctx.strokeStyle = 'rgba(120,120,120,0.6)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = '#222';
        ctx.beginPath(); ctx.arc(x, y, CELL * 0.22, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#888'; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
        const x = px0 + (px1 - px0) * t;
        const y = py0 + (py1 - py0) * t;
        ctx.strokeStyle = 'rgba(255,255,80,0.55)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(px0, py0); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = '#ff4';
        ctx.beginPath(); ctx.arc(x, y, CELL * 0.13, 0, Math.PI * 2); ctx.fill();
    }
}

function drawExplosion(t) {
    const { x, y, cells } = explosionAnim;
    const cx = x * CELL + CELL / 2, cy = y * CELL + CELL / 2;
    cells.forEach(c => {
        // Исправлено использование template literal для rgba
        ctx.fillStyle = `rgba(255,180,60,${0.6 * (1 - t)})`;
        ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
    });
    const radius = CELL * 0.3 + CELL * 1.5 * t;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, `rgba(255,220,80,${0.9 * (1 - t)})`);
    grad.addColorStop(0.5, `rgba(255,120,30,${0.7 * (1 - t)})`);
    grad.addColorStop(1, 'rgba(120,30,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.fill();
}

function drawTerrain(x, y, c) {
    const px = x * CELL, py = y * CELL;
    if (c.terrain === 'unknown') { ctx.fillStyle = '#0a0a0f'; ctx.fillRect(px, py, CELL, CELL); return; }
    switch (c.terrain) {
        case 'river': ctx.fillStyle = c.bridge ? '#8b6b3a' : '#3a6ea5'; break;
        case 'hill': ctx.fillStyle = '#7a6a4a'; break;
        case 'forest': ctx.fillStyle = '#2e5a2e'; break;
        default: ctx.fillStyle = '#4a6a4a';
    }
    ctx.fillRect(px, py, CELL, CELL);
    if (c.bridge) {
        ctx.strokeStyle = '#3a2410'; ctx.lineWidth = Math.max(2, CELL * 0.08);
        ctx.beginPath();
        ctx.moveTo(px, py + CELL * 0.2); ctx.lineTo(px + CELL, py + CELL * 0.2);
        ctx.moveTo(px, py + CELL * 0.8); ctx.lineTo(px + CELL, py + CELL * 0.8);
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
        ctx.closePath(); ctx.fill();
    }
}

function drawUnit(x, y, dir, color, isSel, dim, hp, type, reloading) {
    const px = x * CELL + CELL / 2, py = y * CELL + CELL / 2;
    ctx.globalAlpha = dim ? 0.7 : 1;
    if (type === 'cannon') {
        const s = CELL * 0.38;
        ctx.fillStyle = color;
        ctx.fillRect(px - s, py - s, s * 2, s * 2);
        ctx.strokeStyle = isSel ? '#ff0' : '#000';
        ctx.lineWidth = isSel ? 3 : 1.5;
        ctx.strokeRect(px - s, py - s, s * 2, s * 2);
        if (reloading) {
            ctx.strokeStyle = '#fa0'; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(px, py, s * 1.3, 0, Math.PI * 1.5); ctx.stroke();
        }
    } else {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(px, py, CELL * 0.34, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = isSel ? '#ff0' : '#000';
        ctx.lineWidth = isSel ? 3 : 1.5; ctx.stroke();
    }
    ctx.fillStyle = '#000';
    const dotR = CELL * 0.08;
    if (hp === 2) {
        ctx.beginPath(); ctx.arc(px - CELL * 0.09, py, dotR, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(px + CELL * 0.09, py, dotR, 0, Math.PI * 2); ctx.fill();
    } else if (hp === 1) {
        ctx.beginPath(); ctx.arc(px, py, dotR, 0, Math.PI * 2); ctx.fill();
    }
    const v = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]][dir];
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + v[0] * CELL * 0.22, py + v[1] * CELL * 0.22);
    ctx.lineTo(px + v[0] * CELL * 0.44, py + v[1] * CELL * 0.44);
    ctx.stroke();
    ctx.globalAlpha = 1;
}

/* --- ЛОГИКА ХОДОВ И ЗОН --- */

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

function getInfantryShotCells(u) {
    const N = state.size;
    const onHill = MAP[u.y][u.x].terrain === 'hill';
    const range = 6 + (onHill ? 2 : 0);
    const v = DIR_VECS[u.dir];
    const starts = parallelStarts(u, u.dir);
    const out = [];
    for (const s of starts) {
        for (let k = 0; k < range; k++) {
            const nx = s.x + v.dx * k, ny = s.y + v.dy * k;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) break;
            out.push({ x: nx, y: ny });
            if (!onHill) {
                const c = MAP[ny][nx];
                if (c && (c.terrain === 'forest' || c.terrain === 'hill')) break;
            }
        }
    }
    return out;
}

function getCannonShotCells(u) {
    const N = state.size;
    const onHill = MAP[u.y][u.x].terrain === 'hill';
    const maxRange = onHill ? 10 : 8;
    const v = DIR_VECS[u.dir];
    const out = [];
    for (let k = 5; k <= maxRange; k++) {
        const nx = u.x + v.dx * k, ny = u.y + v.dy * k;
        if (nx < 0 || ny < 0 || nx >= N || ny >= N) break;
        out.push({ x: nx, y: ny });
    }
    return out;
}

function getShotCells(u) {
    return u.type === 'cannon' ? getCannonShotCells(u) : getInfantryShotCells(u);
}

function getMoveCells(u) {
    const N = state.size;
    const maxSteps = u.type === 'cannon' ? 1 : 2;
    const dirs = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];
    const out = [];
    for (const [dx, dy] of dirs) {
        for (let s = 1; s <= maxSteps; s++) {
            const nx = u.x + dx * s, ny = u.y + dy * s;
            if (nx < 0 || ny < 0 || nx >= N || ny >= N) break;
            const c = MAP[ny][nx];
            if (!c || c.terrain === 'unknown') break;
            if (c.terrain === 'river' && !c.bridge) break;
            if (state.units.some(o => o.x === nx && o.y === ny && o.hp > 0)) break;
            out.push({ x: nx, y: ny });
        }
    }
    return out;
}

function highlightUnit(u) {
    const moves = getMoveCells(u);
    ctx.fillStyle = 'rgba(120,255,120,0.35)';
    moves.forEach(c => ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL));
    const shots = getShotCells(u);
    ctx.fillStyle = aimMode ? 'rgba(255,150,50,0.5)' : 'rgba(180,180,180,0.15)';
    shots.forEach(c => {
        if (!moves.some(m => m.x === c.x && m.y === c.y)) ctx.fillRect(c.x * CELL, c.y * CELL, CELL, CELL);
    });
    if (u.type === 'cannon') {
        const v = DIR_VECS[u.dir];
        for (let k = 1; k < 5; k++) {
            const nx = u.x + v.dx * k, ny = u.y + v.dy * k;
            if (nx < 0 || ny < 0 || nx >= state.size || ny >= state.size) break;
            ctx.fillStyle = 'rgba(80,80,80,0.2)';
            ctx.fillRect(nx * CELL, ny * CELL, CELL, CELL);
        }
    }
}

/* --- ИНТЕРФЕЙС УПРАВЛЕНИЯ --- */

function updateTopPanel() {
    const dot = document.getElementById('turnDot');
    const info = document.getElementById('turnInfo');
    if (!state) return;
    if (state.phase === 'battle') {
        const myTurn = state.turn === myRole;
        dot.className = myTurn ? 'blue' : 'red';
        info.textContent = myTurn ? 'Ваш ход' : 'Ход противника';
    } else if (state.phase === 'setup') {
        dot.className = 'blue'; info.textContent = 'Расстановка';
    } else if (state.phase === 'over') {
        if (state.draw) { dot.className = 'blue'; info.textContent = '🤝 Ничья'; }
        else {
            dot.className = state.winner === myRole ? 'blue' : 'red';
            info.textContent = state.winner === myRole ? '🏆 Победа!' : '💀 Поражение';
        }
    }
}

function updateControlPanel() {
    const rowMain = document.getElementById('rowMain');
    const rowArrows = document.getElementById('rowArrows');
    const rowActions = document.getElementById('rowActions');
    const rowEnd = document.getElementById('rowEnd');
    rowMain.innerHTML = ''; rowArrows.innerHTML = ''; rowActions.innerHTML = ''; rowEnd.innerHTML = '';
    if (!state) return;

    if (isSetupPhase()) {
        const infNeed = 10, canNeed = 2;
        const infHave = setupUnits.filter(u => u.type === 'infantry').length;
        const canHave = setupUnits.filter(u => u.type === 'cannon').length;
        const info1 = document.createElement('div');
        info1.style.cssText = 'width:100%;text-align:center;font-size:13px;color:#ccc;padding:4px;';
        info1.textContent = `Пехота: ${infHave}/${infNeed} · Пушки: ${canHave}/${canNeed}`;
        rowMain.appendChild(info1);
        
        mkBtn(rowMain, 'Пехота', () => { setupType = 'infantry'; render(); }, setupType === 'infantry' ? 'primary' : '');
        mkBtn(rowMain, 'Пушка', () => { setupType = 'cannon'; render(); }, setupType === 'cannon' ? 'primary' : '');
        mkBtn(rowActions, 'Очистить', () => { setupUnits = []; render(); });
        
        const ready = infHave === infNeed && canHave === canNeed;
        const goBtn = mkBtn(rowActions, '✅ Готов', () => {
            if (!ready) { showToast('Не всё поставлено', 'error'); return; }
            ws.send(JSON.stringify({ type: 'setup', units: setupUnits }));
        }, 'primary');
        goBtn.disabled = !ready;
        return;
    }

    if (state.phase === 'setup' && state.mode === '10v20' && myRole === 'attacker') {
        const info = document.createElement('div');
        info.style.cssText ='width:100%;text-align:center;font-size:13px;color:#aaa;padding:6px;';
        info.textContent = 'Ожидание расстановки защитника…';
        rowMain.appendChild(info);
        const b = mkBtn(rowMain, '⏳ Ожидание', null, 'waitingBtn');
        b.style.flex = '1 1 100%';
        return;
    }

    if (state.phase === 'battle') {
        const myTurn = state.turn === myRole;
        const mine = state.units.filter(u => u.owner === myRole);
        const notMoved = mine.filter(u => !u.acted);
        if (!myTurn) {
            const b = mkBtn(rowMain, '⏳ Ожидание соперника', null, 'waitingBtn');
            b.style.flex = '1 1 100%';
            return;
        }
        const selUnit = selected.size === 1 ? state.units.find(x => selected.has(x.id)) : null;
        const shootLabel = aimMode ? '🎯 Клик по цели…' : (selUnit && selUnit.type === 'cannon' ? '💥 Выстрел из пушки' : '🎯 Выстрел');
        const shootBtn = mkBtn(rowMain, shootLabel, () => {
            if (!selUnit) { showToast('Сначала выбери бойца', 'error'); return; }
            if (selUnit.acted) { showToast('Этот боец уже ходил', 'error'); return; }
            if (selUnit.reloading) { showToast('Пушка перезаряжается', 'error'); return; }
            aimMode = !aimMode;
            if (aimMode) showToast(selUnit.type === 'cannon' ? 'Клик по клетке (5–8)' : 'Клик по врагу или пустой клетке', 'info');
            render();
        }, aimMode ? 'primary' : '');
        shootBtn.style.flex = '1 1 100%';
        rowMain.appendChild(shootBtn);

        ['↖','↑','↗','→','↘','↓','↙','←'].forEach(s => {
            const mapD = { '↑':0, '↗':1, '→':2, '↘':3, '↓':4, '↙':5, '←':6, '↖':7 };
            mkBtn(rowArrows, s, () => rotateSelected(mapD[s]), 'arrowBtn');
        });

        const allMoved = notMoved.length === 0;
        const selectLabel = selected.size > 0 ? '✖ Снять' : '👥 Кто не сходил';
        const selBtn = mkBtn(rowActions, selectLabel, () => {
            if (selected.size > 0) selected.clear();
            else {
                if (allMoved) { showToast('Все уже сходили', 'info'); return; }
                mine.forEach(u => { if (!u.acted) selected.add(u.id); });
            }
            render();
        });
        selBtn.style.flex = '1 1 45%';

        if (state.mode === '15v15') {
            let drawLabel;
            if (state.drawProposed && state.drawProposed.by !== myRole) drawLabel = '🤝 Принять ничью';
            else if (state.drawProposed && state.drawProposed.by === myRole) drawLabel = '⏳ Ждём';
            else if (drawArmed) drawLabel = '🤝 Точно?';
            else drawLabel = '🤝 Ничья';
            const db = mkBtn(rowActions, drawLabel, () => {
                if (state.drawProposed && state.drawProposed.by !== myRole) { ws.send(JSON.stringify({ type: 'acceptDraw' })); return; }
                if (state.drawProposed) return;
                if (!drawArmed) { drawArmed = true; render(); return; }
                drawArmed = false;
                ws.send(JSON.stringify({ type: 'proposeDraw' }));
                render();
            });
            db.style.flex = '1 1 45%';
        }

        const endLabel = confirmEndArmed ? '✅ Точно завершить?' : '✅ Завершить ход';
        const endCls = confirmEndArmed ? 'confirmEnd' : 'primary';
        const endB = mkBtn(rowEnd, endLabel, () => {
            if (notMoved.length > 0 && !confirmEndArmed) {
                confirmEndArmed = true;
                showToast(`Ещё ${notMoved.length} не сходили. Нажми ещё раз`, 'info');
                render();
                return;
            }
            confirmEndArmed = false;
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endTurn' }));
            selected.clear(); aimMode = false;
        }, endCls);
        endB.style.flex = '1 1 100%';
    }

    if (state.phase === 'over') {
        const b = mkBtn(rowMain, '🔄 В лобби', () => leaveToLobby(), 'primary');
        b.style.flex = '1 1 100%';
    }
}

function mkBtn(parent, text, fn, cls) {
    const b = document.createElement('button');
    b.textContent = text;
    if (cls) b.className = cls;
    if (fn) b.onclick = fn;
    parent.appendChild(b);
    return b;
}

/* --- ОБРАБОТЧИКИ СОБЫТИЙ --- */

function rotateSelected(dir) {
    if (!state || state.turn !== myRole) return;
    if (selected.size === 0) { showToast('Сначала выбери бойца', 'error'); return; }
    let rotated = 0, alreadyFacing = 0, blocked = 0;
    selected.forEach(id => {
        const u = state.units.find(x => x.id === id);
        if (!u || u.acted) { blocked++; return; }
        if (u.dir === dir) { alreadyFacing++; return; }
        ws.send(JSON.stringify({ type: 'action', action: 'rotate', id, dir }));
        rotated++;
    });
    if (rotated === 0) {
        if (alreadyFacing > 0) showToast('Уже смотрит туда', 'info');
        else if (blocked > 0) showToast('Эти бойцы уже ходили', 'info');
    }
    render();
}

function cellFromEvent(e) {
    const r = canvas.getBoundingClientRect();
    let cx, cy;
    if(e.touches && e.touches[0]) { cx = e.touches[0].clientX - r.left; cy = e.touches[0].clientY - r.top; }
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

function handleSetupClick(c) {
    const zone = getSetupZone();
    if (!zone) return;
    if (c.y < zone[0] || c.y > zone[1]) { showToast('Только в зелёной зоне', 'error'); return; }
    const cell = MAP[c.y] && MAP[c.y][c.x];
    if (!cell || cell.terrain === 'unknown') return;
    if (cell.terrain === 'river' && !cell.bridge) { showToast('Река', 'error'); return; }
    const idx = setupUnits.findIndex(u => u.x === c.x && u.y === c.y);
    if (idx >= 0) { setupUnits.splice(idx, 1); render(); return; }
    const infHave = setupUnits.filter(u => u.type === 'infantry').length;
    const canHave = setupUnits.filter(u => u.type === 'cannon').length;
    if (setupType === 'infantry' && infHave >= 10) { showToast('Пехоты уже 10', 'error'); return; }
    if (setupType === 'cannon' && canHave >= 2) { showToast('Пушек уже 2', 'error'); return; }
    setupUnits.push({ x: c.x, y: c.y, type: setupType });
    render();
}

function handlePointerUp(e) {
    const c = cellFromEvent(e);
    if (isSetupPhase()) { handleSetupClick(c); dragStart = dragEnd = null; return; }
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
        if (clicked.acted) { showToast('Этот боец уже ходил', 'info'); return; }
        if (multi) {
            if (selected.has(clicked.id)) selected.delete(clicked.id);
            else selected.add(clicked.id);
        } else { selected.clear(); selected.add(clicked.id); }
        aimMode = false; confirmEndArmed = false;
        render();
        return;
    }
    if (aimMode) {
        if (selected.size !== 1) { aimMode = false; showToast('Сначала выбери одного', 'error'); render(); return; }
        const u = state.units.find(x => selected.has(x.id));
        if (!u || u.acted) { aimMode = false; showToast('Боец недоступен', 'error'); render(); return; }
        const shots = getShotCells(u);
        if (!shots.some(s => s.x === c.x && s.y === c.y)) { showToast('Вне зоны стрельбы', 'error'); aimMode = false; render(); return; }
        if (u.type === 'cannon') {
            ws.send(JSON.stringify({ type: 'action', action: 'shootCannon', id: u.id, x: c.x, y: c.y }));
            aimMode = false; selected.delete(u.id); render(); return;
        }
        if (clicked && clicked.owner !== myRole) {
            ws.send(JSON.stringify({ type: 'action', action: 'shoot', id: u.id, targetId: clicked.id }));
        } else {
            ws.send(JSON.stringify({ type: 'action', action: 'shootAt', id: u.id, x: c.x, y: c.y }));
        }
        aimMode = false; selected.delete(u.id); render();
        return;
    }
    if (clicked && clicked.owner !== myRole) { showToast('Это враг. Нажми «🎯 Выстрел»', 'info'); return; }
    if (selected.size === 1) {
        const u = state.units.find(x => selected.has(x.id));
        if (!u || u.acted) return;
        const cell = MAP[c.y] && MAP[c.y][c.x];
        if (cell && cell.terrain === 'unknown') { showToast('Туда не видно', 'error'); return; }
        if (cell && cell.terrain === 'river' && !cell.bridge) { showToast('Река без моста', 'error'); return; }
        if (state.units.some(o => o.x === c.x && o.y === c.y && o.hp > 0)) { showToast('Клетка занята', 'error'); return; }
        const moves = getMoveCells(u);
        if (moves.some(m => m.x === c.x && m.y === c.y)) {
            const dx = c.x - u.x, dy = c.y - u.y;
            ws.send(JSON.stringify({ type: 'action', action: 'move', id: u.id, dx, dy }));
            selected.delete(u.id); render(); return;
        }
        showToast(u.type === 'cannon' ? 'Пушка ходит на 1 клетку' : 'Слишком далеко', 'info');
        return;
    }
    selected.clear(); aimMode = false; confirmEndArmed = false;
    render();
}

document.addEventListener('keydown', (e) => {
    if (!state || state.phase !== 'battle' || state.turn !== myRole) return;
    const keyMap = { 'ArrowUp': 0, 'ArrowRight': 2, 'ArrowDown': 4, 'ArrowLeft': 6 };
    if (e.key in keyMap) { rotateSelected(keyMap[e.key]); e.preventDefault(); }
    else if (e.key === 'Enter') {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'endTurn' }));
        selected.clear(); aimMode = false;
    } else if (e.key === 'Escape') {
        selected.clear(); aimMode = false; confirmEndArmed = false;
        render();
    }
});

/* --- МОДАЛЬНЫЕ ОКНА И УВЕДОМЛЕНИЯ --- */

function toggleHint() {
    const el = document.getElementById('hintPopup');
    const content = document.getElementById('hintContent');
    if (el.classList.contains('show')) { el.classList.remove('show'); return; }
    if (!state) return;
    const mine = state.units.filter(u => u.owner === myRole);
    const notMoved = mine.filter(u => !u.acted).length;
    const enemy = state.units.filter(u => u.owner !== myRole).length;
    let html = '<h3>Информация</h3>';
    html += `<div class="stat">Своих бойцов: <b>${mine.length}</b></div>`;
    html += `<div class="stat">Не сходили: <b>${notMoved}</b></div>`;
    html += `<div class="stat">Видимых врагов: <b>${enemy}</b></div>`;
    if (state.mode === '15v15' && state.drawLimit) {
        const mv = state.movesCount[myRole] || 0;
        html += `<div class="stat">Ходов до ничьей: <b>${Math.max(0, state.drawLimit - mv)}</b></div>`;
    }
    if (state.mode === 'capture' && state.turnLimit) {
        html += `<div class="stat">Ход <b>${state.turnNumber}</b> из <b>${state.turnLimit * 2}</b></div>`;
        if (state.territory) {
            const total = state.size * state.size;
            html += `<div class="stat">Контроль (вы): <b>${Math.round(state.territory.me / total * 100)}%</b></div>`;
            html += `<div class="stat">Контроль (враг): <b>${Math.round(state.territory.enemy / total * 100)}%</b></div>`;
        }
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
    toastTimer = setTimeout(() => { t.classList.remove('show'); }, 2800);
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

function showModal(text, actions) {
    const modal = document.getElementById('modal');
    document.getElementById('modalText').textContent = text;
    const acts = document.getElementById('modalActions');
    acts.innerHTML = '';
    actions.forEach(a => {
        const b = document.createElement('button');
        b.textContent = a.text;
        b.className = a.cls || 'cancel';
        b.onclick = a.action;
        acts.appendChild(b);
    });
    modal.classList.add('show');
}

function hideModal() { document.getElementById('modal').classList.remove('show'); }

function askLeave() {
    showModal('Точно выйти? Партия будет удалена.', [
        { text: 'Выйти', cls:'danger', action: () => {
            hideModal();
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'leave' }));
            leaveToLobby();
        }},
        { text: 'Остаться', cls: 'safe', action: hideModal }
    ]);
}

function askSurrender() {
    showModal('Точно сдаться? Вы проиграете партию.', [
        { text: 'Сдаться', cls: 'danger', action: () => {
            hideModal();
            if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'surrender' }));
            leaveToLobby();
        }},
        { text: 'Продолжить', cls: 'safe', action: hideModal }
    ]);
}

/* --- АНИМАЦИИ --- */

function animateBullet() {
    if (!bulletAnim) return;
    const t = (performance.now() - bulletAnim.start) / bulletAnim.dur;
    if (t >= 1) { bulletAnim = null; render(); return; }
    render();
    requestAnimationFrame(animateBullet);
}

function animateExplosion() {
    if (!explosionAnim) return;
    const t = (performance.now() - explosionAnim.start) / explosionAnim.dur;
    if (t >= 1) { explosionAnim = null; render(); return; }
    render();
    requestAnimationFrame(animateExplosion);
}

window.addEventListener('resize', () => { if (state) { resizeCanvas(); render(); } });
window.addEventListener('orientationchange', () => {
    setTimeout(() => { if (state) { resizeCanvas(); render(); } }, 200);
});

