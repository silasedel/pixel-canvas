'use strict';

(() => {
  // ------------------------------------------------------------ constants
  const WORLD = 16384; // world units per side
  const TILE = 512; // world units per tile
  const N = WORLD / TILE; // tiles per side
  const MIN_ZOOM = 0.04;
  const MAX_ZOOM = 16;
  const MAX_POINTS = 4000;
  const PALETTE = [
    '#1a1a1a', '#6b7280', '#e11d48', '#f97316', '#eab308', '#22c55e',
    '#14b8a6', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#92400e',
  ];
  const SIZES = [2, 5, 10, 20, 40];

  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const $ = (sel) => document.querySelector(sel);

  let W = 1;
  let H = 1;
  let dpr = 1;
  const cam = { x: WORLD / 2, y: WORLD / 2, zoom: 1 };
  const state = { tool: 'pen', color: PALETTE[0], size: SIZES[1] };

  // ------------------------------------------------------------ data
  const strokes = new Map(); // id -> committed stroke
  const order = []; // committed ids, oldest first
  const tileIndex = new Map(); // 'tx,ty' -> [stroke ids]
  const bitmaps = new Map(); // 'tx,ty' -> { cv, cx, tx, ty, res, dirty, used }
  const activeStrokes = new Map(); // id -> stroke in progress (mine + remote)
  const cursors = new Map(); // userId -> { x, y, c, t }
  const renderQueue = new Set(); // tile keys needing (re)render

  let myId = null;
  let ws = null;
  let connected = false;
  let seq = 0;
  let backoff = 1000;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  // ------------------------------------------------------------ camera
  function screenToWorld(sx, sy) {
    return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y };
  }
  const worldToScreenX = (wx) => (wx - cam.x) * cam.zoom + W / 2;
  const worldToScreenY = (wy) => (wy - cam.y) * cam.zoom + H / 2;

  function clampCam() {
    cam.zoom = clamp(cam.zoom, MIN_ZOOM, MAX_ZOOM);
    cam.x = clamp(cam.x, 0, WORLD);
    cam.y = clamp(cam.y, 0, WORLD);
  }

  let lastZoomChange = 0;
  function zoomAt(sx, sy, factor) {
    const w = screenToWorld(sx, sy);
    cam.zoom = clamp(cam.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    cam.x = w.x - (sx - W / 2) / cam.zoom;
    cam.y = w.y - (sy - H / 2) / cam.zoom;
    clampCam();
    lastZoomChange = performance.now();
    requestRender();
  }

  function setZoom(z) {
    cam.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    clampCam();
    lastZoomChange = performance.now();
    requestRender();
  }

  // ------------------------------------------------------------ geometry
  function strokeTiles(s) {
    const p = s.points;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < minX) minX = p[i];
      if (p[i] > maxX) maxX = p[i];
      if (p[i + 1] < minY) minY = p[i + 1];
      if (p[i + 1] > maxY) maxY = p[i + 1];
    }
    const r = s.size / 2 + 2;
    const tx0 = clamp(Math.floor((minX - r) / TILE), 0, N - 1);
    const tx1 = clamp(Math.floor((maxX + r) / TILE), 0, N - 1);
    const ty0 = clamp(Math.floor((minY - r) / TILE), 0, N - 1);
    const ty1 = clamp(Math.floor((maxY + r) / TILE), 0, N - 1);
    const keys = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) keys.push(`${tx},${ty}`);
    }
    return keys;
  }

  function drawStroke(c, s) {
    const p = s.points;
    if (p.length < 2) return;
    c.strokeStyle = s.erase ? '#ffffff' : s.color;
    c.fillStyle = c.strokeStyle;
    c.lineWidth = s.size;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    if (p.length === 2) {
      c.arc(p[0], p[1], s.size / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.moveTo(p[0], p[1]);
    if (p.length === 4) {
      c.lineTo(p[2], p[3]);
    } else {
      for (let i = 2; i < p.length - 2; i += 2) {
        const mx = (p[i] + p[i + 2]) / 2;
        const my = (p[i + 1] + p[i + 3]) / 2;
        c.quadraticCurveTo(p[i], p[i + 1], mx, my);
      }
      c.lineTo(p[p.length - 2], p[p.length - 1]);
    }
    c.stroke();
  }

  // ------------------------------------------------------------ stroke store
  function drawStrokeToBitmap(bm, s) {
    bm.cx.setTransform(bm.res, 0, 0, bm.res, -bm.tx * TILE * bm.res, -bm.ty * TILE * bm.res);
    drawStroke(bm.cx, s);
  }

  function commitStroke(s) {
    if (strokes.has(s.id)) return;
    strokes.set(s.id, s);
    order.push(s.id);
    s.tiles = strokeTiles(s);
    for (const k of s.tiles) {
      let arr = tileIndex.get(k);
      if (!arr) tileIndex.set(k, (arr = []));
      arr.push(s.id);
      const bm = bitmaps.get(k);
      if (bm && !bm.dirty) drawStrokeToBitmap(bm, s);
    }
    requestRender();
  }

  function removeStroke(id) {
    const s = strokes.get(id);
    if (!s) return;
    strokes.delete(id);
    const i = order.indexOf(id);
    if (i >= 0) order.splice(i, 1);
    for (const k of s.tiles) {
      const arr = tileIndex.get(k);
      if (arr) {
        const j = arr.indexOf(id);
        if (j >= 0) arr.splice(j, 1);
      }
      const bm = bitmaps.get(k);
      if (bm) bm.dirty = true;
    }
    requestRender();
  }

  function trimStrokes(n) {
    for (let i = 0; i < n && order.length; i++) removeStroke(order[0]);
  }

  function resetData() {
    strokes.clear();
    order.length = 0;
    tileIndex.clear();
    bitmaps.clear();
    activeStrokes.clear();
    cursors.clear();
    renderQueue.clear();
  }

  // ------------------------------------------------------------ tiles
  function desiredRes() {
    const raw = cam.zoom * dpr;
    const q = Math.pow(2, Math.round(Math.log2(raw)));
    return clamp(q, 1 / 16, 4);
  }

  function renderTile(key, res) {
    let bm = bitmaps.get(key);
    const px = Math.max(1, Math.ceil(TILE * res));
    if (!bm) {
      const [tx, ty] = key.split(',').map(Number);
      const cv = document.createElement('canvas');
      bm = { cv, cx: cv.getContext('2d'), tx, ty, res: 0, dirty: true, used: 0 };
      bitmaps.set(key, bm);
    }
    if (bm.cv.width !== px) {
      bm.cv.width = px;
      bm.cv.height = px;
    }
    bm.res = res;
    const c = bm.cx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, px, px);
    c.setTransform(res, 0, 0, res, -bm.tx * TILE * res, -bm.ty * TILE * res);
    const ids = tileIndex.get(key);
    if (ids) {
      for (const id of ids) {
        const s = strokes.get(id);
        if (s) drawStroke(c, s);
      }
    }
    bm.dirty = false;
  }

  function evictBitmaps() {
    if (bitmaps.size < 400) return;
    for (const [key, bm] of bitmaps) {
      if (frameNo - bm.used > 90) {
        bitmaps.delete(key);
        renderQueue.delete(key);
      }
    }
  }

  // ------------------------------------------------------------ render loop
  let renderPending = false;
  let frameNo = 0;

  function requestRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(frame);
  }

  function frame() {
    renderPending = false;
    frameNo++;
    const res = desiredRes();
    const zooming = performance.now() - lastZoomChange < 160;
    const start = performance.now();
    for (const key of renderQueue) {
      const bm = bitmaps.get(key);
      // While actively zooming keep showing the stale bitmap; it's cheaper than re-rasterizing every frame.
      if (bm && !bm.dirty && zooming) continue;
      renderTile(key, res);
      renderQueue.delete(key);
      if (performance.now() - start > 8) break;
    }
    draw();
    if (frameNo % 60 === 0) evictBitmaps();
    if (renderQueue.size || activeStrokes.size || cursors.size) requestRender();
    updateHash();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#dfe3e8';
    ctx.fillRect(0, 0, W, H);

    const x0 = worldToScreenX(0);
    const y0 = worldToScreenY(0);
    const x1 = worldToScreenX(WORLD);
    const y1 = worldToScreenY(WORLD);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

    const res = desiredRes();
    const tl = screenToWorld(0, 0);
    const br = screenToWorld(W, H);
    const tx0 = clamp(Math.floor(tl.x / TILE), 0, N - 1);
    const tx1 = clamp(Math.floor(br.x / TILE), 0, N - 1);
    const ty0 = clamp(Math.floor(tl.y / TILE), 0, N - 1);
    const ty1 = clamp(Math.floor(br.y / TILE), 0, N - 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let ty = ty0; ty <= ty1; ty++) {
      const sy0 = worldToScreenY(ty * TILE);
      const sy1 = worldToScreenY((ty + 1) * TILE);
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx},${ty}`;
        const ids = tileIndex.get(key);
        if (!ids || !ids.length) continue;
        const bm = bitmaps.get(key);
        if (!bm || bm.dirty || bm.res !== res) renderQueue.add(key);
        if (bm) {
          bm.used = frameNo;
          const sx0 = worldToScreenX(tx * TILE);
          const sx1 = worldToScreenX((tx + 1) * TILE);
          ctx.drawImage(bm.cv, sx0, sy0, sx1 - sx0, sy1 - sy0);
        }
      }
    }

    // Strokes still being drawn are vector-drawn straight onto the screen.
    if (activeStrokes.size) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);
      for (const s of activeStrokes.values()) drawStroke(ctx, s);
      ctx.restore();
    }

    // Other people's cursors.
    const now = performance.now();
    for (const [id, cur] of cursors) {
      if (now - cur.t > 8000) {
        cursors.delete(id);
        continue;
      }
      const sx = worldToScreenX(cur.x);
      const sy = worldToScreenY(cur.y);
      if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = cur.c;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    }

    zoomLabel.textContent = `${Math.round(cam.zoom * 100)}%`;
  }

  // ------------------------------------------------------------ url hash
  let lastHash = '';
  let lastHashWrite = 0;
  function updateHash() {
    const h = `#${Math.round(cam.x)},${Math.round(cam.y)},${cam.zoom.toFixed(3)}`;
    const now = performance.now();
    if (h === lastHash || now - lastHashWrite < 500) return;
    lastHash = h;
    lastHashWrite = now;
    history.replaceState(null, '', h);
  }

  function readHash() {
    const m = /^#(-?[\d.]+),(-?[\d.]+),([\d.]+)$/.exec(location.hash);
    if (!m) return;
    cam.x = Number(m[1]);
    cam.y = Number(m[2]);
    cam.zoom = Number(m[3]);
    if (![cam.x, cam.y, cam.zoom].every(Number.isFinite)) {
      cam.x = WORLD / 2;
      cam.y = WORLD / 2;
      cam.zoom = 1;
    }
    clampCam();
  }

  // ------------------------------------------------------------ drawing
  const pointers = new Map();
  let drawing = null; // { s, pending, lastX, lastY }
  let panning = null;
  let pinch = null;
  let spaceDown = false;
  let flushTimer = null;

  function startStroke(sx, sy) {
    if (!connected) {
      showBanner('Connecting to the canvas…');
      return;
    }
    const w = screenToWorld(sx, sy);
    const x = r1(clamp(w.x, 0, WORLD));
    const y = r1(clamp(w.y, 0, WORLD));
    const id = `${myId}-${(++seq).toString(36)}`;
    const s = { id, color: state.color, size: state.size, erase: state.tool === 'eraser', points: [x, y] };
    activeStrokes.set(id, s);
    drawing = { s, pending: [], lastX: x, lastY: y };
    send({ t: 'start', id, color: s.color, size: s.size, erase: s.erase, p: [x, y] });
    requestRender();
  }

  function addPoint(sx, sy) {
    if (!drawing) return;
    const w = screenToWorld(sx, sy);
    const x = r1(clamp(w.x, 0, WORLD));
    const y = r1(clamp(w.y, 0, WORLD));
    const dx = x - drawing.lastX;
    const dy = y - drawing.lastY;
    const minDist = 1.2 / cam.zoom;
    if (dx * dx + dy * dy < minDist * minDist) return;
    if (drawing.s.points.length >= MAX_POINTS * 2) {
      // Very long strokes are split so nobody hits the server limit.
      endStroke();
      startStroke(sx, sy);
      return;
    }
    drawing.lastX = x;
    drawing.lastY = y;
    drawing.s.points.push(x, y);
    drawing.pending.push(x, y);
    if (!flushTimer) flushTimer = setTimeout(flushPending, 40);
    requestRender();
  }

  function flushPending() {
    flushTimer = null;
    if (drawing && drawing.pending.length) {
      send({ t: 'move', id: drawing.s.id, p: drawing.pending });
      drawing.pending = [];
    }
  }

  function endStroke() {
    if (!drawing) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushPending();
    const s = drawing.s;
    drawing = null;
    activeStrokes.delete(s.id);
    commitStroke(s);
    send({ t: 'end', id: s.id });
  }

  // ------------------------------------------------------------ pointer input
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function startPinch() {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    pinch = { d0: Math.max(dist(a, b), 1), zoom0: cam.zoom, w0: screenToWorld(mid.x, mid.y) };
  }

  function updatePinch() {
    const [a, b] = [...pointers.values()];
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const zoom = clamp(pinch.zoom0 * (dist(a, b) / pinch.d0), MIN_ZOOM, MAX_ZOOM);
    cam.zoom = zoom;
    cam.x = pinch.w0.x - (mid.x - W / 2) / zoom;
    cam.y = pinch.w0.y - (mid.y - H / 2) / zoom;
    clampCam();
    lastZoomChange = performance.now();
    requestRender();
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (e.pointerType === 'mouse') {
      // A mouse has one pointer; drop any stale entry so it can never look like a pinch.
      for (const [id, p] of pointers) if (p.type === 'mouse') pointers.delete(id);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (pointers.size === 2) {
      if (drawing) endStroke();
      panning = null;
      canvas.classList.remove('grabbing');
      startPinch();
      return;
    }
    if (pointers.size > 2) return;
    const wantPan = state.tool === 'hand' || spaceDown || e.button === 1 || e.button === 2;
    if (wantPan) {
      panning = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y };
      canvas.classList.add('grabbing');
      return;
    }
    if (e.button !== 0) return;
    startStroke(e.clientX, e.clientY);
  });

  canvas.addEventListener('pointermove', (e) => {
    const pt = pointers.get(e.pointerId);
    if (pt) {
      pt.x = e.clientX;
      pt.y = e.clientY;
    }
    if (pinch) {
      if (pointers.size >= 2) updatePinch();
      return;
    }
    if (panning && pt) {
      cam.x = panning.cx - (e.clientX - panning.sx) / cam.zoom;
      cam.y = panning.cy - (e.clientY - panning.sy) / cam.zoom;
      clampCam();
      requestRender();
      return;
    }
    if (drawing && pt) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      if (evs.length) {
        for (const ev of evs) addPoint(ev.clientX, ev.clientY);
      } else {
        addPoint(e.clientX, e.clientY);
      }
    }
    sendCursor(e.clientX, e.clientY);
  });

  function pointerEnd(e) {
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) pinch = null;
      return;
    }
    if (panning) {
      panning = null;
      canvas.classList.remove('grabbing');
    }
    if (drawing) endStroke();
  }
  canvas.addEventListener('pointerup', pointerEnd);
  canvas.addEventListener('pointercancel', pointerEnd);
  canvas.addEventListener('lostpointercapture', pointerEnd);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      let dx = e.deltaX;
      let dy = e.deltaY;
      if (e.deltaMode === 1) {
        dx *= 16;
        dy *= 16;
      } else if (e.deltaMode === 2) {
        dx *= W;
        dy *= H;
      }
      if (e.ctrlKey || e.metaKey) {
        zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.01));
        return;
      }
      if (e.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      cam.x += dx / cam.zoom;
      cam.y += dy / cam.zoom;
      clampCam();
      requestRender();
    },
    { passive: false }
  );

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case 'p': case 'P': setTool('pen'); break;
      case 'e': case 'E': setTool('eraser'); break;
      case 'h': case 'H': setTool('hand'); break;
      case '[': stepSize(-1); break;
      case ']': stepSize(1); break;
      case '+': case '=': zoomAt(W / 2, H / 2, 1.25); break;
      case '-': case '_': zoomAt(W / 2, H / 2, 0.8); break;
      case '0': setZoom(1); break;
      case 'Escape': help.classList.add('hidden'); break;
      case ' ':
        if (!spaceDown) {
          spaceDown = true;
          canvas.classList.add('grab');
        }
        e.preventDefault();
        break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      canvas.classList.remove('grab');
    }
  });

  // ------------------------------------------------------------ network
  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  let lastCursorSend = 0;
  function sendCursor(sx, sy) {
    const now = performance.now();
    if (!connected || now - lastCursorSend < 50) return;
    lastCursorSend = now;
    const w = screenToWorld(sx, sy);
    send({ t: 'cursor', x: r1(w.x), y: r1(w.y) });
  }

  function undo() {
    if (drawing) endStroke();
    send({ t: 'undo' });
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      backoff = 1000;
    };
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      handle(m);
    };
    ws.onclose = () => {
      connected = false;
      setStatus('Reconnecting…', 'off');
      if (drawing) {
        const s = drawing.s;
        drawing = null;
        activeStrokes.delete(s.id);
        commitStroke(s);
      }
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 10000);
    };
    ws.onerror = () => ws.close();
  }

  function handle(m) {
    switch (m.t) {
      case 'init':
        resetData();
        myId = m.id;
        for (const s of m.strokes) commitStroke(s);
        for (const s of m.active) activeStrokes.set(s.id, s);
        connected = true;
        setStatus('Live', 'live');
        setUsers(m.users);
        requestRender();
        break;
      case 'start':
        activeStrokes.set(m.s.id, m.s);
        requestRender();
        break;
      case 'move': {
        const s = activeStrokes.get(m.id);
        if (s) {
          for (const v of m.p) s.points.push(v);
          requestRender();
        }
        break;
      }
      case 'end': {
        const s = activeStrokes.get(m.id);
        if (s) {
          activeStrokes.delete(m.id);
          commitStroke(s);
        }
        break;
      }
      case 'remove':
        activeStrokes.delete(m.id);
        removeStroke(m.id);
        break;
      case 'trim':
        trimStrokes(m.n);
        break;
      case 'cursor':
        cursors.set(m.id, { x: m.x, y: m.y, c: m.c, t: performance.now() });
        requestRender();
        break;
      case 'leave':
        cursors.delete(m.id);
        requestRender();
        break;
      case 'users':
        setUsers(m.n);
        break;
      default:
        break;
    }
  }

  // ------------------------------------------------------------ ui
  const help = $('#help');
  const zoomLabel = $('#zoomLabel');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const usersEl = $('#users');
  const colorPicker = $('#colorPicker');
  const customColor = $('.custom-color');
  const banner = document.createElement('div');
  banner.id = 'banner';
  document.body.appendChild(banner);
  let bannerTimer = null;

  function showBanner(text) {
    banner.textContent = text;
    banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('show'), 1800);
  }

  function setStatus(text, cls) {
    statusText.textContent = text;
    statusDot.className = `dot ${cls}`;
  }

  function setUsers(n) {
    usersEl.textContent = String(n);
  }

  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    canvas.classList.toggle('tool-hand', tool === 'hand');
    canvas.classList.toggle('tool-eraser', tool === 'eraser');
  }

  function setColor(color, fromPicker) {
    state.color = color;
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', !fromPicker && b.dataset.color === color));
    customColor.classList.toggle('active', !!fromPicker);
    if (fromPicker) colorPicker.value = color;
    if (state.tool === 'eraser') setTool('pen');
  }

  function setSize(size) {
    state.size = size;
    document.querySelectorAll('.size').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === size));
  }

  function stepSize(dir) {
    const i = clamp(SIZES.indexOf(state.size) + dir, 0, SIZES.length - 1);
    setSize(SIZES[i]);
  }

  document.querySelectorAll('#tools .tool').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.tool));
  });

  const colorsEl = $('#colors');
  for (const color of PALETTE) {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.dataset.color = color;
    b.style.background = color;
    b.title = color;
    b.setAttribute('aria-label', `Color ${color}`);
    b.addEventListener('click', () => setColor(color, false));
    colorsEl.appendChild(b);
  }
  colorPicker.addEventListener('input', () => setColor(colorPicker.value, true));

  const sizesEl = $('#sizes');
  for (const size of SIZES) {
    const b = document.createElement('button');
    b.className = 'size';
    b.dataset.size = String(size);
    b.title = `Size ${size}`;
    b.setAttribute('aria-label', `Size ${size}`);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const px = clamp(3 + size * 0.5, 4, 24);
    dot.style.width = `${px}px`;
    dot.style.height = `${px}px`;
    b.appendChild(dot);
    b.addEventListener('click', () => setSize(size));
    sizesEl.appendChild(b);
  }

  $('#undoBtn').addEventListener('click', undo);
  $('#zoomIn').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.25));
  $('#zoomOut').addEventListener('click', () => zoomAt(W / 2, H / 2, 0.8));
  zoomLabel.addEventListener('click', () => setZoom(1));
  $('#fitBtn').addEventListener('click', () => {
    cam.x = WORLD / 2;
    cam.y = WORLD / 2;
    setZoom((Math.min(W, H) / WORLD) * 0.94);
  });
  $('#helpBtn').addEventListener('click', () => help.classList.toggle('hidden'));
  $('#helpClose').addEventListener('click', () => help.classList.add('hidden'));

  // ------------------------------------------------------------ boot
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    requestRender();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('hashchange', () => {
    readHash();
    requestRender();
  });

  setTool('pen');
  setColor(PALETTE[0], false);
  setSize(SIZES[1]);
  readHash();
  resize();
  connect();
})();
