'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'strokes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Canvas is WORLD x WORLD units. Clients tile it for rendering.
const WORLD = 16384;
const MAX_STROKES = 60000; // oldest strokes are dropped past this
const MAX_POINTS = 4000; // per stroke
const MIN_SIZE = 1;
const MAX_SIZE = 64;
const SAVE_DELAY_MS = 3000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

let strokes = []; // committed strokes, oldest first
const active = new Map(); // strokes still being drawn, by id

// ---------------------------------------------------------------- persistence

function isStoredStroke(s) {
  return (
    s &&
    typeof s.id === 'string' &&
    typeof s.color === 'string' &&
    typeof s.size === 'number' &&
    Array.isArray(s.points) &&
    s.points.length >= 2
  );
}

function loadStrokes() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed)) {
      strokes = parsed.filter(isStoredStroke);
      console.log(`Loaded ${strokes.length} strokes from ${DATA_FILE}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not load strokes:', err.message);
  }
}

let saveTimer = null;
let saving = false;
let saveAgain = false;

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, SAVE_DELAY_MS);
}

async function saveNow() {
  if (saving) {
    saveAgain = true;
    return;
  }
  saving = true;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(strokes));
    await fs.promises.rename(tmp, DATA_FILE);
  } catch (err) {
    console.error('Could not save strokes:', err.message);
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      scheduleSave();
    }
  }
}

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end();
    return;
  }
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    res.end();
    return;
  }
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// ---------------------------------------------------------------- websockets

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: 256 * 1024,
  perMessageDeflate: true,
});

const clients = new Map(); // ws -> client record

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, except) {
  const data = JSON.stringify(obj);
  for (const ws of clients.keys()) {
    if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function num(v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(max, Math.max(min, v));
}

// Points travel as a flat [x0, y0, x1, y1, ...] array.
function cleanPoints(arr, maxPoints) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (let i = 0; i + 1 < arr.length && out.length < maxPoints * 2; i += 2) {
    const x = num(arr[i], 0, WORLD);
    const y = num(arr[i + 1], 0, WORLD);
    if (x === null || y === null) continue;
    out.push(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  }
  return out;
}

function finishStroke(id) {
  const s = active.get(id);
  if (!s) return;
  active.delete(id);
  strokes.push(s);
  if (strokes.length > MAX_STROKES) {
    const drop = strokes.length - MAX_STROKES;
    strokes.splice(0, drop);
    broadcast({ t: 'trim', n: drop });
  }
  scheduleSave();
}

function handleMessage(ws, client, msg) {
  switch (msg.t) {
    case 'start': {
      if (typeof msg.id !== 'string' || msg.id.length > 40 || !msg.id.startsWith(`${client.id}-`)) return;
      if (active.has(msg.id) || client.activeCount >= 4) return;
      const points = cleanPoints(msg.p, 1);
      if (!points.length) return;
      const color = COLOR_RE.test(msg.color) ? msg.color.toLowerCase() : '#1a1a1a';
      const size = num(msg.size, MIN_SIZE, MAX_SIZE) ?? 5;
      const s = { id: msg.id, user: client.id, color, size, erase: !!msg.erase, points };
      active.set(s.id, s);
      client.activeCount++;
      if (!s.erase) client.color = color;
      broadcast({ t: 'start', s }, ws);
      break;
    }
    case 'move': {
      const s = active.get(msg.id);
      if (!s || s.user !== client.id) return;
      const remaining = MAX_POINTS - s.points.length / 2;
      if (remaining <= 0) return;
      const points = cleanPoints(msg.p, remaining);
      if (!points.length) return;
      for (const v of points) s.points.push(v);
      broadcast({ t: 'move', id: s.id, p: points }, ws);
      break;
    }
    case 'end': {
      const s = active.get(msg.id);
      if (!s || s.user !== client.id) return;
      client.activeCount--;
      finishStroke(s.id);
      broadcast({ t: 'end', id: s.id }, ws);
      break;
    }
    case 'cursor': {
      const now = Date.now();
      if (now - client.lastCursor < 40) return;
      client.lastCursor = now;
      const x = num(msg.x, -WORLD, 2 * WORLD);
      const y = num(msg.y, -WORLD, 2 * WORLD);
      if (x === null || y === null) return;
      broadcast({ t: 'cursor', id: client.id, x, y, c: client.color }, ws);
      break;
    }
    case 'undo': {
      for (let i = strokes.length - 1; i >= 0; i--) {
        if (strokes[i].user === client.id) {
          const [s] = strokes.splice(i, 1);
          broadcast({ t: 'remove', id: s.id });
          scheduleSave();
          return;
        }
      }
      break;
    }
    default:
      break;
  }
}

wss.on('connection', (ws) => {
  const client = {
    id: crypto.randomBytes(4).toString('hex'),
    color: '#1a1a1a',
    alive: true,
    activeCount: 0,
    lastCursor: 0,
  };
  clients.set(ws, client);

  send(ws, {
    t: 'init',
    id: client.id,
    world: WORLD,
    strokes,
    active: [...active.values()],
    users: clients.size,
  });
  broadcast({ t: 'users', n: clients.size }, ws);

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    handleMessage(ws, client, msg);
  });

  ws.on('close', () => {
    clients.delete(ws);
    for (const [id, s] of active) {
      if (s.user === client.id) {
        finishStroke(id);
        broadcast({ t: 'end', id });
      }
    }
    broadcast({ t: 'leave', id: client.id });
    broadcast({ t: 'users', n: clients.size });
  });

  ws.on('error', () => ws.terminate());
});

// Drop dead connections.
const heartbeat = setInterval(() => {
  for (const [ws, client] of clients) {
    if (!client.alive) {
      ws.terminate();
      continue;
    }
    client.alive = false;
    ws.ping();
  }
}, 30000);

function shutdown() {
  clearInterval(heartbeat);
  if (saveTimer) clearTimeout(saveTimer);
  saveNow().finally(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

loadStrokes();
server.listen(PORT, () => {
  console.log(`Pixel Canvas listening on http://localhost:${PORT}`);
});
