# Pixel Canvas

A gigantic shared canvas. Anyone with the link can open it and draw on the same board at the same time, and everyone sees each other's strokes live. Drawings stay on the canvas for everyone who comes later.

The canvas is 262,144 × 262,144 units, split into 256 named regions, and every region changes how drawing works.

## Play

**https://silasedel.github.io/pixel-canvas/** — that's it. Works on any phone or computer, nothing to install, no sign-up.

- 256 regions with their own rules: The Void (everything glows on black), Kaleidoscope (every stroke mirrored eight ways), Pixel Land (chunky grid), Rainbow Reach, The Tides (drawings wash away after an hour), Giant Country, Tiny Town, Wobble Woods, Sketchbook, Blueprint, Negative Zone, Drip City, Echo Chamber, Glitch Grid, Chalkboard, and plain Open Canvas
- World map (M) to teleport anywhere, R for a random region, F to see the whole region you are in
- Pen, spray can, eraser, 12 preset colors plus rainbow ink and a custom color picker, five thicknesses
- Live cursors and an online counter so you can see who else is around
- Undo your own last stroke (Ctrl / ⌘ + Z)
- Share the URL to bring people to the exact spot you are looking at (the position is stored in the hash)
- Works with mouse, trackpad, touch (pinch to zoom) and pen input

## Controls

| Action | How |
| --- | --- |
| Draw | Click or touch and drag. P pen, S spray can, E eraser |
| Pan | Scroll, hand tool (H), hold Space and drag, or middle / right drag |
| Zoom | Ctrl / ⌘ + scroll, pinch, or the + / − keys. 0 resets to 100%, F fits the region |
| Travel | M opens the world map, R teleports somewhere random |
| Tools | P pen, E eraser, `[` and `]` change thickness |
| Undo | Ctrl / ⌘ + Z removes your last stroke |

## How it works

There is no server of its own. The site is three static files on GitHub Pages, and all the multiplayer goes through public MQTT brokers over WebSockets (EMQX, HiveMQ and Mosquitto's test broker), the same approach as [Pinpoint](https://github.com/silasedel/pinpoint).

- **Live drawing** is streamed on one topic (`pixelcanvas/v2/live`) as `start`, `move` and `end` messages, plus cursor positions and a heartbeat for the online count. Every message goes to all three brokers and is de-duplicated on arrival, so the board works as long as any one of them is up.
- **Persistence** uses retained messages. The canvas is split into 256 × 256 storage tiles of 1024 units, and each tile is one retained message (`pixelcanvas/v2/tile/<x>_<y>`) holding the strokes that start in it. A client only subscribes to the tiles it is looking at (plus their mirror images in Kaleidoscope regions), so the download stays small no matter how big the canvas gets. When you finish a stroke your browser republishes its tile.
- **Regions** are deterministic: names and effects come from a seeded hash of the region coordinates, so every client agrees without any shared config. Effects are applied at render time from the stroke's first point, so the stored data is the same plain vector stroke everywhere.
- **Conflicts** are resolved by merging: every client that receives a tile compares it with what it knows and republishes the union if the brokers are missing something. Undo writes a tombstone so a removed stroke does not come back. Each tile is capped at about 150 KB; past that the oldest strokes in that tile are forgotten.
- **Rendering** splits the world into 512-unit tiles that are rasterized to offscreen bitmaps at the current zoom level, so panning is cheap and lines stay crisp when you zoom in. Strokes in progress are drawn on top as vectors.

Strokes are vector data: `{ id, color, size, erase, t, points }` with points delta-encoded in tenths of a unit.

## Run it locally

Any static file server works, for example:

```bash
python3 -m http.server 3000
```

Then open http://localhost:3000. Open it in a second window to see the live sync.

## License

MIT
