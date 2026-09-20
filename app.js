'use strict';

(() => {
  // ============================================================== constants
  const MW = 131072; // map width in world units (360 degrees, wraps around)
  const MH = 65536; // map height (pole to pole)
  const TAU = Math.PI * 2;
  const PI = Math.PI;
  const DEG = PI / 180;
  const CELL = 8192; // storage cell: a 16 x 8 grid over the planet
  const GX = MW / CELL;
  const GY = MH / CELL;
  const PLANET_KM = 6371;
  const MAX_POINTS = 2000;
  const MAX_SPAN = 6000; // hard cap on how far a single stroke can reach
  const SIZE_PX = [2, 5, 11, 24, 50]; // brush sizes, in screen pixels at the current zoom
  const PALETTE = [
    '#111318', '#6b7280', '#ffffff', '#e11d48', '#f97316', '#eab308',
    '#22c55e', '#14b8a6', '#0ea5e9', '#3b82f6', '#8b5cf6', '#ec4899', 'rainbow',
  ];

  const ROOT = 'pixelcanvas/v3';
  const LIVE_TOPIC = `${ROOT}/live`;
  const TILE_TOPIC = (k) => `${ROOT}/tile/${k}`;
  const BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081',
  ];
  const TILE_BYTES_CAP = 90000;
  const DEAD_CAP = 250;
  // Anyone can publish to the public brokers, so treat every inbound message as
  // hostile: bound what one sender can make this tab allocate, paint or animate.
  const ACTIVE_TIMEOUT = 12000; // an unfinished stroke that stops arriving is dropped
  const ACTIVE_PER_USER = 3;
  const ACTIVE_TOTAL = 40;
  const MAX_MOVE_POINTS = 600; // coordinate pairs accepted from one move message
  const MAX_TILE_STROKES = 4000;
  const MAX_PEERS = 400;
  const MAX_CURSORS = 200;
  const RATE_BURST = 140;
  const RATE_REFILL = 70; // messages per second, per sender

  const COL = {
    space: '#05070d',
    ocean: '#9fc4e4',
    deep: '#7fb0d8',
    shelf: '#c2dcf0',
    land: '#c3d19a',
    forest: '#9dba7e',
    desert: '#e6d7a8',
    mount: '#bdb3a4',
    ice: '#f3f8fc',
    grat: 'rgba(30, 60, 90, 0.16)',
    gratMain: 'rgba(30, 60, 90, 0.3)',
  };

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const wrapPi = (a) => a - TAU * Math.round(a / TAU);
  const lonToX = (lon) => ((lon + PI) / TAU) * MW;
  const xToLon = (x) => (x / MW) * TAU - PI;
  const latToY = (lat) => ((PI / 2 - lat) / PI) * MH;
  const yToLat = (y) => PI / 2 - (y / MH) * PI;
  const normX = (x) => ((x % MW) + MW) % MW;

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

  // ============================================================== spherical geometry
  function destPoint(lon1, lat1, brng, d) {
    const sl = Math.sin(lat1);
    const cl = Math.cos(lat1);
    const sd = Math.sin(d);
    const cd = Math.cos(d);
    const lat2 = Math.asin(clamp(sl * cd + cl * sd * Math.cos(brng), -1, 1));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * sd * cl, cd - sl * Math.sin(lat2));
    return [lon2, lat2];
  }
  function gcDist(lon1, lat1, lon2, lat2) {
    const d = Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1);
    return Math.acos(clamp(d, -1, 1));
  }
  function bearingTo(lon1, lat1, lon2, lat2) {
    const dl = lon2 - lon1;
    return Math.atan2(
      Math.sin(dl) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dl)
    );
  }

  // ============================================================== the planet
  // Continents are unions of wobbly spherical blobs, so coastlines stay crisp at
  // every zoom level and every client draws exactly the same world.
  const CONTINENTS = [
    { name: 'Aurelia', lon: -96, lat: 44, blobs: [[-105, 52, 17], [-88, 40, 14], [-119, 45, 10], [-76, 51, 9], [-95, 27, 8], [-83, 60, 8]] },
    { name: 'Verdance', lon: -62, lat: -14, blobs: [[-66, -5, 12], [-58, -23, 11], [-70, -37, 7], [-52, -9, 8]] },
    { name: 'Norlund', lon: 16, lat: 52, blobs: [[10, 52, 10], [26, 58, 9], [1, 45, 7], [33, 47, 7], [20, 64, 7]] },
    { name: 'Saharim', lon: 20, lat: -2, blobs: [[15, 11, 15], [29, -4, 13], [10, -16, 10], [36, 9, 9], [23, -29, 7]] },
    { name: 'Tamarind', lon: 96, lat: 38, blobs: [[95, 45, 20], [74, 28, 13], [116, 31, 12], [70, 56, 12], [126, 52, 11], [104, 12, 8]] },
    { name: 'Coralind', lon: 136, lat: -25, blobs: [[135, -25, 11], [149, -31, 8], [124, -20, 7]] },
    { name: 'Mereth', lon: -155, lat: 8, blobs: [[-155, 8, 7], [-166, -3, 5], [-144, 17, 4]] },
    { name: 'Halcyon', lon: 172, lat: -39, blobs: [[170, -38, 6], [179, -46, 4]] },
    { name: 'Thule', lon: -38, lat: 73, blobs: [[-42, 72, 9], [-26, 78, 6]] },
    { name: 'Solenne', lon: -20, lat: -48, blobs: [[-20, -48, 6], [-9, -54, 4]] },
    { name: 'Kestrel Isles', lon: 62, lat: -12, blobs: [[62, -12, 4], [70, -18, 3], [55, -6, 3]] },
  ];
  const SEAS = [
    { name: 'The Great Blue', lon: -150, lat: 0 },
    { name: 'Mid Ocean', lon: -32, lat: 12 },
    { name: 'Sunrise Sea', lon: 76, lat: -28 },
    { name: 'Cobalt Deep', lon: 158, lat: 34 },
    { name: 'Verge Sea', lon: -104, lat: -46 },
    { name: 'The Northern Ice', lon: 0, lat: 84 },
    { name: 'The Southern Ice', lon: 0, lat: -84 },
    { name: 'Lantern Straits', lon: 44, lat: 30 },
    { name: 'The Long Water', lon: 120, lat: -58 },
  ];

  function wobbleFn(seed) {
    const r = rng(seed);
    const a1 = r() * TAU;
    const a2 = r() * TAU;
    const a3 = r() * TAU;
    const k1 = 0.2 + r() * 0.14;
    const k2 = 0.1 + r() * 0.1;
    const k3 = 0.05 + r() * 0.07;
    return (th) => 1 + k1 * Math.sin(3 * th + a1) + k2 * Math.sin(5 * th + a2) + k3 * Math.sin(8 * th + a3);
  }

  // A polygon in map units, kept continuous across the seam.
  function blobPoly(lonDeg, latDeg, radDeg, seed, scale) {
    const wob = wobbleFn(seed);
    const lon0 = lonDeg * DEG;
    const lat0 = latDeg * DEG;
    const rad = radDeg * DEG * (scale || 1);
    const steps = 96;
    const pts = new Float64Array(steps * 2);
    let prevLon = null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < steps; i++) {
      const th = (i / steps) * TAU;
      const [lon, lat] = destPoint(lon0, lat0, th, rad * wob(th));
      let l = lon;
      if (prevLon !== null) l = prevLon + wrapPi(l - prevLon);
      prevLon = l;
      const x = lonToX(wrapPi(lon0)) + ((l - lon0) / TAU) * MW;
      const y = latToY(lat);
      pts[i * 2] = x;
      pts[i * 2 + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    return { pts, minX, maxX, minY, maxY, lon0, lat0, rad, wob };
  }

  const LAND = [];
  const BIOMES = { forest: [], desert: [], mount: [] };
  const CAPS = [];
  (function buildWorld() {
    for (const c of CONTINENTS) {
      c.polys = [];
      for (let i = 0; i < c.blobs.length; i++) {
        const [lo, la, rd] = c.blobs[i];
        const p = blobPoly(lo, la, rd, hash32(`${c.name}:${i}`), 1);
        p.owner = c;
        c.polys.push(p);
        LAND.push(p);
      }
      // Biome patches, placed deterministically inside the continent.
      const r = rng(hash32(`biome:${c.name}`));
      for (let i = 0; i < c.blobs.length; i++) {
        const [lo, la, rd] = c.blobs[i];
        if (rd < 6) continue;
        const kinds = ['forest', 'desert', 'mount'];
        const n = 1 + Math.floor(r() * 2);
        for (let k = 0; k < n; k++) {
          const kind = kinds[Math.floor(r() * kinds.length)];
          const off = (r() - 0.5) * rd * 1.1;
          const off2 = (r() - 0.5) * rd * 0.9;
          BIOMES[kind].push(blobPoly(lo + off / Math.max(0.25, Math.cos(la * DEG)), la + off2, rd * (0.35 + r() * 0.4), hash32(`${c.name}:${i}:${k}:${kind}`), 1));
        }
      }
    }
    // Polar ice caps: a wobbly band around each pole.
    for (const sign of [1, -1]) {
      const base = 74 * sign;
      const wob = wobbleFn(hash32(`cap:${sign}`));
      const steps = 180;
      const pts = new Float64Array((steps + 3) * 2);
      for (let i = 0; i <= steps; i++) {
        const lon = -PI + (i / steps) * TAU;
        const lat = (base + sign * 11 * (wob(lon) - 1)) * DEG;
        pts[i * 2] = lonToX(lon);
        pts[i * 2 + 1] = latToY(clamp(lat, -88 * DEG, 88 * DEG));
      }
      const endY = sign > 0 ? 0 : MH;
      pts[(steps + 1) * 2] = MW;
      pts[(steps + 1) * 2 + 1] = endY;
      pts[(steps + 2) * 2] = 0;
      pts[(steps + 2) * 2 + 1] = endY;
      CAPS.push({ pts, minX: 0, maxX: MW, minY: 0, maxY: MH, sign });
    }
  })();

  function insideBlob(p, lon, lat) {
    const d = gcDist(p.lon0, p.lat0, lon, lat);
    if (d > p.rad * 1.5) return false;
    const th = bearingTo(p.lon0, p.lat0, lon, lat);
    return d < p.rad * p.wob(th);
  }

  function placeAt(x, y) {
    const lon = xToLon(normX(x));
    const lat = yToLat(clamp(y, 0, MH));
    if (Math.abs(lat) > 72 * DEG) return Math.sign(lat) > 0 ? 'The Northern Ice' : 'The Southern Ice';
    for (const c of CONTINENTS) {
      for (const p of c.polys) if (insideBlob(p, lon, lat)) return c.name;
    }
    let best = SEAS[0];
    let bd = Infinity;
    for (const s of SEAS) {
      const d = gcDist(s.lon * DEG, s.lat * DEG, lon, lat);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best.name;
  }

  const PLACES = [
    ...CONTINENTS.map((c) => ({ name: c.name, lon: c.lon, lat: c.lat, land: true })),
    ...SEAS.map((s) => ({ name: s.name, lon: s.lon, lat: s.lat, land: false })),
  ];

  // ============================================================== stroke store
  const strokes = new Map(); // id -> stroke
  const cellIds = new Map(); // cell key -> Set of ids
  const activeStrokes = new Map(); // strokes still being drawn (mine and other people's)
  const mine = [];
  const cursors = new Map();
  const users = new Map();
  const myId = Math.random().toString(36).slice(2, 10);

  function cellKeyFor(x, y) {
    const cx = clamp(Math.floor(normX(x) / CELL), 0, GX - 1);
    const cy = clamp(Math.floor(y / CELL), 0, GY - 1);
    return `${cx}_${cy}`;
  }

  function strokeBBox(s) {
    if (s.bb) return s.bb;
    const p = s.points;
    let a = Infinity;
    let b = Infinity;
    let c = -Infinity;
    let d = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
      if (p[i] < a) a = p[i];
      if (p[i] > c) c = p[i];
      if (p[i + 1] < b) b = p[i + 1];
      if (p[i + 1] > d) d = p[i + 1];
    }
    const pad = s.size * (s.k === 's' ? 2.6 : 0.6) + 4;
    const cs = Math.max(0.12, Math.cos(yToLat(clamp(s.points[1], 0, MH))));
    s.bb = { x0: a - pad / cs, y0: b - pad, x1: c + pad / cs, y1: d + pad };
    return s.bb;
  }

  function addToIndex(s) {
    const k = cellKeyFor(s.points[0], s.points[1]);
    s.cell = k;
    let set = cellIds.get(k);
    if (!set) cellIds.set(k, (set = new Set()));
    set.add(s.id);
  }

  function strokesNear(win) {
    // Storage cells overlapping the window, plus one ring, since a stroke is
    // filed under the cell of its first point but can reach past the edge.
    const out = [];
    const cy0 = clamp(Math.floor(win.y0 / CELL) - 1, 0, GY - 1);
    const cy1 = clamp(Math.floor((win.y0 + win.h) / CELL) + 1, 0, GY - 1);
    const spanCells = Math.min(GX, Math.ceil(win.w / CELL) + 3);
    const cxStart = Math.floor(win.x0 / CELL) - 1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let i = 0; i < spanCells; i++) {
        const cx = ((((cxStart + i) % GX) + GX) % GX);
        const set = cellIds.get(`${cx}_${cy}`);
        if (!set) continue;
        for (const id of set) {
          const s = strokes.get(id);
          if (s) out.push(s);
        }
      }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // ============================================================== view layers
  // A view is an equirectangular window of the planet kept on two canvases: the
  // generated terrain, and everything people have drawn. The two are composited
  // and handed to the GPU as the globe's texture.
  function makeView(size, w2, whole) {
    const mk = (a, b) => {
      const c = document.createElement('canvas');
      c.width = a;
      c.height = b;
      return c;
    };
    const cw = size;
    const ch = w2 || size;
    return {
      cw,
      ch,
      whole: !!whole,
      base: mk(cw, ch),
      art: mk(cw, ch),
      comp: mk(cw, ch),
      scratch: mk(256, 256),
      win: null,
      tex: null,
      valid: false,
      dirty: null,
      full: false,
      mips: false,
    };
  }

  function viewScale(v) {
    return { sx: v.cw / v.win.w, sy: v.ch / v.win.h };
  }

  function markDirty(v, x0, y0, x1, y1) {
    if (!v.valid || !v.win) return;
    const { sx, sy } = viewScale(v);
    let ax = Math.floor((x0 - v.win.x0) * sx) - 2;
    let ay = Math.floor((y0 - v.win.y0) * sy) - 2;
    let bx = Math.ceil((x1 - v.win.x0) * sx) + 2;
    let by = Math.ceil((y1 - v.win.y0) * sy) + 2;
    if (v.whole) {
      // The world view wraps, so a stroke on the seam touches both edges.
      if (bx < 0 || ax > v.cw) {
        const shift = ax > v.cw ? -v.cw : v.cw;
        ax += shift;
        bx += shift;
      }
    }
    ax = clamp(ax, 0, v.cw);
    bx = clamp(bx, 0, v.cw);
    ay = clamp(ay, 0, v.ch);
    by = clamp(by, 0, v.ch);
    if (bx <= ax || by <= ay) return;
    if (!v.dirty) v.dirty = { x0: ax, y0: ay, x1: bx, y1: by };
    else {
      v.dirty.x0 = Math.min(v.dirty.x0, ax);
      v.dirty.y0 = Math.min(v.dirty.y0, ay);
      v.dirty.x1 = Math.max(v.dirty.x1, bx);
      v.dirty.y1 = Math.max(v.dirty.y1, by);
    }
  }

  function offsetsFor(v, x0, x1) {
    // Which copies of a shape (seam wrap) land inside this window.
    const out = [];
    for (const dx of [-MW, 0, MW]) {
      if (x1 + dx > v.win.x0 && x0 + dx < v.win.x0 + v.win.w) out.push(dx);
    }
    return out;
  }

  // -------------------------------------------------------------- terrain paint
  function addPoly(ctx, pts, dx) {
    ctx.moveTo(pts[0] + dx, pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] + dx, pts[i + 1]);
    ctx.closePath();
  }
  function pathPolys(ctx, v, polys) {
    ctx.beginPath();
    for (const p of polys) {
      for (const dx of offsetsFor(v, p.minX, p.maxX)) addPoly(ctx, p.pts, dx);
    }
  }

  function paintTerrain(v) {
    const ctx = v.base.getContext('2d');
    const { sx, sy } = viewScale(v);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COL.ocean;
    ctx.fillRect(0, 0, v.cw, v.ch);
    ctx.setTransform(sx, 0, 0, sy, -v.win.x0 * sx, -v.win.y0 * sy);

    // Shallow water ringing the coasts.
    ctx.lineJoin = 'round';
    pathPolys(ctx, v, LAND);
    ctx.strokeStyle = COL.shelf;
    ctx.lineWidth = 900;
    ctx.stroke();
    ctx.fillStyle = COL.land;
    ctx.fill();

    ctx.save();
    pathPolys(ctx, v, LAND);
    ctx.clip();
    for (const kind of ['forest', 'desert', 'mount']) {
      pathPolys(ctx, v, BIOMES[kind]);
      ctx.fillStyle = COL[kind];
      ctx.fill();
    }
    ctx.restore();

    pathPolys(ctx, v, CAPS);
    ctx.fillStyle = COL.ice;
    ctx.fill();

    // Graticule, drawn in pixel space so the lines stay hairline thin.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = Math.max(1, Math.round(v.cw / 1400));
    for (let d = -180; d < 180; d += 15) {
      const x = lonToX(d * DEG);
      for (const dx of offsetsFor(v, x, x)) {
        const px = Math.round((x + dx - v.win.x0) * sx) + 0.5;
        if (px < 0 || px > v.cw) continue;
        ctx.strokeStyle = d === 0 ? COL.gratMain : COL.grat;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, v.ch);
        ctx.stroke();
      }
    }
    for (let d = -75; d <= 75; d += 15) {
      const py = Math.round((latToY(d * DEG) - v.win.y0) * sy) + 0.5;
      if (py < 0 || py > v.ch) continue;
      ctx.strokeStyle = d === 0 ? COL.gratMain : COL.grat;
      ctx.beginPath();
      ctx.moveTo(0, py);
      ctx.lineTo(v.cw, py);
      ctx.stroke();
    }
  }

  // -------------------------------------------------------------- stroke paint
  function rainbowAt(id, len) {
    return `hsl(${(hash32(id) % 360 + len) % 360} 90% 55%)`;
  }

  function paintStroke(ctx, v, s, dx) {
    const { sx, sy } = viewScale(v);
    const p = s.points;
    if (p.length < 2) return;
    // Longitude is stretched in this projection, so widen the pen to match:
    // that keeps a round brush round once it is wrapped onto the sphere.
    const cosLat = clamp(Math.cos(yToLat(s.cy0 !== undefined ? s.cy0 : p[1])), 0.12, 1);
    const k = (sx / sy) / cosLat;
    ctx.setTransform(sy * k, 0, 0, sy, (dx - v.win.x0) * sx, -v.win.y0 * sy);
    const fx = (x) => x * cosLat;
    const minW = (v.whole ? 3.2 : 1.15) / sy;
    const w = Math.max(s.size, minW);
    const rainbow = !s.erase && s.color === 'rainbow';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    const solid = s.erase ? '#000' : s.color;

    if (s.k === 's') {
      const r = rng(hash32(s.id) ^ 0x5bd1e995);
      const radius = w * 1.9;
      ctx.fillStyle = solid;
      for (let i = 0; i < p.length; i += 2) {
        if (rainbow) ctx.fillStyle = rainbowAt(s.id, i * 5);
        for (let n = 0; n < 7; n++) {
          const a = r() * TAU;
          const d = Math.sqrt(r()) * radius;
          ctx.beginPath();
          ctx.arc(fx(p[i]) + Math.cos(a) * d, p[i + 1] + Math.sin(a) * d, w * 0.08 + r() * w * 0.2 + minW * 0.4, 0, TAU);
          ctx.fill();
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      return;
    }

    ctx.lineWidth = w;
    if (p.length === 2) {
      ctx.fillStyle = rainbow ? rainbowAt(s.id, 0) : solid;
      ctx.beginPath();
      ctx.arc(fx(p[0]), p[1], w / 2, 0, TAU);
      ctx.fill();
    } else if (rainbow) {
      let len = 0;
      for (let i = 2; i < p.length; i += 2) {
        len += (Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]) / Math.max(w, 1)) * 16;
        ctx.strokeStyle = rainbowAt(s.id, len);
        ctx.beginPath();
        ctx.moveTo(fx(p[i - 2]), p[i - 1]);
        ctx.lineTo(fx(p[i]), p[i + 1]);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = solid;
      ctx.beginPath();
      ctx.moveTo(fx(p[0]), p[1]);
      if (p.length === 4) ctx.lineTo(fx(p[2]), p[3]);
      else {
        for (let i = 2; i < p.length - 2; i += 2) {
          ctx.quadraticCurveTo(fx(p[i]), p[i + 1], (fx(p[i]) + fx(p[i + 2])) / 2, (p[i + 1] + p[i + 3]) / 2);
        }
        ctx.lineTo(fx(p[p.length - 2]), p[p.length - 1]);
      }
      ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawStrokeInView(v, s) {
    if (!v.valid || !v.win) return;
    const bb = strokeBBox(s);
    if (bb.y1 < v.win.y0 || bb.y0 > v.win.y0 + v.win.h) return;
    const ctx = v.art.getContext('2d');
    let drew = false;
    for (const dx of offsetsFor(v, bb.x0, bb.x1)) {
      paintStroke(ctx, v, s, dx);
      drew = true;
    }
    if (drew) markDirty(v, bb.x0, bb.y0, bb.x1, bb.y1);
  }

  function repaintArtRect(v, x0, y0, x1, y1) {
    if (!v.valid || !v.win) return;
    const { sx, sy } = viewScale(v);
    const ctx = v.art.getContext('2d');
    const list = strokesNear({ x0: x0 - MAX_SPAN, y0: y0 - MAX_SPAN, w: x1 - x0 + MAX_SPAN * 2, h: y1 - y0 + MAX_SPAN * 2 })
      .concat([...activeStrokes.values()].sort((a, b) => a.t - b.t));
    for (const dx of offsetsFor(v, x0, x1)) {
      const px = (x0 + dx - v.win.x0) * sx;
      const py = (y0 - v.win.y0) * sy;
      const pw = (x1 - x0) * sx;
      const ph = (y1 - y0) * sy;
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(px, py, pw, ph);
      ctx.clip();
      ctx.clearRect(px, py, pw, ph);
      for (const s of list) {
        const bb = strokeBBox(s);
        if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue;
        for (const d2 of offsetsFor(v, bb.x0, bb.x1)) paintStroke(ctx, v, s, d2);
      }
      ctx.restore();
    }
    markDirty(v, x0, y0, x1, y1);
  }

  function rebuildView(v, win) {
    v.win = win;
    v.valid = true;
    paintTerrain(v);
    const actx = v.art.getContext('2d');
    actx.setTransform(1, 0, 0, 1, 0, 0);
    actx.clearRect(0, 0, v.cw, v.ch);
    const list = strokesNear(win).concat([...activeStrokes.values()]);
    list.sort((a, b) => a.t - b.t);
    for (const s of list) drawStrokeInView(v, s);
    v.full = true;
    v.dirty = null;
    v.mips = false;
  }

  function compositeRect(v, x0, y0, x1, y1) {
    const ctx = v.comp.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    ctx.drawImage(v.base, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    ctx.drawImage(v.art, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
  }

  // ============================================================== camera
  const stars = document.getElementById('stars');
  const glCanvas = document.getElementById('globe');
  const overlay = document.getElementById('overlay');
  const octx = overlay.getContext('2d');

  let W = 1;
  let H = 1;
  let dpr = 1;
  const cam = { lon: -0.3, lat: 0.35, R: 300 };
  const hover = { x: 0, y: 0, on: false, touch: false };
  const state = { tool: 'pen', color: PALETTE[0], sizeIdx: 1 };

  const Rcover = () => 0.5 * Math.hypot(W, H);
  const Rfit = () => 0.44 * Math.min(W, H);
  const Rmin = () => Rfit() * 0.92;
  const Rmax = () => Rcover() * 120;
  const Rdraw = () => Rcover() * 5;
  const canDraw = () => cam.R >= Rdraw();
  const viewKm = () => 2 * Math.asin(clamp(Math.min(W, H) / 2 / cam.R, 0, 1)) * PLANET_KM;
  const pxPerUnit = () => (cam.R * TAU) / MW;

  function project(lon, lat) {
    const c = Math.cos(lat);
    const vx = c * Math.sin(lon);
    const vy = Math.sin(lat);
    const vz = c * Math.cos(lon);
    const cl = Math.cos(cam.lon);
    const sl = Math.sin(cam.lon);
    const x1 = cl * vx - sl * vz;
    const z1 = sl * vx + cl * vz;
    const cb = Math.cos(cam.lat);
    const sb = Math.sin(cam.lat);
    const y2 = cb * vy - sb * z1;
    const z2 = sb * vy + cb * z1;
    return { x: W / 2 + cam.R * x1, y: H / 2 - cam.R * y2, z: z2 };
  }

  function unproject(sx, sy) {
    const x = (sx - W / 2) / cam.R;
    const y = -(sy - H / 2) / cam.R;
    const d2 = x * x + y * y;
    if (d2 > 1) return null;
    const z = Math.sqrt(1 - d2);
    const cb = Math.cos(cam.lat);
    const sb = Math.sin(cam.lat);
    const y1 = cb * y + sb * z;
    const z1 = -sb * y + cb * z;
    const cl = Math.cos(cam.lon);
    const sl = Math.sin(cam.lon);
    const vx = cl * x + sl * z1;
    const vz = -sl * x + cl * z1;
    return { lon: Math.atan2(vx, vz), lat: Math.asin(clamp(y1, -1, 1)) };
  }

  function screenToMap(sx, sy) {
    const p = unproject(sx, sy);
    if (!p) return null;
    return { x: lonToX(p.lon), y: latToY(p.lat) };
  }

  // The chunk of the planet the screen is currently showing, in map units.
  function visibleWindow() {
    const pts = [];
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      for (const [sx, sy] of [[f * W, 0], [f * W, H], [0, f * H], [W, f * H]]) {
        const p = unproject(sx, sy);
        if (p) pts.push(p);
      }
    }
    const mid = unproject(W / 2, H / 2);
    if (mid) pts.push(mid);
    if (!pts.length) return { x0: 0, y0: 0, w: MW, h: MH };
    let dmin = Infinity;
    let dmax = -Infinity;
    let laMin = Infinity;
    let laMax = -Infinity;
    for (const p of pts) {
      const d = wrapPi(p.lon - cam.lon);
      if (d < dmin) dmin = d;
      if (d > dmax) dmax = d;
      if (p.lat < laMin) laMin = p.lat;
      if (p.lat > laMax) laMax = p.lat;
    }
    // A visible pole means every meridian is on screen.
    let poleN = project(0, PI / 2);
    let poleS = project(0, -PI / 2);
    const onScreen = (p) => p.z > 0 && p.x > -20 && p.x < W + 20 && p.y > -20 && p.y < H + 20;
    let full = false;
    if (onScreen(poleN)) {
      laMax = PI / 2;
      full = true;
    }
    if (onScreen(poleS)) {
      laMin = -PI / 2;
      full = true;
    }
    const mLat = (laMax - laMin) * 0.18 + 0.004;
    laMax = Math.min(PI / 2, laMax + mLat);
    laMin = Math.max(-PI / 2, laMin - mLat);
    let y0 = latToY(laMax);
    let h = latToY(laMin) - y0;
    let x0;
    let w;
    if (full || dmax - dmin > TAU * 0.92) {
      x0 = 0;
      w = MW;
    } else {
      const mLon = (dmax - dmin) * 0.18 + 0.004;
      x0 = lonToX(cam.lon) + ((dmin - mLon) / TAU) * MW;
      w = ((dmax - dmin + mLon * 2) / TAU) * MW;
      if (w > MW) {
        x0 = 0;
        w = MW;
      }
    }
    return { x0, y0, w: Math.max(w, 8), h: Math.max(h, 8) };
  }

  const overview = makeView(2048, 1024, true);
  const detail = makeView(
    Math.min(window.innerWidth, window.innerHeight) * Math.min(window.devicePixelRatio || 1, 2) > 900 ? 2048 : 1024,
    null,
    false
  );

  function useOverview() {
    return cam.R < Rcover() * 1.06;
  }

  function ensureViews() {
    if (!overview.valid) rebuildView(overview, { x0: 0, y0: 0, w: MW, h: MH });
    if (useOverview()) return overview;
    const need = visibleWindow();
    const v = detail;
    const cur = v.win;
    const stale =
      !v.valid ||
      !cur ||
      need.y0 < cur.y0 ||
      need.y0 + need.h > cur.y0 + cur.h ||
      need.x0 < cur.x0 ||
      need.x0 + need.w > cur.x0 + cur.w ||
      cur.w > need.w * 2.6 ||
      cur.h > need.h * 2.6;
    if (stale) {
      const pad = 0.22;
      const win = {
        x0: need.x0 - need.w * pad,
        y0: Math.max(0, need.y0 - need.h * pad),
        w: Math.min(MW, need.w * (1 + pad * 2)),
        h: need.h * (1 + pad * 2),
      };
      if (win.y0 + win.h > MH) win.h = MH - win.y0;
      if (win.w >= MW) win.x0 = 0;
      rebuildView(v, win);
    }
    return v;
  }

  // ============================================================== webgl globe
  let gl = null;
  let prog = null;
  let uni = {};
  let posBuf = null;
  let idxBuf = null;
  let glFail = false;

  const VS = `
attribute vec2 aLL;
uniform float uCl, uSl, uCb, uSb, uR;
uniform vec2 uHalf;
varying vec2 vLL;
varying float vZ;
void main() {
  float c = cos(aLL.y);
  vec3 v = vec3(c * sin(aLL.x), sin(aLL.y), c * cos(aLL.x));
  float x1 = uCl * v.x - uSl * v.z;
  float z1 = uSl * v.x + uCl * v.z;
  float y2 = uCb * v.y - uSb * z1;
  float z2 = uSb * v.y + uCb * z1;
  vLL = aLL;
  vZ = z2;
  gl_Position = vec4(uR * x1 / uHalf.x, uR * y2 / uHalf.y, 0.0, 1.0);
}`;

  const FS = `
precision highp float;
varying vec2 vLL;
varying float vZ;
uniform sampler2D uTex;
uniform vec4 uWin;
uniform float uShade;
void main() {
  if (vZ <= 0.0) discard;
  float d = vLL.x - uWin.x;
  d = d - 6.283185307 * floor(d / 6.283185307);
  float u = d / uWin.y;
  float v = (uWin.z - vLL.y) / uWin.w;
  vec3 c = texture2D(uTex, vec2(u, v)).rgb;
  float sh = mix(1.0, 0.62 + 0.38 * sqrt(max(vZ, 0.0)), uShade);
  gl_FragColor = vec4(c * sh, 1.0);
}`;

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
    return s;
  }

  function initGL() {
    try {
      gl = glCanvas.getContext('webgl', { antialias: true, alpha: true, depth: false });
      if (!gl) throw new Error('no webgl');
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
      gl.useProgram(prog);
      for (const n of ['uCl', 'uSl', 'uCb', 'uSb', 'uR', 'uHalf', 'uWin', 'uShade', 'uTex']) {
        uni[n] = gl.getUniformLocation(prog, n);
      }
      uni.aLL = gl.getAttribLocation(prog, 'aLL');
      posBuf = gl.createBuffer();
      idxBuf = gl.createBuffer();
      gl.enableVertexAttribArray(uni.aLL);
      gl.uniform1i(uni.uTex, 0);
      gl.clearColor(0, 0, 0, 0);
    } catch (err) {
      glFail = true;
      gl = null;
      console.error('WebGL unavailable', err);
    }
  }

  function buildMesh(v) {
    if (!gl) return;
    const lon0 = xToLon(v.win.x0);
    const lonSpan = (v.win.w / MW) * TAU;
    const latTop = yToLat(v.win.y0);
    const latSpan = (v.win.h / MH) * PI;
    const nx = v.whole ? 160 : 60;
    const ny = v.whole ? 80 : 60;
    const verts = new Float32Array((nx + 1) * (ny + 1) * 2);
    let o = 0;
    for (let j = 0; j <= ny; j++) {
      const lat = latTop - (j / ny) * latSpan;
      for (let i = 0; i <= nx; i++) {
        verts[o++] = lon0 + (i / nx) * lonSpan;
        verts[o++] = lat;
      }
    }
    const idx = new Uint16Array(nx * ny * 6);
    let m = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = j * (nx + 1) + i;
        const b = a + 1;
        const c = a + nx + 1;
        const d = c + 1;
        idx[m++] = a; idx[m++] = c; idx[m++] = b;
        idx[m++] = b; idx[m++] = c; idx[m++] = d;
      }
    }
    v.mesh = { count: idx.length, verts, idx };
  }

  function uploadTexture(v) {
    if (!gl) return;
    if (!v.tex) {
      v.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, v.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, v.whole ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, v.whole ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      v.full = true;
    }
    gl.bindTexture(gl.TEXTURE_2D, v.tex);
    if (v.full) {
      compositeRect(v, 0, 0, v.cw, v.ch);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.comp);
      if (v.whole) gl.generateMipmap(gl.TEXTURE_2D);
      v.full = false;
      v.dirty = null;
      return;
    }
    if (!v.dirty) return;
    const d = v.dirty;
    v.dirty = null;
    const w = d.x1 - d.x0;
    const h = d.y1 - d.y0;
    if (w > 1024 || h > 1024) {
      compositeRect(v, 0, 0, v.cw, v.ch);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v.comp);
      if (v.whole) gl.generateMipmap(gl.TEXTURE_2D);
      return;
    }
    compositeRect(v, d.x0, d.y0, d.x1, d.y1);
    if (v.scratch.width !== w || v.scratch.height !== h) {
      v.scratch.width = w;
      v.scratch.height = h;
    }
    const sc = v.scratch.getContext('2d');
    sc.clearRect(0, 0, w, h);
    sc.drawImage(v.comp, d.x0, d.y0, w, h, 0, 0, w, h);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x0, d.y0, gl.RGBA, gl.UNSIGNED_BYTE, v.scratch);
    if (v.whole) gl.generateMipmap(gl.TEXTURE_2D);
  }

  function renderGlobe(v) {
    if (!gl) return;
    if (!v.mesh || v.meshWin !== v.win) {
      buildMesh(v);
      v.meshWin = v.win;
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, v.mesh.verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, v.mesh.idx, gl.STATIC_DRAW);
      v.uploadedMesh = true;
      lastMeshView = v;
    } else if (lastMeshView !== v) {
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, v.mesh.verts, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, v.mesh.idx, gl.STATIC_DRAW);
      lastMeshView = v;
    }
    uploadTexture(v);
    gl.viewport(0, 0, glCanvas.width, glCanvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.vertexAttribPointer(uni.aLL, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
    gl.uniform1f(uni.uCl, Math.cos(cam.lon));
    gl.uniform1f(uni.uSl, Math.sin(cam.lon));
    gl.uniform1f(uni.uCb, Math.cos(cam.lat));
    gl.uniform1f(uni.uSb, Math.sin(cam.lat));
    gl.uniform1f(uni.uR, cam.R * dpr);
    gl.uniform2f(uni.uHalf, glCanvas.width / 2, glCanvas.height / 2);
    gl.uniform4f(
      uni.uWin,
      xToLon(v.win.x0),
      (v.win.w / MW) * TAU,
      yToLat(v.win.y0),
      (v.win.h / MH) * PI
    );
    const shade = clamp((Rcover() * 1.9 - cam.R) / (Rcover() * 1.1), 0, 1);
    gl.uniform1f(uni.uShade, shade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, v.tex);
    gl.drawElements(gl.TRIANGLES, v.mesh.count, gl.UNSIGNED_SHORT, 0);
  }
  let lastMeshView = null;

  // ============================================================== overlay
  function paintStars() {
    const c = stars.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = COL.space;
    c.fillRect(0, 0, stars.width, stars.height);
    const r = rng(12345);
    const n = Math.round((stars.width * stars.height) / 9000);
    for (let i = 0; i < n; i++) {
      const x = r() * stars.width;
      const y = r() * stars.height;
      const s = r();
      c.globalAlpha = 0.25 + s * 0.6;
      c.fillStyle = s > 0.93 ? '#cfe4ff' : '#ffffff';
      c.beginPath();
      c.arc(x, y, (s > 0.93 ? 1.5 : 0.7) * dpr * (0.6 + s * 0.8), 0, TAU);
      c.fill();
    }
    c.globalAlpha = 1;
  }

  function drawOverlay() {
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, W, H);

    if (cam.R < Math.hypot(W, H) * 0.75) {
      const g = octx.createRadialGradient(W / 2, H / 2, cam.R * 0.985, W / 2, H / 2, cam.R * 1.14);
      g.addColorStop(0, 'rgba(120, 180, 255, 0)');
      g.addColorStop(0.18, 'rgba(130, 190, 255, 0.28)');
      g.addColorStop(1, 'rgba(90, 150, 255, 0)');
      octx.fillStyle = g;
      octx.beginPath();
      octx.arc(W / 2, H / 2, cam.R * 1.14, 0, TAU);
      octx.fill();
    }

    if (cam.R < Rcover() * 3.2) {
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      for (const pl of PLACES) {
        const p = project(pl.lon * DEG, pl.lat * DEG);
        if (p.z < 0.18) continue;
        if (p.x < -60 || p.x > W + 60 || p.y < -20 || p.y > H + 20) continue;
        const a = clamp((p.z - 0.18) * 3, 0, 1) * 0.85;
        octx.globalAlpha = a;
        octx.font = `${pl.land ? 700 : 500} ${pl.land ? 12 : 11}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif`;
        octx.lineWidth = 3;
        octx.strokeStyle = 'rgba(255,255,255,0.7)';
        octx.strokeText(pl.name, p.x, p.y);
        octx.fillStyle = pl.land ? '#3c4a2e' : '#2b4b6b';
        octx.fillText(pl.name, p.x, p.y);
      }
      octx.globalAlpha = 1;
    }

    const now = performance.now();
    for (const [id, cur] of cursors) {
      if (now - cur.t > 9000) {
        cursors.delete(id);
        continue;
      }
      const p = project(xToLon(cur.x), yToLat(cur.y));
      if (p.z <= 0.02 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) continue;
      octx.beginPath();
      octx.arc(p.x, p.y, 6, 0, TAU);
      octx.fillStyle = cur.c;
      octx.fill();
      octx.lineWidth = 2;
      octx.strokeStyle = 'rgba(255,255,255,0.9)';
      octx.stroke();
    }

    drawBrushRing();
  }

  // Shows exactly where the next mark lands and how big it will be.
  function drawBrushRing() {
    if (!hover.on || hover.touch || spin || pinch) return;
    if (state.tool === 'hand' || !canDraw()) return;
    const r = Math.max(3.5, SIZE_PX[state.sizeIdx] / 2);
    octx.save();
    octx.beginPath();
    octx.arc(hover.x, hover.y, r + 1, 0, TAU);
    octx.lineWidth = 3;
    octx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    if (state.tool === 'eraser') octx.setLineDash([5, 4]);
    octx.stroke();
    octx.beginPath();
    octx.arc(hover.x, hover.y, r + 1, 0, TAU);
    octx.lineWidth = 1.25;
    octx.strokeStyle = state.tool === 'eraser' ? 'rgba(20,24,30,0.85)' : state.color === 'rainbow' ? '#f43f5e' : state.color;
    octx.stroke();
    octx.setLineDash([]);
    octx.beginPath();
    octx.arc(hover.x, hover.y, 1.1, 0, TAU);
    octx.fillStyle = 'rgba(20, 24, 30, 0.7)';
    octx.fill();
    octx.restore();
  }

  // ============================================================== render loop
  let renderPending = false;
  let curView = null;
  let lastError = null;

  function requestRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(frame);
  }

  function frame() {
    renderPending = false;
    try {
      const v = ensureViews();
      curView = v;
      renderGlobe(v);
      drawOverlay();
    } catch (err) {
      lastError = err;
      console.error('render', err);
    }
    updateHud();
    updateHash();
    if (activeStrokes.size || cursors.size) requestRender();
  }

  // ============================================================== drawing
  let drawing = null;
  let flushTimer = null;
  let seq = 0;

  function currentSizeUnits() {
    return clamp((SIZE_PX[state.sizeIdx] * MW) / (cam.R * TAU), 1.5, 24000);
  }

  function addStrokeToViews(s) {
    for (const v of [overview, detail]) {
      if (!v.valid) continue;
      if (s.in && s.in.has(v)) continue;
      drawStrokeInView(v, s);
    }
  }

  function commitStroke(s) {
    if (strokes.has(s.id)) return;
    strokes.set(s.id, s);
    addToIndex(s);
    addStrokeToViews(s);
    s.in = null;
    requestRender();
  }

  function removeStroke(id) {
    const s = strokes.get(id);
    if (!s) return;
    strokes.delete(id);
    const set = cellIds.get(s.cell);
    if (set) set.delete(id);
    const bb = strokeBBox(s);
    for (const v of [overview, detail]) if (v.valid) repaintArtRect(v, bb.x0, bb.y0, bb.x1, bb.y1);
    requestRender();
  }

  function startStroke(sx, sy) {
    const m = screenToMap(sx, sy);
    if (!m) return;
    const id = `${myId}-${(++seq).toString(36)}`;
    const s = {
      id,
      color: state.color,
      size: currentSizeUnits(),
      erase: state.tool === 'eraser',
      k: state.tool === 'spray' ? 's' : undefined,
      t: Date.now(),
      points: [Math.round(m.x * 10) / 10, Math.round(m.y * 10) / 10],
      in: new Set(),
      user: myId,
      seen: Date.now(),
    };
    activeStrokes.set(id, s);
    drawing = { s, pending: [], lastX: m.x, lastY: m.y, ox: m.x, oy: m.y };
    liveDrawSegment(s, s.points);
    sendLive({ t: 'start', id, c: s.color, w: s.size, e: s.erase ? 1 : 0, k: s.k, p: s.points.slice() });
    requestRender();
  }

  // Paint just the newest piece of a stroke that is still being drawn.
  function liveDrawSegment(s, seg) {
    const v = curView || overview;
    if (!v.valid) return;
    const tmp = {
      id: s.id,
      color: s.color,
      size: s.size,
      erase: s.erase,
      k: s.k,
      t: s.t,
      points: seg,
      cy0: s.points[1],
    };
    const bb = strokeBBox(tmp);
    if (bb.y1 < v.win.y0 || bb.y0 > v.win.y0 + v.win.h) return;
    const ctx = v.art.getContext('2d');
    for (const dx of offsetsFor(v, bb.x0, bb.x1)) paintStroke(ctx, v, tmp, dx);
    markDirty(v, bb.x0, bb.y0, bb.x1, bb.y1);
    if (s.in) s.in.add(v);
  }

  function addPoint(sx, sy) {
    if (!drawing) return;
    const m = screenToMap(sx, sy);
    if (!m) return;
    let x = m.x;
    const y = clamp(m.y, 0, MH);
    // Keep the path continuous when it crosses the date line.
    x = drawing.lastX + wrapPi(((x - drawing.lastX) / MW) * TAU) * (MW / TAU);
    const cs = Math.max(0.05, Math.cos(yToLat(clamp(drawing.oy, 0, MH))));
    const d = Math.hypot((x - drawing.lastX) * cs, y - drawing.lastY);
    const minD = Math.max(0.6, 1.4 / pxPerUnit()) * (drawing.s.k === 's' ? 2.2 : 1);
    if (d < minD) return;
    if (
      drawing.s.points.length >= MAX_POINTS * 2 ||
      Math.abs(x - drawing.ox) * cs > MAX_SPAN ||
      Math.abs(y - drawing.oy) > MAX_SPAN
    ) {
      endStroke();
      startStroke(sx, sy);
      return;
    }
    const rx = Math.round(x * 10) / 10;
    const ry = Math.round(y * 10) / 10;
    const seg = [drawing.lastX, drawing.lastY, rx, ry];
    drawing.lastX = rx;
    drawing.lastY = ry;
    drawing.s.points.push(rx, ry);
    drawing.s.bb = null;
    drawing.pending.push(rx, ry);
    liveDrawSegment(drawing.s, seg);
    if (!flushTimer) flushTimer = setTimeout(flushPending, 45);
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
    s.bb = null;
    commitStroke(s);
    mine.push(s.id);
    if (mine.length > 400) mine.shift();
    schedulePublish(s.cell);
    sendLive({ t: 'end', s: packStroke(s) });
  }

  // ============================================================== input
  const pointers = new Map();
  let spin = null;
  let pinch = null;
  let spaceDown = false;

  // Rotate the planet so world point P lands exactly at screen (sx, sy).
  // Solved directly instead of nudged, so the globe tracks the cursor
  // instead of drifting and swinging around.
  function anchorTo(P, sx, sy) {
    if (!P) return false;
    let tx = (sx - W / 2) / cam.R;
    let ty = -(sy - H / 2) / cam.R;
    const len = Math.hypot(tx, ty);
    if (len > 0.999) {
      tx = (tx / len) * 0.999;
      ty = (ty / len) * 0.999;
    }
    const cl0 = Math.cos(P.lat);
    const vx = cl0 * Math.sin(P.lon);
    const vy = Math.sin(P.lat);
    const vz = cl0 * Math.cos(P.lon);
    let lon0 = cam.lon;
    const r1 = Math.hypot(vx, vz);
    if (r1 > 1e-6) {
      const phi = Math.atan2(-vz, vx);
      const d = Math.acos(clamp(tx / r1, -1, 1));
      const a = phi + d;
      const b = phi - d;
      lon0 = Math.abs(wrapPi(a - cam.lon)) <= Math.abs(wrapPi(b - cam.lon)) ? a : b;
    }
    const cl = Math.cos(lon0);
    const sl = Math.sin(lon0);
    const z1 = sl * vx + cl * vz;
    const r2 = Math.hypot(vy, z1);
    let lat0 = cam.lat;
    if (r2 > 1e-6) {
      const phi = Math.atan2(-z1, vy);
      const d = Math.acos(clamp(ty / r2, -1, 1));
      const opts = [phi + d, phi - d].map(wrapPi);
      const near = opts.filter((b) => Math.sin(b) * vy + Math.cos(b) * z1 > 0);
      const pick = (near.length ? near : opts).reduce(
        (best, b) => (Math.abs(wrapPi(b - cam.lat)) < Math.abs(wrapPi(best - cam.lat)) ? b : best),
        (near.length ? near : opts)[0]
      );
      lat0 = pick;
    }
    cam.lon = wrapPi(lon0);
    cam.lat = clamp(lat0, -PI / 2, PI / 2);
    requestRender();
    return true;
  }

  // Zooming toward the cursor means rotating, which reads as the planet
  // lurching when the whole globe is on screen. Fade it in as you get close.
  function anchorBlend() {
    return clamp((cam.R / Rcover() - 0.9) / 2.5, 0, 1);
  }

  function rotateBy(dx, dy) {
    cam.lon -= dx / (cam.R * Math.max(0.2, Math.cos(cam.lat)));
    cam.lat = clamp(cam.lat + dy / cam.R, -PI / 2, PI / 2);
    cam.lon = wrapPi(cam.lon);
    requestRender();
  }

  function setZoom(R, ax, ay) {
    const P = ax !== undefined ? unproject(ax, ay) : null;
    cam.R = clamp(R, Rmin(), Rmax());
    if (P) {
      const b = anchorBlend();
      if (b > 0.02) {
        const now = project(P.lon, P.lat);
        anchorTo(P, now.x + (ax - now.x) * b, now.y + (ay - now.y) * b);
      }
    }
    requestRender();
  }

  const wantsPan = (e) =>
    state.tool === 'hand' || spaceDown || e.button === 1 || e.button === 2 || !canDraw();

  glCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try {
      glCanvas.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    if (e.pointerType === 'mouse') {
      for (const [id, p] of pointers) if (p.type === 'mouse') pointers.delete(id);
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
    if (pointers.size === 2) {
      if (drawing) endStroke();
      spin = null;
      const [a, b] = [...pointers.values()];
      const mx0 = (a.x + b.x) / 2;
      const my0 = (a.y + b.y) / 2;
      pinch = { d0: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), R0: cam.R, mx: mx0, my: my0, grab: unproject(mx0, my0) };
      return;
    }
    if (pointers.size > 2) return;
    if (wantsPan(e)) {
      spin = { x: e.clientX, y: e.clientY, grab: unproject(e.clientX, e.clientY) };
      glCanvas.classList.add('grabbing');
      if (!canDraw() && e.button === 0 && state.tool !== 'hand') hintZoom();
      return;
    }
    if (e.button !== 0) return;
    startStroke(e.clientX, e.clientY);
  });

  glCanvas.addEventListener('pointermove', (e) => {
    hover.x = e.clientX;
    hover.y = e.clientY;
    hover.touch = e.pointerType === 'touch';
    if (!hover.on) hover.on = true;
    requestRender();
    const pt = pointers.get(e.pointerId);
    if (pt) {
      pt.x = e.clientX;
      pt.y = e.clientY;
    }
    if (pinch) {
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        cam.R = clamp(pinch.R0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d0), Rmin(), Rmax());
        const b2 = anchorBlend();
        if (!pinch.grab || b2 < 0.02 || !anchorTo(pinch.grab, mx, my)) {
          rotateBy(mx - pinch.mx, my - pinch.my);
        }
        pinch.mx = mx;
        pinch.my = my;
        requestRender();
      }
      return;
    }
    if (spin && pt) {
      if (!spin.grab || !anchorTo(spin.grab, e.clientX, e.clientY)) {
        rotateBy(e.clientX - spin.x, e.clientY - spin.y);
      }
      spin.x = e.clientX;
      spin.y = e.clientY;
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
    if (spin) {
      spin = null;
      glCanvas.classList.remove('grabbing');
    }
    if (drawing) endStroke();
  }
  glCanvas.addEventListener('pointerup', pointerEnd);
  glCanvas.addEventListener('pointercancel', pointerEnd);
  glCanvas.addEventListener('lostpointercapture', pointerEnd);
  glCanvas.addEventListener('pointerleave', () => {
    hover.on = false;
    requestRender();
  });
  glCanvas.addEventListener('contextmenu', (e) => e.preventDefault());

  glCanvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 16;
      else if (e.deltaMode === 2) dy *= H;
      setZoom(cam.R * Math.exp(-dy * 0.0022), e.clientX, e.clientY);
    },
    { passive: false }
  );

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
      case 'm': case 'M': togglePlaces(); break;
      case 'r': case 'R': travelTo(PLACES[Math.floor(Math.random() * PLACES.length)]); break;
      case '[': setSize(state.sizeIdx - 1); break;
      case ']': setSize(state.sizeIdx + 1); break;
      case '+': case '=': setZoom(cam.R * 1.4); break;
      case '-': case '_': setZoom(cam.R / 1.4); break;
      case '0': setZoom(Rmin()); break;
      case 'ArrowLeft': rotateBy(60, 0); break;
      case 'ArrowRight': rotateBy(-60, 0); break;
      case 'ArrowUp': rotateBy(0, 60); break;
      case 'ArrowDown': rotateBy(0, -60); break;
      case 'Escape': hidePanels(); break;
      case ' ':
        if (!spaceDown) {
          spaceDown = true;
          glCanvas.classList.add('grab');
        }
        e.preventDefault();
        break;
      default: break;
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ') {
      spaceDown = false;
      glCanvas.classList.remove('grab');
    }
  });

  // ============================================================== network
  const links = BROKERS.map((url) => ({ url, client: null, ready: false }));
  const store = new Map(); // cell key -> { dead, deadList, min, pubTimer, lastPub, lastPayload }
  const seenLive = new Set();
  const seenLiveList = [];
  let connected = false;
  let liveSeq = 0;

  const readyLinks = () => links.filter((l) => l.ready);

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
    if (!connected || now - lastCursorSend < 110) return;
    const m = screenToMap(sx, sy);
    if (!m) return;
    lastCursorSend = now;
    sendLive({ t: 'cursor', x: Math.round(m.x), y: Math.round(m.y), c: state.color === 'rainbow' ? '#f43f5e' : state.color });
  }

  function rec(key) {
    let r = store.get(key);
    if (!r) {
      r = { dead: new Set(), deadList: [], min: 0, pubTimer: null, lastPub: 0, lastPayload: '' };
      store.set(key, r);
    }
    return r;
  }
  function tombstone(r, id) {
    if (r.dead.has(id)) return;
    r.dead.add(id);
    r.deadList.push(id);
    while (r.deadList.length > DEAD_CAP) r.dead.delete(r.deadList.shift());
  }

  function undo() {
    if (drawing) endStroke();
    while (mine.length) {
      const id = mine.pop();
      const s = strokes.get(id);
      if (!s) continue;
      const key = s.cell;
      tombstone(rec(key), id);
      removeStroke(id);
      schedulePublish(key);
      sendLive({ t: 'remove', id });
      return;
    }
    banner('Nothing of yours to undo');
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
      out.push(x / 10, clamp(y / 10, 0, MH));
    }
    return out;
  }
  function packStroke(s) {
    const o = { i: s.id, c: s.color, w: Math.round(s.size * 10) / 10, t: s.t, p: packPoints(s.points) };
    if (s.erase) o.e = 1;
    if (s.k) o.k = s.k;
    return o;
  }
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  function unpackStroke(o) {
    if (!o || typeof o.i !== 'string' || o.i.length > 40 || !Array.isArray(o.p)) return null;
    if (o.p.length > MAX_POINTS * 2 + 2) return null;
    const pts = unpackPoints(o.p.filter((v) => typeof v === 'number' && Number.isFinite(v)));
    if (pts.length < 2 || pts.length > MAX_POINTS * 2) return null;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < minX) minX = pts[i];
      if (pts[i] > maxX) maxX = pts[i];
      if (pts[i + 1] < minY) minY = pts[i + 1];
      if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
    const cs = Math.max(0.05, Math.cos(yToLat(clamp(pts[1], 0, MH))));
    // Same two-axis reach limit the local pen obeys: nothing may span the planet.
    if ((maxX - minX) * cs > MAX_SPAN * 2.4 || maxY - minY > MAX_SPAN * 2.4) return null;
    const shift = Math.floor(pts[0] / MW) * MW;
    if (shift) for (let i = 0; i < pts.length; i += 2) pts[i] -= shift;
    return {
      id: o.i,
      color: o.c === 'rainbow' ? 'rainbow' : COLOR_RE.test(o.c) ? o.c.toLowerCase() : '#111318',
      size: clamp(Number(o.w) || 20, 1, 24000),
      erase: !!o.e,
      k: o.k === 's' ? 's' : undefined,
      t: Number(o.t) || 0,
      points: pts,
    };
  }

  function schedulePublish(key) {
    const r = rec(key);
    if (r.pubTimer) return;
    const wait = Math.max(500, 1800 - (performance.now() - r.lastPub)) + Math.random() * 1400;
    r.pubTimer = setTimeout(() => {
      r.pubTimer = null;
      publishCell(key);
    }, wait);
  }

  function publishCell(key) {
    const r = rec(key);
    const set = cellIds.get(key);
    let list = set ? [...set].map((id) => strokes.get(id)).filter(Boolean) : [];
    list.sort((a, b) => a.t - b.t);
    let body = { v: 1, m: r.min, d: r.deadList.slice(-DEAD_CAP), s: list.map(packStroke) };
    let payload = JSON.stringify(body);
    while (payload.length > TILE_BYTES_CAP && list.length > 1) {
      const dropped = list.splice(0, Math.max(1, Math.floor(list.length * 0.15)));
      r.min = list[0].t;
      for (const s of dropped) removeStroke(s.id);
      body = { v: 1, m: r.min, d: r.deadList.slice(-DEAD_CAP), s: list.map(packStroke) };
      payload = JSON.stringify(body);
    }
    r.lastPub = performance.now();
    if (payload === r.lastPayload) return; // the brokers already hold this exact state
    r.lastPayload = payload;
    if (!publish(TILE_TOPIC(key), payload, { qos: 1, retain: true })) setTimeout(() => schedulePublish(key), 4000);
  }

  function mergeCell(key, payload) {
    const r = rec(key);
    if (!payload || payload === r.lastPayload) return;
    let body;
    try {
      body = JSON.parse(payload);
    } catch {
      return;
    }
    if (!body || !Array.isArray(body.s)) return;
    r.lastPayload = payload;
    let republish = false;
    // A watermark is only ever "strokes older than this were dropped when the
    // cell filled up". One dated in the future is nonsense, so ignore it.
    if (typeof body.m === 'number' && body.m > r.min && body.m <= Date.now() + 60000) r.min = body.m;
    if (Array.isArray(body.d)) {
      for (const id of body.d.slice(0, DEAD_CAP * 2)) {
        if (typeof id !== 'string' || id.length > 40) continue;
        if (!r.dead.has(id)) tombstone(r, id);
        // A tombstone only speaks for the cell it arrived in; it cannot reach
        // across the planet and delete a stroke filed somewhere else.
        const victim = strokes.get(id);
        if (victim && victim.cell === key) removeStroke(id);
      }
    }
    const seen = new Set();
    for (const o of body.s.slice(0, MAX_TILE_STROKES)) {
      const s = unpackStroke(o);
      if (!s) continue;
      if (r.dead.has(s.id) || s.t < r.min) {
        republish = true;
        continue;
      }
      seen.add(s.id);
      if (!strokes.has(s.id)) commitStroke(s);
    }
    const set = cellIds.get(key);
    if (set) {
      for (const id of [...set]) {
        if (seen.has(id)) continue;
        const s = strokes.get(id);
        if (!s) {
          set.delete(id);
          continue;
        }
        if (s.t < r.min) removeStroke(id);
        else republish = true;
      }
    }
    if (republish) schedulePublish(key);
    else if (r.pubTimer) {
      // Someone else already published state we agree with, so stand down
      // instead of every client echoing the same reconciliation.
      clearTimeout(r.pubTimer);
      r.pubTimer = null;
    }
  }

  // Token bucket per sender. A person drawing hard sends ~25 messages a second;
  // a flood gets clipped to RATE_REFILL and stops costing us paint work.
  const buckets = new Map();
  const COST = { start: 3, move: 1, end: 4, remove: 4, cursor: 1, hello: 1 };
  function allowLive(u, kind) {
    const now = performance.now();
    let b = buckets.get(u);
    if (!b) {
      if (buckets.size >= MAX_PEERS) return false;
      b = { tokens: RATE_BURST, last: now };
      buckets.set(u, b);
    }
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.last) / 1000) * RATE_REFILL);
    b.last = now;
    const cost = COST[kind] || 2;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  function dropActive(s) {
    if (!activeStrokes.delete(s.id)) return;
    const bb = strokeBBox(s);
    for (const v of [overview, detail]) if (v.valid) repaintArtRect(v, bb.x0, bb.y0, bb.x1, bb.y1);
  }

  // A tab that closes mid-stroke never sends an end, so without this the stroke
  // would live forever and keep the render loop awake.
  function sweepActive() {
    const cut = Date.now() - ACTIVE_TIMEOUT;
    let dropped = false;
    for (const s of [...activeStrokes.values()]) {
      if (drawing && drawing.s.id === s.id) continue;
      if ((s.seen || s.t) < cut) {
        dropActive(s);
        dropped = true;
      }
    }
    for (const [u, b] of buckets) if (performance.now() - b.last > 120000) buckets.delete(u);
    if (dropped) requestRender();
  }
  setInterval(sweepActive, 3000);

  function admitActive(s) {
    let ownCount = 0;
    let oldestOwn = null;
    for (const a of activeStrokes.values()) {
      if (a.user !== s.user) continue;
      ownCount++;
      if (!oldestOwn || (a.seen || a.t) < (oldestOwn.seen || oldestOwn.t)) oldestOwn = a;
    }
    if (ownCount >= ACTIVE_PER_USER && oldestOwn) dropActive(oldestOwn);
    while (activeStrokes.size >= ACTIVE_TOTAL) {
      let oldest = null;
      for (const a of activeStrokes.values()) {
        if (drawing && drawing.s.id === a.id) continue;
        if (!oldest || (a.seen || a.t) < (oldest.seen || oldest.t)) oldest = a;
      }
      if (!oldest) break;
      dropActive(oldest);
    }
    activeStrokes.set(s.id, s);
  }

  function onLive(payload) {
    let m;
    try {
      m = JSON.parse(payload);
    } catch {
      return;
    }
    if (!m || typeof m.u !== 'string' || m.u === myId) return;
    const key = `${m.u}:${m.n}`;
    if (seenLive.has(key)) return;
    seenLive.add(key);
    seenLiveList.push(key);
    while (seenLiveList.length > 4000) seenLive.delete(seenLiveList.shift());
    if (!allowLive(m.u, m.t)) return;
    if (users.size < MAX_PEERS || users.has(m.u)) users.set(m.u, performance.now());
    switch (m.t) {
      case 'start': {
        const s = unpackStroke({ i: m.id, c: m.c, w: m.w, e: m.e, k: m.k, t: Date.now(), p: packPoints(Array.isArray(m.p) ? m.p.slice(0, 2) : []) });
        if (!s || !s.id.startsWith(`${m.u}-`)) return;
        s.in = new Set();
        s.user = m.u;
        s.seen = Date.now();
        admitActive(s);
        liveDrawSegment(s, s.points);
        requestRender();
        break;
      }
      case 'move': {
        const s = activeStrokes.get(m.id);
        if (!s || !Array.isArray(m.p) || s.user !== m.u) return;
        s.seen = Date.now();
        const budget = Math.min(MAX_MOVE_POINTS, (MAX_POINTS * 2 - s.points.length) / 2);
        if (budget <= 0) return;
        const end = Math.min(m.p.length, budget * 2);
        for (let i = 0; i + 1 < end; i += 2) {
          const x = m.p[i];
          const y = m.p[i + 1];
          if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) continue;
          const seg = [s.points[s.points.length - 2], s.points[s.points.length - 1], x, clamp(y, 0, MH)];
          s.points.push(x, clamp(y, 0, MH));
          s.bb = null;
          liveDrawSegment(s, seg);
        }
        requestRender();
        break;
      }
      case 'end': {
        const s = unpackStroke(m.s);
        if (!s || !s.id.startsWith(`${m.u}-`)) return;
        const old = activeStrokes.get(s.id);
        activeStrokes.delete(s.id);
        if (old) s.in = old.in;
        commitStroke(s);
        break;
      }
      case 'remove':
        if (typeof m.id === 'string' && m.id.startsWith(`${m.u}-`)) {
          const s = strokes.get(m.id);
          activeStrokes.delete(m.id);
          if (s) {
            tombstone(rec(s.cell), m.id);
            removeStroke(m.id);
          }
        }
        break;
      case 'cursor':
        if (typeof m.x === 'number' && typeof m.y === 'number' && (cursors.size < MAX_CURSORS || cursors.has(m.u))) {
          cursors.set(m.u, { x: m.x, y: m.y, c: COLOR_RE.test(m.c) ? m.c : '#111318', t: performance.now() });
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
    if (topic === LIVE_TOPIC) onLive(payload);
    else if (topic.startsWith(`${ROOT}/tile/`)) mergeCell(topic.slice(ROOT.length + 6), payload);
  }

  function connect() {
    if (typeof mqtt === 'undefined') {
      setStatus('Offline', 'off');
      return;
    }
    for (const l of links) {
      let client;
      try {
        client = mqtt.connect(l.url, {
          connectTimeout: 9000,
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
          client.subscribe([LIVE_TOPIC, `${ROOT}/tile/+`], { qos: 0 });
        } catch {
          /* retried on reconnect */
        }
        updateConnection();
        sendLive({ t: 'hello' });
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
    setStatus(connected ? 'Live' : 'Reconnecting', connected ? 'live' : 'off');
    updateUsers();
  }
  function updateUsers() {
    const now = performance.now();
    let n = 1;
    for (const [id, t] of users) {
      if (now - t > 45000) users.delete(id);
      else n++;
    }
    usersEl.textContent = String(n);
  }
  setInterval(() => {
    if (connected) sendLive({ t: 'hello' });
    updateUsers();
  }, 15000);

  // ============================================================== ui
  const $ = (s) => document.querySelector(s);
  const placeName = $('#placeName');
  const placeSub = $('#placeSub');
  const statusDot = $('#statusDot');
  const statusText = $('#statusText');
  const usersEl = $('#users');
  const kmLabel = $('#kmLabel');
  const colorPicker = $('#colorPicker');
  const customColor = $('.custom-color');
  const help = $('#help');
  const places = $('#places');
  const bannerEl = $('#banner');
  let bannerTimer = null;

  function banner(text) {
    bannerEl.textContent = text;
    bannerEl.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => bannerEl.classList.remove('show'), 2200);
  }
  let lastHint = 0;
  function hintZoom() {
    const now = performance.now();
    if (now - lastHint < 2500) return;
    lastHint = now;
    banner('Too far out to draw. Zoom in closer to the surface.');
  }
  function setStatus(text, cls) {
    statusText.textContent = text;
    statusDot.className = `dot ${cls}`;
  }
  function hidePanels() {
    help.classList.add('hidden');
    places.classList.add('hidden');
  }

  let lastPlace = '';
  let lastCan = null;
  function updateHud() {
    const km = viewKm();
    kmLabel.textContent = km >= 1000 ? `${Math.round(km / 100) / 10}k km` : `${Math.round(km)} km`;
    const p = placeAt(lonToX(cam.lon), latToY(cam.lat));
    if (p !== lastPlace) {
      lastPlace = p;
      placeName.textContent = p;
    }
    const cd = canDraw();
    if (cd !== lastCan) {
      lastCan = cd;
      placeSub.textContent = cd ? 'Close enough to draw' : 'Zoom in to draw here';
      document.body.classList.toggle('nodraw', !cd);
    }
  }

  function setTool(tool) {
    state.tool = tool;
    document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
    glCanvas.classList.toggle('tool-hand', tool === 'hand');
    glCanvas.classList.toggle('tool-eraser', tool === 'eraser');
    if (tool !== 'hand' && !canDraw()) hintZoom();
  }
  function setColor(color, fromPicker) {
    state.color = color;
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', !fromPicker && b.dataset.color === color));
    customColor.classList.toggle('active', !!fromPicker);
    if (fromPicker) colorPicker.value = color;
    if (state.tool === 'eraser' || state.tool === 'hand') setTool('pen');
  }
  function setSize(i) {
    state.sizeIdx = clamp(i, 0, SIZE_PX.length - 1);
    document.querySelectorAll('.size').forEach((b, n) => b.classList.toggle('active', n === state.sizeIdx));
  }

  function travelTo(place) {
    cam.lon = place.lon * DEG;
    cam.lat = place.lat * DEG;
    setZoom(Math.max(Rdraw() * 1.15, Rcover() * 6));
    banner(place.name);
    hidePanels();
  }

  // Places panel: a flat map of the planet you can click to travel.
  const mini = $('#mini');
  const miniCtx = mini.getContext('2d');
  function paintMini() {
    mini.width = 640;
    mini.height = 320;
    miniCtx.drawImage(overview.comp, 0, 0, mini.width, mini.height);
    miniCtx.font = '600 9px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    miniCtx.textAlign = 'center';
    for (const pl of PLACES) {
      const x = (lonToX(pl.lon * DEG) / MW) * mini.width;
      const y = (latToY(pl.lat * DEG) / MH) * mini.height;
      miniCtx.fillStyle = 'rgba(255,255,255,0.85)';
      miniCtx.strokeStyle = 'rgba(0,0,0,0.5)';
      miniCtx.lineWidth = 2.5;
      miniCtx.strokeText(pl.name, x, y);
      miniCtx.fillText(pl.name, x, y);
    }
    const cx = (lonToX(cam.lon) / MW) * mini.width;
    const cy = (latToY(cam.lat) / MH) * mini.height;
    miniCtx.strokeStyle = '#f43f5e';
    miniCtx.lineWidth = 2;
    miniCtx.beginPath();
    miniCtx.arc(cx, cy, 6, 0, TAU);
    miniCtx.stroke();
  }
  function togglePlaces() {
    const show = places.classList.contains('hidden');
    hidePanels();
    if (!show) return;
    places.classList.remove('hidden');
    if (overview.valid) {
      compositeRect(overview, 0, 0, overview.cw, overview.ch);
      paintMini();
    }
  }
  mini.addEventListener('click', (e) => {
    const r = mini.getBoundingClientRect();
    const lon = xToLon(((e.clientX - r.left) / r.width) * MW);
    const lat = yToLat(((e.clientY - r.top) / r.height) * MH);
    travelTo({ name: placeAt(lonToX(lon), latToY(lat)), lon: lon / DEG, lat: lat / DEG });
  });

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
  SIZE_PX.forEach((px, i) => {
    const b = document.createElement('button');
    b.className = 'size';
    b.title = `Brush ${px}`;
    b.setAttribute('aria-label', b.title);
    const dot = document.createElement('span');
    dot.className = 'dot';
    const d = clamp(3 + px * 0.42, 4, 24);
    dot.style.width = `${d}px`;
    dot.style.height = `${d}px`;
    b.appendChild(dot);
    b.addEventListener('click', () => setSize(i));
    sizesEl.appendChild(b);
  });

  $('#undoBtn').addEventListener('click', undo);
  $('#zoomIn').addEventListener('click', () => setZoom(cam.R * 1.5));
  $('#zoomOut').addEventListener('click', () => setZoom(cam.R / 1.5));
  $('#fitBtn').addEventListener('click', () => setZoom(Rmin()));
  $('#placesBtn').addEventListener('click', togglePlaces);
  $('#placePill').addEventListener('click', togglePlaces);
  $('#randomBtn').addEventListener('click', () => travelTo(PLACES[Math.floor(Math.random() * PLACES.length)]));
  $('#placesClose').addEventListener('click', hidePanels);
  $('#helpBtn').addEventListener('click', () => {
    const show = help.classList.contains('hidden');
    hidePanels();
    if (show) help.classList.remove('hidden');
  });
  $('#helpClose').addEventListener('click', hidePanels);

  // ============================================================== boot
  let lastHash = '';
  let lastHashAt = 0;
  function updateHash() {
    const h = `#${(cam.lon / DEG).toFixed(2)},${(cam.lat / DEG).toFixed(2)},${(cam.R / Rcover()).toFixed(3)}`;
    const now = performance.now();
    if (h === lastHash || now - lastHashAt < 600) return;
    lastHash = h;
    lastHashAt = now;
    history.replaceState(null, '', h);
  }
  function readHash() {
    const m = /^#(-?[\d.]+),(-?[\d.]+),([\d.]+)$/.exec(location.hash);
    if (!m) return;
    const lon = Number(m[1]) * DEG;
    const lat = Number(m[2]) * DEG;
    const z = Number(m[3]);
    if (![lon, lat, z].every(Number.isFinite)) return;
    cam.lon = wrapPi(lon);
    cam.lat = clamp(lat, -PI / 2, PI / 2);
    cam.R = clamp(z * Rcover(), Rmin(), Rmax());
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    for (const c of [stars, glCanvas, overlay]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    paintStars();
    cam.R = clamp(cam.R, Rmin(), Rmax());
    detail.valid = false;
    requestRender();
  }
  window.addEventListener('resize', resize);
  window.addEventListener('hashchange', () => {
    readHash();
    requestRender();
  });

  window.__pixelCanvas = {
    get strokes() { return strokes.size; },
    get brokers() { return readyLinks().map((l) => l.url); },
    get place() { return placeAt(lonToX(cam.lon), latToY(cam.lat)); },
    get canDraw() { return canDraw(); },
    get km() { return viewKm(); },
    get lastError() { return lastError && String(lastError.stack || lastError); },
    get gl() { return !glFail; },
    get view() { return curView === overview ? 'overview' : 'detail'; },
    cam,
    forceFrame: frame,
    get active() { return activeStrokes.size; },
    get cursors() { return cursors.size; },
    get activePoints() { return [...activeStrokes.values()].map((a) => a.points.length / 2); },
    strokeCell: (id) => { const x = strokes.get(id); return x && x.cell; },
    lastStroke: () => [...strokes.keys()].pop(),
    places: PLACES,
    travelTo,
    setZoom,
    project,
    unproject,
  };

  initGL();
  if (glFail) document.getElementById('nogl').classList.remove('hidden');
  setTool('pen');
  setColor(PALETTE[0], false);
  setSize(1);
  cam.R = 0;
  resize();
  cam.R = Rmin();
  readHash();
  requestRender();
  connect();
  try {
    if (!localStorage.getItem('pxc3-seen')) {
      localStorage.setItem('pxc3-seen', '1');
      help.classList.remove('hidden');
    }
  } catch {
    /* private mode */
  }
})();
