'use strict';

(() => {
  // ------------------------------------------------------------ world
  const REGION = 16384; // world units per region
  const RN = 16; // regions per side
  const WORLD = REGION * RN; // 262,144 units per side
  const TILE = 512; // render tile
  const N = WORLD / TILE;
  const STILE = 1024; // storage tile (one retained message each)
  const SN = WORLD / STILE;
  const MIN_ZOOM = 0.05;
  const MAX_ZOOM = 16;
  const MAX_POINTS = 4000;
  const TIDE_MS = 60 * 60 * 1000;
  const PALETTE = [
    '#1a1a1a', '#6b7280', '#e11d48', '#f97316', '#eab308', '#22c55e',
    '#14b8a6', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', '#92400e', 'rainbow',
  ];
  const SIZES = [2, 5, 10, 20, 40];

  const ROOT = 'pixelcanvas/v2';
  const LIVE_TOPIC = `${ROOT}/live`;
  const TILE_TOPIC = (key) => `${ROOT}/tile/${key}`;
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081',
  ];
  const TILE_BYTES_CAP = 150000;
  const DEAD_CAP = 300;

  // ------------------------------------------------------------ region effects
  const FX = {
    plain: { label: 'Open Canvas', bg: '#ffffff', desc: 'Plain white canvas. Draw whatever you like.' },
    void: { label: 'The Void', bg: '#0b0f1a', desc: 'Dark as space. Everything you draw glows.' },
    mirror: { label: 'Kaleidoscope', bg: '#f3e8ff', desc: 'Every stroke is mirrored eight ways around the center.' },
    pixel: { label: 'Pixel Land', bg: '#fefce8', desc: 'Everything snaps to a chunky grid. Pixel art only.' },
    rainbow: { label: 'Rainbow Reach', bg: '#ffffff', desc: 'Your color is ignored. Every stroke cycles the whole rainbow.' },
    tides: { label: 'The Tides', bg: '#ccfbf1', desc: 'Drawings wash away one hour after they are made.' },
    giant: { label: 'Giant Country', bg: '#fff7ed', desc: 'Brushes are five times bigger here.' },
    tiny: { label: 'Tiny Town', bg: '#f0fdf4', desc: 'Brushes are four times smaller. Zoom in.' },
    wobble: { label: 'Wobble Woods', bg: '#ecfccb', desc: 'Lines wobble like jelly.' },
    sketch: { label: 'Sketchbook', bg: '#f7f3e8', desc: 'Pencil on paper. Strokes come out rough and layered.' },
    blueprint: { label: 'Blueprint', bg: '#1e3a8a', desc: 'White ink on blue paper, whatever color you pick.' },
    invert: { label: 'Negative Zone', bg: '#111111', desc: 'Every color comes out inverted, on black.' },
    gravity: { label: 'Drip City', bg: '#fdf2f8', desc: 'Wet paint. Strokes drip downward.' },
    echo: { label: 'Echo Chamber', bg: '#eef2ff', desc: 'Strokes leave fading trails behind them.' },
    glitch: { label: 'Glitch Grid', bg: '#f1f5f9', desc: 'Lines jump and tear apart as you draw.' },
    chalk: { label: 'Chalkboard', bg: '#14532d', desc: 'Soft pastel chalk on a green board.' },
  };
  const FX_POOL = [
    'plain', 'plain', 'plain', 'plain', 'void', 'mirror', 'pixel', 'rainbow', 'tides', 'giant', 'tiny',
    'wobble', 'sketch', 'blueprint', 'invert', 'gravity', 'echo', 'glitch', 'chalk',
  ];
  const ADJ = ['Velvet', 'Neon', 'Hollow', 'Iron', 'Amber', 'Frozen', 'Crimson', 'Silent', 'Golden', 'Misty', 'Electric', 'Wild', 'Copper', 'Lunar', 'Salt', 'Ember', 'Paper', 'Glass', 'Thunder', 'Marble', 'Violet', 'Rusty', 'Coral', 'Shadow', 'Sunny', 'Static', 'Cobalt', 'Honey', 'Feral', 'Quiet', 'Jade', 'Solar'];
  const NOUN = ['Hollow', 'Reach', 'Yard', 'Fields', 'Harbor', 'Cross', 'Bend', 'Heights', 'Market', 'Orchard', 'Docks', 'Steps', 'Ridge', 'Basin', 'Alley', 'Gardens', 'Row', 'Point', 'Quarter', 'Meadow', 'Bluff', 'Springs', 'Vault', 'Terrace', 'Pass', 'Hill', 'Shore', 'Lane', 'Grove', 'Plaza', 'Falls', 'Wharf'];

  function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const REGIONS = [];
  {
    const used = new Set();
    for (let ry = 0; ry < RN; ry++) {
      for (let rx = 0; rx < RN; rx++) {
        const r = rng(hash32(`region:${rx}:${ry}`));
        let fx = FX_POOL[Math.floor(r() * FX_POOL.length)];
        let name = `${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}`;
        while (used.has(name)) name = `${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}`;
        const spawnDist = Math.max(Math.abs(rx - 8), Math.abs(ry - 8));
        if (spawnDist === 0) {
          fx = 'plain';
          name = 'The Commons';
        } else if (spawnDist === 1 && fx !== 'plain' && r() < 0.5) {
          fx = 'plain';
        }
        used.add(name);
        REGIONS.push({ rx, ry, x: rx * REGION, y: ry * REGION, name, fx, ...FX[fx] });
      }
    }
  }
  const isDark = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    const l = 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
    return l < 128;
  };
  function regionAt(x, y) {
    const rx = clamp(Math.floor(x / REGION), 0, RN - 1);
    const ry = clamp(Math.floor(y / REGION), 0, RN - 1);
    return REGIONS[ry * RN + rx];
  }

  // ------------------------------------------------------------ state
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const $ = (sel) => document.querySelector(sel);

  let W = 1;
  let H = 1;
  let dpr = 1;
  const cam = { x: REGION * 8.5, y: REGION * 8.5, zoom: 1 };
  const state = { tool: 'pen', color: PALETTE[0], size: SIZES[1] };

  const strokes = new Map(); // id -> committed stroke
  const order = [];
  const tileIndex = new Map(); // render tile key -> [ids]
  const bitmaps = new Map(); // render tile key -> bitmap
  const activeStrokes = new Map();
  const cursors = new Map();
  const renderQueue = new Set();
  const store = new Map(); // storage key -> record
  const mine = [];
  const users = new Map();
  const myId = Math.random().toString(36).slice(2, 10);
  let connected = false;
  let seq = 0;
  let liveSeq = 0;

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }
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
  function teleport(region) {
    cam.x = region.x + REGION / 2;
    cam.y = region.y + REGION / 2;
    setZoom(clamp((Math.min(W, H) / REGION) * 0.92, MIN_ZOOM, 1));
    showBanner(`${region.name} · ${region.label}`);
  }

  // ------------------------------------------------------------ stroke styling
  function effSize(s, reg) {
    let w = s.size;
    if (reg.fx === 'giant') w *= 5;
    else if (reg.fx === 'tiny') w = Math.max(0.6, w * 0.25);
    else if (reg.fx === 'pixel') w = Math.max(32, Math.round(w / 10) * 32);
    return w;
  }
  function invertHex(hex) {
    const n = parseInt(hex.slice(1), 16);
    const v = 0xffffff ^ n;
    return `#${v.toString(16).padStart(6, '0')}`;
  }
  function pastel(hex) {
    const n = parseInt(hex.slice(1), 16);
    const mix = (c) => Math.round(c * 0.55 + 255 * 0.45);
    return `rgb(${mix(n >> 16)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }
  function strokeColor(s, reg) {
    if (s.erase) return reg.bg;
    if (reg.fx === 'blueprint') return '#e0f2fe';
    if (s.color === 'rainbow') return '#f43f5e';
    if (reg.fx === 'invert') return invertHex(s.color);
    if (reg.fx === 'chalk') return pastel(s.color);
    return s.color;
  }

  function wobblePoints(p, w) {
    const out = new Array(p.length);
    const amp = w * 0.6 + 2;
    for (let i = 0; i < p.length; i += 2) {
      out[i] = p[i] + Math.sin(p[i + 1] / 24) * amp;
      out[i + 1] = p[i + 1] + Math.cos(p[i] / 24) * amp;
    }
    return out;
  }
  function glitchPoints(p, w, id) {
    const r = rng(hash32(id));
    const out = new Array(p.length);
    let ox = 0;
    for (let i = 0; i < p.length; i += 2) {
      if (i % 12 === 0) ox = r() < 0.45 ? (r() - 0.5) * Math.max(w * 6, 30) : 0;
      out[i] = p[i] + ox;
      out[i + 1] = p[i + 1];
    }
    return out;
  }

  function polyline(c, p) {
    c.beginPath();
    if (p.length === 2) {
      c.arc(p[0], p[1], c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    c.moveTo(p[0], p[1]);
    if (p.length === 4) {
      c.lineTo(p[2], p[3]);
    } else {
      for (let i = 2; i < p.length - 2; i += 2) {
        c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
      }
      c.lineTo(p[p.length - 2], p[p.length - 1]);
    }
    c.stroke();
  }

  function path(c, p, w, color, rainbow, id) {
    c.lineWidth = w;
    if (!rainbow) {
      c.strokeStyle = color;
      c.fillStyle = color;
      polyline(c, p);
      return;
    }
    const base = hash32(id) % 360;
    if (p.length === 2) {
      c.fillStyle = `hsl(${base} 90% 55%)`;
      polyline(c, p);
      return;
    }
    let len = 0;
    for (let i = 2; i < p.length; i += 2) {
      const dx = p[i] - p[i - 2];
      const dy = p[i + 1] - p[i - 1];
      len += Math.hypot(dx, dy);
      c.strokeStyle = `hsl(${(base + len * 0.9) % 360} 90% 55%)`;
      c.beginPath();
      c.moveTo(p[i - 2], p[i - 1]);
      c.lineTo(p[i], p[i + 1]);
      c.stroke();
    }
  }

  function drawBlocks(c, p, w, color, rainbow, id) {
    const grid = 32;
    const half = w / 2;
    const done = new Set();
    const base = hash32(id) % 360;
    let len = 0;
    c.fillStyle = color;
    const fillAt = (x, y) => {
      const cx = Math.floor(x / grid);
      const cy = Math.floor(y / grid);
      const key = cx * 100000 + cy;
      if (done.has(key)) return;
      done.add(key);
      if (rainbow) c.fillStyle = `hsl(${(base + len * 0.9) % 360} 90% 55%)`;
      c.fillRect(cx * grid + grid / 2 - half, cy * grid + grid / 2 - half, w, w);
    };
    fillAt(p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) {
      const x0 = p[i - 2];
      const y0 = p[i - 1];
      const dx = p[i] - x0;
      const dy = p[i + 1] - y0;
      const d = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.ceil(d / (grid / 2)));
      for (let k = 1; k <= steps; k++) {
        len += d / steps;
        fillAt(x0 + (dx * k) / steps, y0 + (dy * k) / steps);
      }
    }
  }

  function drawSpray(c, p, w, color, id, rainbow) {
    const r = rng(hash32(id) ^ 0x5bd1e995);
    const base = hash32(id) % 360;
    const radius = w * 1.4 + 2;
    c.fillStyle = color;
    for (let i = 0; i < p.length; i += 2) {
      if (rainbow) c.fillStyle = `hsl(${(base + i * 6) % 360} 90% 55%)`;
      for (let k = 0; k < 6; k++) {
        const a = r() * Math.PI * 2;
        const d = Math.sqrt(r()) * radius;
        const dot = w * 0.06 + r() * w * 0.14 + 0.4;
        c.beginPath();
        c.arc(p[i] + Math.cos(a) * d, p[i + 1] + Math.sin(a) * d, dot, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  function drawDrips(c, p, w, color) {
    const r = rng(hash32(color + p.length) ^ 0x9e3779b9);
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = Math.max(1, w * 0.35);
    for (let i = 0; i < p.length; i += 2) {
      if (r() > 0.18 && i < p.length - 2) continue;
      const len = Math.max(w, 6) * (2 + r() * 8);
      c.beginPath();
      c.moveTo(p[i], p[i + 1]);
      c.lineTo(p[i], p[i + 1] + len);
      c.stroke();
      c.beginPath();
      c.arc(p[i], p[i + 1] + len, w * 0.3, 0, Math.PI * 2);
      c.fill();
    }
  }

  function drawStyled(c, s, reg, res) {
    const fx = reg.fx;
    const w = effSize(s, reg);
    const color = strokeColor(s, reg);
    const rainbow = !s.erase && (fx === 'rainbow' || s.color === 'rainbow');
    let pts = s.points;
    if (fx === 'wobble') pts = wobblePoints(pts, w);
    else if (fx === 'glitch') pts = glitchPoints(pts, w, s.id);
    c.lineCap = fx === 'pixel' ? 'square' : 'round';
    c.lineJoin = fx === 'pixel' ? 'miter' : 'round';
    if (fx === 'void' && !s.erase) {
      c.shadowColor = rainbow ? '#ffffff' : color;
      c.shadowBlur = w * 1.5 * res;
    }
    if (fx === 'pixel') {
      drawBlocks(c, pts, w, color, rainbow, s.id);
      return;
    }
    if (s.k === 's') {
      drawSpray(c, pts, w, color, s.id, rainbow);
      return;
    }
    if (fx === 'echo' && !s.erase) {
      const a0 = c.globalAlpha;
      for (const [k, a] of [[3, 0.15], [2, 0.3], [1, 0.5]]) {
        c.save();
        c.globalAlpha = a0 * a;
        c.translate(k * Math.max(w * 0.9, 6), k * Math.max(w * 0.9, 6));
        path(c, pts, w, color, rainbow, s.id);
        c.restore();
      }
    }
    if (fx === 'sketch' && !s.erase) {
      const r = rng(hash32(s.id));
      c.globalAlpha *= 0.45;
      for (let i = 0; i < 3; i++) {
        c.save();
        c.translate((r() - 0.5) * w * 1.2, (r() - 0.5) * w * 1.2);
        path(c, pts, w * 0.7, color, rainbow, s.id);
        c.restore();
      }
      return;
    }
    path(c, pts, w, color, rainbow, s.id);
    if (fx === 'gravity' && !s.erase) drawDrips(c, pts, w, rainbow ? `hsl(${hash32(s.id) % 360} 90% 55%)` : color);
  }

  function drawStroke(c, s, res) {
    const p = s.points;
    if (p.length < 2) return;
    const reg = s.region || (s.region = regionAt(p[0], p[1]));
    let alpha = 1;
    if (reg.fx === 'tides') {
      alpha = 1 - (Date.now() - s.t) / TIDE_MS;
      if (alpha <= 0) return;
    }
    c.save();
    c.globalAlpha = alpha;
    if (reg.fx === 'mirror') {
      const cx = reg.x + REGION / 2;
      const cy = reg.y + REGION / 2;
      for (let k = 0; k < 4; k++) {
        for (let m = 0; m < 2; m++) {
          c.save();
          c.translate(cx, cy);
          c.rotate((k * Math.PI) / 2);
          if (m) c.scale(-1, 1);
          c.translate(-cx, -cy);
          drawStyled(c, s, reg, res);
          c.restore();
        }
      }
    } else {
      drawStyled(c, s, reg, res);
    }
    c.restore();
  }

  // ------------------------------------------------------------ geometry
  function strokeBounds(s) {
    const p = s.points;
    const reg = s.region || (s.region = regionAt(p[0], p[1]));
    const w = effSize(s, reg);
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
    let pad = w / 2 + 3;
    switch (reg.fx) {
      case 'void': pad += w * 2; break;
      case 'wobble': pad += w + 2; break;
      case 'glitch': pad += Math.max(w * 3, 16); break;
      case 'sketch': pad += w; break;
      case 'pixel': pad += 40; break;
      default: break;
    }
    if (s.k === 's') pad += w * 1.5 + 2;
    minX -= pad;
    minY -= pad;
    maxX += pad;
    maxY += pad;
    if (reg.fx === 'echo') {
      maxX += Math.max(w * 0.9, 6) * 3.5;
      maxY += Math.max(w * 0.9, 6) * 3.5;
    }
    if (reg.fx === 'gravity') maxY += Math.max(w, 6) * 11;
    if (reg.fx === 'mirror') {
      const cx = reg.x + REGION / 2;
      const cy = reg.y + REGION / 2;
      const corners = [[minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY]];
      let a = Infinity;
      let b = Infinity;
      let cMax = -Infinity;
      let d = -Infinity;
      for (let k = 0; k < 4; k++) {
        for (let m = 0; m < 2; m++) {
          for (const [x, y] of corners) {
            let tx = x - cx;
            let ty = y - cy;
            if (m) tx = -tx;
            for (let i = 0; i < k; i++) {
              const nx = -ty;
              ty = tx;
              tx = nx;
            }
            const fx = tx + cx;
            const fy = ty + cy;
            if (fx < a) a = fx;
            if (fy < b) b = fy;
            if (fx > cMax) cMax = fx;
            if (fy > d) d = fy;
          }
        }
      }
      minX = a;
      minY = b;
      maxX = cMax;
      maxY = d;
    }
    return { minX, minY, maxX, maxY };
  }

  function tilesFor(bounds, size, count, sep) {
    const x0 = clamp(Math.floor(bounds.minX / size), 0, count - 1);
    const x1 = clamp(Math.floor(bounds.maxX / size), 0, count - 1);
    const y0 = clamp(Math.floor(bounds.minY / size), 0, count - 1);
    const y1 = clamp(Math.floor(bounds.maxY / size), 0, count - 1);
    const keys = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) keys.push(`${x}${sep}${y}`);
    return keys;
  }

  // ------------------------------------------------------------ stroke store
  function drawStrokeToBitmap(bm, s) {
    bm.cx.setTransform(bm.res, 0, 0, bm.res, -bm.tx * TILE * bm.res, -bm.ty * TILE * bm.res);
    drawStroke(bm.cx, s, bm.res);
  }

  function commitStroke(s) {
    if (strokes.has(s.id)) return;
    strokes.set(s.id, s);
    order.push(s.id);
    const b = strokeBounds(s);
    s.tiles = tilesFor(b, TILE, N, ',');
    s.stiles = tilesFor({ minX: s.points[0], minY: s.points[1], maxX: s.points[0], maxY: s.points[1] }, STILE, SN, '_');
    for (const k of s.stiles) tileRec(k).ids.add(s.id);
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
    for (const k of s.stiles || []) {
      const rec = store.get(k);
      if (rec) rec.ids.delete(id);
    }
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

  function tileRec(key) {
    let rec = store.get(key);
    if (!rec) {
      rec = { ids: new Set(), dead: new Set(), deadList: [], min: 0, pubTimer: null, lastPub: 0, lastPayload: '' };
      store.set(key, rec);
    }
    return rec;
  }

  function tombstone(rec, id) {
    if (rec.dead.has(id)) return;
    rec.dead.add(id);
    rec.deadList.push(id);
    while (rec.deadList.length > DEAD_CAP) rec.dead.delete(rec.deadList.shift());
  }

  function deleteStroke(id) {
    const s = strokes.get(id);
    if (!s) return;
    for (const k of s.stiles) {
      tombstone(tileRec(k), id);
      schedulePublish(k);
    }
    removeStroke(id);
  }

  const isExpired = (s) => s.region && s.region.fx === 'tides' && Date.now() - s.t > TIDE_MS;

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
    c.fillStyle = regionAt(bm.tx * TILE, bm.ty * TILE).bg;
    c.fillRect(0, 0, px, px);
    c.setTransform(res, 0, 0, res, -bm.tx * TILE * res, -bm.ty * TILE * res);
    const ids = tileIndex.get(key);
    if (ids) {
      for (const id of ids) {
        const s = strokes.get(id);
        if (s) drawStroke(c, s, res);
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

  let lastError = null;
  function frame() {
    renderPending = false;
    try {
      frameBody();
    } catch (err) {
      lastError = err;
      console.error('render error', err);
      setTimeout(requestRender, 250);
    }
  }

  function frameBody() {
    frameNo++;
    const res = desiredRes();
    const zooming = performance.now() - lastZoomChange < 160;
    const start = performance.now();
    for (const key of renderQueue) {
      const bm = bitmaps.get(key);
      if (bm && !bm.dirty && zooming) continue;
      renderTile(key, res);
      renderQueue.delete(key);
      if (performance.now() - start > 8) break;
    }
    draw();
    if (frameNo % 60 === 0) evictBitmaps();
    if (renderQueue.size || activeStrokes.size || cursors.size) requestRender();
    updateHash();
    updateRegionPill();
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(0, 0, W, H);

    const tl = screenToWorld(0, 0);
    const br = screenToWorld(W, H);
    const rx0 = clamp(Math.floor(tl.x / REGION), 0, RN - 1);
    const rx1 = clamp(Math.floor(br.x / REGION), 0, RN - 1);
    const ry0 = clamp(Math.floor(tl.y / REGION), 0, RN - 1);
    const ry1 = clamp(Math.floor(br.y / REGION), 0, RN - 1);
    for (let ry = ry0; ry <= ry1; ry++) {
      for (let rx = rx0; rx <= rx1; rx++) {
        const reg = REGIONS[ry * RN + rx];
        const sx0 = worldToScreenX(reg.x);
        const sy0 = worldToScreenY(reg.y);
        const sx1 = worldToScreenX(reg.x + REGION);
        const sy1 = worldToScreenY(reg.y + REGION);
        ctx.fillStyle = reg.bg;
        ctx.fillRect(sx0, sy0, sx1 - sx0, sy1 - sy0);
      }
    }

    wantStorage(tl, br);
    const res = desiredRes();
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

    // Region borders and, when zoomed out, their names.
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.18)';
    ctx.lineWidth = 1;
    for (let rx = rx0; rx <= rx1 + 1; rx++) {
      const sx = Math.round(worldToScreenX(rx * REGION)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, H);
      ctx.stroke();
    }
    for (let ry = ry0; ry <= ry1 + 1; ry++) {
      const sy = Math.round(worldToScreenY(ry * REGION)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, sy);
      ctx.lineTo(W, sy);
      ctx.stroke();
    }
    if (cam.zoom < 0.35) {
      const fs = clamp(REGION * cam.zoom * 0.05, 11, 40);
      ctx.font = `700 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let ry = ry0; ry <= ry1; ry++) {
        for (let rx = rx0; rx <= rx1; rx++) {
          const reg = REGIONS[ry * RN + rx];
          const cx = worldToScreenX(reg.x + REGION / 2);
          const cy = worldToScreenY(reg.y + REGION / 2);
          ctx.fillStyle = isDark(reg.bg) ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.32)';
          ctx.fillText(reg.name, cx, cy - fs * 0.6);
          ctx.font = `500 ${fs * 0.7}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`;
          ctx.fillText(reg.label, cx, cy + fs * 0.6);
          ctx.font = `700 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`;
        }
      }
    }

    if (activeStrokes.size) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(worldToScreenX(0), worldToScreenY(0), WORLD * cam.zoom, WORLD * cam.zoom);
      ctx.clip();
      ctx.translate(W / 2, H / 2);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);
      for (const s of activeStrokes.values()) drawStroke(ctx, s, cam.zoom * dpr);
      ctx.restore();
    }

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
      cam.x = REGION * 8.5;
      cam.y = REGION * 8.5;
      cam.zoom = 1;
    }
    clampCam();
  }

  // ------------------------------------------------------------ drawing
  const pointers = new Map();
  let drawing = null;
  let panning = null;
  let pinch = null;
  let spaceDown = false;
  let flushTimer = null;

  function startStroke(sx, sy) {
    const w = screenToWorld(sx, sy);
    const x = r1(clamp(w.x, 0, WORLD));
    const y = r1(clamp(w.y, 0, WORLD));
    const id = `${myId}-${(++seq).toString(36)}`;
    const s = { id, color: state.color, size: state.size, erase: state.tool === 'eraser', points: [x, y], t: Date.now() };
    if (state.tool === 'spray') s.k = 's';
    s.region = regionAt(x, y);
    activeStrokes.set(id, s);
    drawing = { s, pending: [], lastX: x, lastY: y };
    sendLive({ t: 'start', id, c: s.color, w: s.size, e: s.erase ? 1 : 0, k: s.k, p: [x, y] });
    requestRender();
  }

  function addPoint(sx, sy) {
    if (!drawing) return;
    const w = screenToWorld(sx, sy);
    const x = r1(clamp(w.x, 0, WORLD));
    const y = r1(clamp(w.y, 0, WORLD));
    const dx = x - drawing.lastX;
    const dy = y - drawing.lastY;
    const minDist = (drawing.s.k === 's' ? 3 : 1.2) / cam.zoom;
    if (dx * dx + dy * dy < minDist * minDist) return;
    if (drawing.s.points.length >= MAX_POINTS * 2) {
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
      sendLive({ t: 'move', id: drawing.s.id, p: drawing.pending });
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
    mine.push(s.id);
    if (mine.length > 500) mine.shift();
    for (const k of s.stiles) schedulePublish(k);
    sendLive({ t: 'end', s: packStroke(s) });
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
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    if (e.pointerType === 'mouse') {
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
      if (evs.length) for (const ev of evs) addPoint(ev.clientX, ev.clientY);
      else addPoint(e.clientX, e.clientY);
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
      case 's': case 'S': setTool('spray'); break;
      case 'e': case 'E': setTool('eraser'); break;
      case 'h': case 'H': setTool('hand'); break;
      case 'm': case 'M': toggleMap(); break;
      case 'r': case 'R': randomTeleport(); break;
      case 'f': case 'F': teleport(regionAt(cam.x, cam.y)); break;
      case '[': stepSize(-1); break;
      case ']': stepSize(1); break;
      case '+': case '=': zoomAt(W / 2, H / 2, 1.25); break;
      case '-': case '_': zoomAt(W / 2, H / 2, 0.8); break;
      case '0': setZoom(1); break;
      case 'Escape': help.classList.add('hidden'); map.classList.add('hidden'); break;
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

  // ------------------------------------------------------------ network (MQTT)
  const links = BROKERS.map((url) => ({ url, client: null, ready: false }));
  const subscribed = new Map();
  const seenLive = new Set();
  const seenLiveList = [];

  function readyLinks() {
    return links.filter((l) => l.ready);
  }

  function publish(topic, payload, opts) {
    let sent = false;
    for (const l of readyLinks()) {
      try {
        l.client.publish(topic, payload, opts);
        sent = true;
      } catch {
        /* another broker will carry it */
      }
    }
    return sent;
  }

  function sendLive(msg) {
    msg.u = myId;
    msg.n = ++liveSeq;
    publish(LIVE_TOPIC, JSON.stringify(msg), { qos: 0, retain: false });
  }

  let lastCursorSend = 0;
  function sendCursor(sx, sy) {
    const now = performance.now();
    if (!connected || now - lastCursorSend < 100) return;
    lastCursorSend = now;
    const w = screenToWorld(sx, sy);
    sendLive({ t: 'cursor', x: r1(w.x), y: r1(w.y), c: state.color === 'rainbow' ? '#f43f5e' : state.color });
  }

  function sendHello() {
    sendLive({ t: 'hello' });
  }

  function undo() {
    if (drawing) endStroke();
    while (mine.length) {
      const id = mine.pop();
      if (strokes.has(id)) {
        deleteStroke(id);
        sendLive({ t: 'remove', id });
        return;
      }
    }
    showBanner('Nothing of yours to undo');
  }

  function packPoints(p) {
    const out = [];
    let px = 0;
    let py = 0;
    for (let i = 0; i < p.length; i += 2) {
      const x = Math.round(p[i] * 10);
      const y = Math.round(p[i + 1] * 10);
      out.push(x - px, y - py);
      px = x;
      py = y;
    }
    return out;
  }
  function unpackPoints(d) {
    const out = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i + 1 < d.length; i += 2) {
      x += d[i];
      y += d[i + 1];
      out.push(clamp(x / 10, 0, WORLD), clamp(y / 10, 0, WORLD));
    }
    return out;
  }
  function packStroke(s) {
    const o = { i: s.id, c: s.color, w: s.size, t: s.t, p: packPoints(s.points) };
    if (s.erase) o.e = 1;
    if (s.k) o.k = s.k;
    return o;
  }
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  function unpackStroke(o) {
    if (!o || typeof o.i !== 'string' || o.i.length > 40 || !Array.isArray(o.p)) return null;
    const points = unpackPoints(o.p.filter((v) => typeof v === 'number' && Number.isFinite(v)));
    if (points.length < 2 || points.length > MAX_POINTS * 2) return null;
    const s = {
      id: o.i,
      color: o.c === 'rainbow' ? 'rainbow' : COLOR_RE.test(o.c) ? o.c.toLowerCase() : '#1a1a1a',
      size: clamp(Number(o.w) || 5, 1, 64),
      erase: !!o.e,
      t: Number(o.t) || 0,
      points,
    };
    if (o.k === 's') s.k = 's';
    s.region = regionAt(points[0], points[1]);
    return s;
  }

  function wantStorage(tl, br) {
    const margin = STILE;
    const x0 = clamp(Math.floor((tl.x - margin) / STILE), 0, SN - 1);
    const x1 = clamp(Math.floor((br.x + margin) / STILE), 0, SN - 1);
    const y0 = clamp(Math.floor((tl.y - margin) / STILE), 0, SN - 1);
    const y1 = clamp(Math.floor((br.y + margin) / STILE), 0, SN - 1);
    const now = performance.now();
    const fresh = [];
    const want = (x, y) => {
      const key = `${x}_${y}`;
      if (!subscribed.has(key)) fresh.push(key);
      subscribed.set(key, now);
    };
    const perRegion = REGION / STILE;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        want(x, y);
        // In a Kaleidoscope region a stroke drawn anywhere shows up in eight places,
        // so also follow the tiles that mirror onto this one.
        if (regionAt(x * STILE, y * STILE).fx === 'mirror') {
          const bx = Math.floor(x / perRegion) * perRegion;
          const by = Math.floor(y / perRegion) * perRegion;
          let lx = x - bx;
          let ly = y - by;
          for (let k = 0; k < 4; k++) {
            want(bx + lx, by + ly);
            want(bx + (perRegion - 1 - lx), by + ly);
            const nx = perRegion - 1 - ly;
            ly = lx;
            lx = nx;
          }
        }
      }
    }
    if (fresh.length) subscribeTopics(fresh.map(TILE_TOPIC));
  }
  function refreshSubscriptions() {
    wantStorage(screenToWorld(0, 0), screenToWorld(W, H));
  }
  function subscribeTopics(topics) {
    for (const l of readyLinks()) {
      try {
        l.client.subscribe(topics, { qos: 0 });
      } catch {
        /* retried on reconnect */
      }
    }
  }

  setInterval(() => {
    refreshSubscriptions();
    const now = performance.now();
    const stale = [];
    for (const [key, t] of subscribed) {
      if (now - t > 20000) {
        stale.push(key);
        subscribed.delete(key);
      }
    }
    if (stale.length) {
      for (const l of readyLinks()) {
        try {
          l.client.unsubscribe(stale.map(TILE_TOPIC));
        } catch {
          /* ignore */
        }
      }
    }
  }, 5000);

  // The Tides: expire old strokes, and keep fading tiles fresh.
  setInterval(() => {
    for (const s of [...strokes.values()]) {
      if (isExpired(s)) {
        removeStroke(s.id);
        for (const k of s.stiles) if (subscribed.has(k)) schedulePublish(k);
      }
    }
    for (const bm of bitmaps.values()) {
      if (regionAt(bm.tx * TILE, bm.ty * TILE).fx === 'tides') bm.dirty = true;
    }
    requestRender();
  }, 60000);

  function schedulePublish(key) {
    const rec = tileRec(key);
    if (rec.pubTimer) return;
    const wait = Math.max(400, 1500 - (performance.now() - rec.lastPub));
    rec.pubTimer = setTimeout(() => {
      rec.pubTimer = null;
      publishTile(key);
    }, wait);
  }

  function publishTile(key) {
    const rec = tileRec(key);
    let list = [...rec.ids].map((id) => strokes.get(id)).filter(Boolean);
    list.sort((a, b) => a.t - b.t);
    let body = { v: 1, m: rec.min, d: rec.deadList.slice(-DEAD_CAP), s: list.map(packStroke) };
    let payload = JSON.stringify(body);
    while (payload.length > TILE_BYTES_CAP && list.length > 1) {
      const dropped = list.splice(0, Math.max(1, Math.floor(list.length * 0.15)));
      rec.min = list[0].t;
      for (const s of dropped) removeStroke(s.id);
      body = { v: 1, m: rec.min, d: rec.deadList.slice(-DEAD_CAP), s: list.map(packStroke) };
      payload = JSON.stringify(body);
    }
    rec.lastPub = performance.now();
    rec.lastPayload = payload;
    if (!publish(TILE_TOPIC(key), payload, { qos: 1, retain: true })) {
      setTimeout(() => schedulePublish(key), 3000);
    }
  }

  function mergeTile(key, payload) {
    const rec = tileRec(key);
    if (!payload) return;
    if (payload === rec.lastPayload) return;
    let body;
    try {
      body = JSON.parse(payload);
    } catch {
      return;
    }
    if (!body || !Array.isArray(body.s)) return;
    rec.lastPayload = payload;
    let needPublish = false;
    if (typeof body.m === 'number' && body.m > rec.min) rec.min = body.m;
    if (Array.isArray(body.d)) {
      for (const id of body.d) {
        if (typeof id !== 'string') continue;
        if (!rec.dead.has(id)) tombstone(rec, id);
        if (strokes.has(id)) removeStroke(id);
      }
    }
    const seen = new Set();
    for (const o of body.s) {
      const s = unpackStroke(o);
      if (!s) continue;
      if (rec.dead.has(s.id)) {
        needPublish = true;
        continue;
      }
      if (s.t < rec.min || isExpired(s)) continue;
      seen.add(s.id);
      if (!strokes.has(s.id)) commitStroke(s);
      rec.ids.add(s.id);
    }
    for (const id of [...rec.ids]) {
      if (seen.has(id)) continue;
      const s = strokes.get(id);
      if (!s) {
        rec.ids.delete(id);
        continue;
      }
      if (s.t < rec.min) {
        removeStroke(id);
        continue;
      }
      needPublish = true;
    }
    if (needPublish) schedulePublish(key);
  }

  function onLive(payload) {
    let m;
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (!m || typeof m.u !== 'string' || m.u === myId) return;
    const dedupe = `${m.u}:${m.n}`;
    if (seenLive.has(dedupe)) return;
    seenLive.add(dedupe);
    seenLiveList.push(dedupe);
    while (seenLiveList.length > 4000) seenLive.delete(seenLiveList.shift());
    users.set(m.u, performance.now());
    switch (m.t) {
      case 'start': {
        const s = unpackStroke({ i: m.id, c: m.c, w: m.w, e: m.e, k: m.k, t: Date.now(), p: packPoints(Array.isArray(m.p) ? m.p.slice(0, 2) : []) });
        if (!s || !s.id.startsWith(`${m.u}-`)) return;
        activeStrokes.set(s.id, s);
        requestRender();
        break;
      }
      case 'move': {
        const s = activeStrokes.get(m.id);
        if (!s || !Array.isArray(m.p) || s.points.length >= MAX_POINTS * 2) return;
        for (let i = 0; i + 1 < m.p.length; i += 2) {
          const x = m.p[i];
          const y = m.p[i + 1];
          if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
            s.points.push(clamp(x, 0, WORLD), clamp(y, 0, WORLD));
          }
        }
        requestRender();
        break;
      }
      case 'end': {
        const s = unpackStroke(m.s);
        if (!s || !s.id.startsWith(`${m.u}-`)) return;
        activeStrokes.delete(s.id);
        commitStroke(s);
        break;
      }
      case 'remove':
        if (typeof m.id === 'string' && m.id.startsWith(`${m.u}-`)) {
          activeStrokes.delete(m.id);
          const s = strokes.get(m.id);
          if (s) {
            for (const k of s.stiles) tombstone(tileRec(k), m.id);
            removeStroke(m.id);
          }
        }
        break;
      case 'cursor':
        if (typeof m.x === 'number' && typeof m.y === 'number') {
          cursors.set(m.u, { x: m.x, y: m.y, c: COLOR_RE.test(m.c) ? m.c : '#1a1a1a', t: performance.now() });
          requestRender();
        }
        break;
      default:
        break;
    }
    updateUsers();
  }

  function onMessage(topic, buf) {
    const payload = buf.toString();
    if (topic === LIVE_TOPIC) {
      onLive(payload);
      return;
    }
    if (topic.startsWith(`${ROOT}/tile/`)) mergeTile(topic.slice(ROOT.length + 6), payload);
  }

  function connect() {
    if (typeof mqtt === 'undefined') {
      setStatus('Offline: library failed to load', 'off');
      return;
    }
    for (const l of links) {
      let client;
      try {
        client = mqtt.connect(l.url, {
          connectTimeout: 8000,
          reconnectPeriod: 5000,
          keepalive: 30,
          clean: true,
          clientId: `pxc_${myId}_${Math.random().toString(36).slice(2, 6)}`,
        });
      } catch {
        continue;
      }
      l.client = client;
      client.on('connect', () => {
        l.ready = true;
        try {
          client.subscribe([LIVE_TOPIC, ...[...subscribed.keys()].map(TILE_TOPIC)], { qos: 0 });
        } catch {
          /* ignore */
        }
        updateConnection();
        sendHello();
      });
      client.on('message', onMessage);
      client.on('close', () => {
        l.ready = false;
        updateConnection();
      });
      client.on('error', () => {});
    }
  }

  function updateConnection() {
    connected = readyLinks().length > 0;
    setStatus(connected ? 'Live' : 'Reconnecting…', connected ? 'live' : 'off');
    updateUsers();
  }
  function updateUsers() {
    const now = performance.now();
    let n = 1;
    for (const [id, t] of users) {
      if (now - t > 45000) users.delete(id);
      else n++;
    }
    setUsers(n);
  }
  setInterval(() => {
    if (connected) sendHello();
    updateUsers();
  }, 15000);

  window.__pixelCanvas = {
    get strokes() { return strokes.size; },
    get brokers() { return readyLinks().map((l) => l.url); },
    get id() { return myId; },
    get subscribed() { return subscribed.size; },
    get region() { return regionAt(cam.x, cam.y); },
    get queue() { return renderQueue.size; },
    get bitmaps() { return bitmaps.size; },
    get lastError() { return lastError && String(lastError.stack || lastError); },
    get frameNo() { return frameNo; },
    get pending() { return renderPending; },
    strokeInfo: (id) => { const s = strokes.get(id); return s && { tiles: s.tiles, stiles: s.stiles, bitmaps: s.tiles.map((k) => { const b = bitmaps.get(k); return b ? `${k}:res${b.res}:${b.dirty ? 'dirty' : 'ok'}` : `${k}:none`; }), fx: s.region.fx }; },
    lastStroke: () => order[order.length - 1],
    regions: REGIONS,
    cam,
    teleport: (rx, ry) => teleport(REGIONS[ry * RN + rx]),
  };

  // ------------------------------------------------------------ ui
  const help = $('#help');
  const map = $('#map');
  const zoomLabel = $('#zoomLabel');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const usersEl = $('#users');
  const colorPicker = $('#colorPicker');
  const customColor = $('.custom-color');
  const regionName = $('#regionName');
  const regionFx = $('#regionFx');
  const banner = document.createElement('div');
  banner.id = 'banner';
  document.body.appendChild(banner);
  let bannerTimer = null;

  function showBanner(text) {
    banner.textContent = text;
    banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('show'), 2200);
  }
  function setStatus(text, cls) {
    statusText.textContent = text;
    statusDot.className = `dot ${cls}`;
  }
  function setUsers(n) {
    usersEl.textContent = String(n);
  }

  let pillRegion = null;
  function updateRegionPill() {
    const reg = regionAt(cam.x, cam.y);
    if (reg === pillRegion) return;
    pillRegion = reg;
    regionName.textContent = reg.name;
    regionFx.textContent = `${reg.label} · ${reg.desc}`;
    for (const cell of mapGrid.children) cell.classList.toggle('here', cell.dataset.i === String(REGIONS.indexOf(reg)));
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
    if (state.tool === 'eraser' || state.tool === 'hand') setTool('pen');
  }
  function setSize(size) {
    state.size = size;
    document.querySelectorAll('.size').forEach((b) => b.classList.toggle('active', Number(b.dataset.size) === size));
  }
  function stepSize(dir) {
    setSize(SIZES[clamp(SIZES.indexOf(state.size) + dir, 0, SIZES.length - 1)]);
  }

  document.querySelectorAll('#tools .tool').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

  const colorsEl = $('#colors');
  for (const color of PALETTE) {
    const b = document.createElement('button');
    b.className = color === 'rainbow' ? 'swatch rainbow' : 'swatch';
    b.dataset.color = color;
    if (color !== 'rainbow') b.style.background = color;
    b.title = color === 'rainbow' ? 'Rainbow ink' : color;
    b.setAttribute('aria-label', b.title);
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

  // World map
  const mapGrid = $('#mapGrid');
  const mapCaption = $('#mapCaption');
  REGIONS.forEach((reg, i) => {
    const cell = document.createElement('button');
    cell.className = 'cell';
    cell.dataset.i = String(i);
    cell.style.background = reg.bg;
    cell.title = `${reg.name} · ${reg.label}`;
    cell.setAttribute('aria-label', cell.title);
    cell.addEventListener('mouseenter', () => {
      mapCaption.textContent = `${reg.name} · ${reg.label}: ${reg.desc}`;
    });
    cell.addEventListener('click', () => {
      map.classList.add('hidden');
      teleport(reg);
    });
    mapGrid.appendChild(cell);
  });
  const legend = $('#mapLegend');
  for (const [key, fx] of Object.entries(FX)) {
    const span = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = fx.bg;
    span.appendChild(sw);
    span.appendChild(document.createTextNode(fx.label));
    span.title = fx.desc;
    span.dataset.fx = key;
    legend.appendChild(span);
  }
  function toggleMap() {
    map.classList.toggle('hidden');
    help.classList.add('hidden');
    if (!map.classList.contains('hidden')) mapCaption.textContent = '256 regions. Click one to teleport.';
  }
  function randomTeleport() {
    const here = regionAt(cam.x, cam.y);
    let reg = here;
    while (reg === here) reg = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    teleport(reg);
  }

  $('#undoBtn').addEventListener('click', undo);
  $('#zoomIn').addEventListener('click', () => zoomAt(W / 2, H / 2, 1.25));
  $('#zoomOut').addEventListener('click', () => zoomAt(W / 2, H / 2, 0.8));
  zoomLabel.addEventListener('click', () => setZoom(1));
  $('#fitBtn').addEventListener('click', () => teleport(regionAt(cam.x, cam.y)));
  $('#mapBtn').addEventListener('click', toggleMap);
  $('#mapClose').addEventListener('click', () => map.classList.add('hidden'));
  $('#regionPill').addEventListener('click', toggleMap);
  $('#randomBtn').addEventListener('click', randomTeleport);
  $('#helpBtn').addEventListener('click', () => {
    help.classList.toggle('hidden');
    map.classList.add('hidden');
  });
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
  refreshSubscriptions();
  updateRegionPill();
  connect();
  try {
    if (!localStorage.getItem('pxc-seen')) {
      localStorage.setItem('pxc-seen', '1');
      help.classList.remove('hidden');
    }
  } catch {
    /* private mode: no first-visit help */
  }
})();
