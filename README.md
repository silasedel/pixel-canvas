# Pixel Canvas

A shared planet. Anyone with the link can spin it, drop down to the surface and draw on it, and everyone sees each other's marks live. Whatever gets drawn stays on the planet.

## Play

**https://silasedel.github.io/pixel-canvas/** — that's it. Works on any phone or computer, nothing to install, no sign-up.

- A whole globe you can spin and zoom, about 40,000 km around, with continents, oceans, ice caps, biomes and a graticule
- Named places: eleven continents and nine seas, each generated the same way for everyone
- **You can only draw close to the surface**, under about 1,200 km across. Zoomed out you can look but not touch, so nobody can scribble a line across a continent
- Pen, spray can, eraser, twelve colors plus rainbow ink and a custom picker, five brush sizes, and undo
- Live cursors, an online counter, and a flat map (M) you can click to travel anywhere
- A brush ring on the cursor showing exactly where your mark will land and how big it will be
- The URL carries where you are looking, so sharing it drops people on the same spot

## Controls

| Action | How |
| --- | --- |
| Spin | Drag the planet. Whatever you grab stays under your cursor. Arrow keys work too |
| Zoom | Scroll, pinch, or the + and − keys. 0 pulls back to the whole planet |
| Draw | Only near the surface. P pen, S spray can, E eraser, `[` and `]` change size |
| Travel | M opens the flat map, R drops you somewhere random |
| Undo | Ctrl / ⌘ + Z removes your last stroke |

## How it works

There is no server of its own. The site is three static files on GitHub Pages, and all the multiplayer goes through public MQTT brokers over WebSockets (EMQX, HiveMQ and Mosquitto's test broker), the same approach as [Pinpoint](https://github.com/silasedel/pinpoint).

- **The planet** is generated from a fixed seed: continents are unions of wobbly spherical blobs, so coastlines are real polygons that stay crisp at any zoom and every client draws an identical world without downloading a map.
- **The globe** is drawn in WebGL. A sphere mesh is projected orthographically in the vertex shader, and the fragment shader samples an equirectangular texture. Two textures are kept: one of the whole world, updated as strokes arrive, and one covering just the patch you are looking at, rebuilt when you move. That is what keeps a planet-sized canvas sharp when you are 50 km above it.
- **Camera moves** are solved directly rather than nudged. Dragging works out the rotation that puts the grabbed point exactly under the cursor, so the planet never drifts or swings. Zooming toward the cursor is faded out as you pull back, because on a globe it means rotating, which looks like a lurch when the whole planet is on screen; far out, zoom simply stays centred.
- **Strokes** are vector data in map units, stored as `{ id, color, size, erase, t, points }` with points delta-encoded. Because the projection stretches longitude, the brush is widened by `1 / cos(latitude)` when painting, so a round pen stays round once it is on the sphere.
- **Live drawing** streams on one topic (`pixelcanvas/v3/live`) as `start`, `move` and `end` messages, plus cursors and a heartbeat. Every message goes to all three brokers and is de-duplicated on arrival, so the world works as long as any one broker is up.
- **Persistence** uses retained messages. The planet is split into a 16 × 8 grid of storage cells, each one retained message (`pixelcanvas/v3/tile/<x>_<y>`). Clients subscribe to all of them, so you always see the whole world from orbit. Finishing a stroke republishes its cell; every client merges what it receives with what it knows and republishes the union, and undo writes a tombstone so a removed stroke does not come back. Each cell is capped at about 90 KB; past that the oldest strokes in that cell are forgotten.

## What the brokers can and cannot protect

The brokers are public and anonymous, so anything a browser can publish, anyone can publish. The client treats every inbound message as hostile and bounds what one sender can make your tab do:

- Unfinished strokes expire after 12 seconds, are capped at 3 per sender and 40 overall, and no longer keep the animation loop awake forever when someone closes their tab mid-stroke.
- Each sender gets a token bucket of 70 messages a second; one move message can add at most 600 points, and a stroke can never exceed the point or reach limits the local pen obeys, on either axis.
- A tombstone only deletes strokes filed in the cell it arrived in, and a cell's "old strokes were dropped" watermark is ignored if it is dated in the future.
- Once one client publishes a reconciled cell, the others cancel their queued copies instead of all echoing it, and publishes are jittered.

What this design cannot do is prove who drew what. There is no server and no authentication, so a determined person can forge a delete for someone else's stroke. That matters less than it sounds: this is an open canvas where any visitor can already erase anything with the eraser. Binding strokes to authors would need a real backend, which would mean an account to run and pay for. If the planet ever needs protected artwork, that is the change to make.

## Run it locally

Any static file server works, for example:

```bash
python3 -m http.server 3000
```

Then open http://localhost:3000. Open a second window to see the live sync.

## License

MIT
