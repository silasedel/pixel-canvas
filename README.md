# Pixel Canvas

One massive shared canvas. Anyone with the link can open it and draw on the same board at the same time, and everyone sees each other's strokes live.

- 16,384 × 16,384 unit canvas you can zoom (4% to 1600%) and pan around
- Pen with 12 preset colors plus a custom color picker, five thicknesses, and an eraser
- Live cursors and an online counter so you can see who else is around
- Undo your own last stroke (Ctrl / ⌘ + Z)
- Share the URL to bring people to the exact spot you are looking at (the position is stored in the hash)
- Works with mouse, trackpad, touch (pinch to zoom) and pen input

## Controls

| Action | How |
| --- | --- |
| Draw | Click or touch and drag |
| Pan | Scroll, hand tool (H), hold Space and drag, or middle / right drag |
| Zoom | Ctrl / ⌘ + scroll, pinch, or the + / − keys. 0 resets to 100% |
| Tools | P pen, E eraser, `[` and `]` change thickness |
| Undo | Ctrl / ⌘ + Z removes your last stroke |

## Run it locally

```bash
npm install
npm start
```

Then open http://localhost:3000. Open it in a second window to see the live sync.

## How it works

- `server.js` is a small Node.js server with no framework. It serves the static client and runs a WebSocket endpoint at `/ws` using the `ws` package.
- Strokes are vector data: `{ id, color, size, erase, points: [x0, y0, x1, y1, ...] }` in canvas units. Every connected client receives strokes as they are drawn (`start`, `move`, `end`) so drawing appears live, not just after mouse-up.
- The server keeps all strokes in memory and saves them to `data/strokes.json` a few seconds after each change. Set `DATA_DIR` to store the file somewhere else, for example on a persistent disk. The newest 60,000 strokes are kept.
- The client splits the world into 512-unit tiles. Each visible tile is rasterized once to an offscreen bitmap at the current zoom level, so panning is cheap and lines stay crisp when you zoom in. Strokes in progress are drawn on top as vectors.

## Deploy

The app is a single long-running Node process, so it needs a host that supports WebSockets (Render, Fly.io, Railway, a VPS, or any Docker host). It listens on `PORT`.

### Render

The repo contains a `render.yaml` Blueprint. Click the button, or create a new **Web Service** from this repo in the Render dashboard.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/silasedel/pixel-canvas)

Note: the free plan has no persistent disk, so the canvas resets when the service restarts or redeploys. Attach a disk and set `DATA_DIR` to its mount path to keep drawings forever.

### Docker

```bash
docker build -t pixel-canvas .
docker run -p 3000:3000 -v pixel-canvas-data:/app/data pixel-canvas
```

## License

MIT
