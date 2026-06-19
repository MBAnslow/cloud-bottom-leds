# Cloud Bottom LEDs

**A tool for visualising potential LED light setups for our installation** — a
lit, cloud-like surface with LED strips behind it.

It simulates LED-strip lighting patterns behind a bumpy, diffuse **cloud**
surface so we can preview what a build will actually look like — and stream the
exact same frames live to real LED strips to verify on hardware.

The point is to make real-world decisions *before* buying anything: how many
LEDs, which product, how far behind the cloud to mount them, and how diffuse the
material needs to be to get an even glow instead of visible hotspots.

The pattern engine is the single source of truth: every frame it computes an
RGB color for each LED, which feeds **both** the on-screen cloud visualizer and
the bytes sent to the hardware. What you see is what the strips show.

![grid](docs/placeholder) <!-- run it and screenshot -->

## Features

This is a **build-planning tool**: the controls are physical quantities so the
preview predicts what the real installation will look like.

- **Cloud dimensions** — set the physical width/height of the cloud (mm). The
  rows × columns are spread evenly inside it, so the LED pitch is derived for you.
- **LED type** — pick a real product (WS2812B 30/60/144/m, WS2815, SK6812 RGBW,
  APA102/HD107s, WS2811 bullet nodes). Each changes the look (beam spread,
  relative brightness, and RGBW white rendering) and the buy estimate.
- **Physical overlap limit** — every LED type has a real package footprint and
  strip width, so the rows/cols are capped to what physically fits in the cloud
  (you can't place LEDs on top of each other). This is separate from the *light*
  overlapping through the diffuser, which is expected and desirable. The light
  spot itself is modeled as an isotropic (round) spread in millimetres — only
  the overlap with neighbours changes with pitch, the dot never stretches.
- **Build estimate** — a live read-out of total LEDs, derived pitch, the LED/m
  density needed along each row, how much strip (or how many nodes) to buy, and
  whether that's feasible with the chosen product. This is how you size the order.
- **LEDs (physical)** — brightness/drive gain (bright + close + clear = white
  hotspots; dim = soft colored dots) and the pattern update rate in fps (the
  controller's animation refresh — see how choppy 15 fps looks vs 60).
- **Diffuser (physical)** — LED-to-diffuser distance (mm), the material's own
  haze (mm), and opacity (% of light blocked). Distance and pitch together
  decide whether you see hotspots or an even glow.
- **Cloud surface** — a static, bumpy physical surface (bumpiness, scale,
  detail). Thicker bumps block more light. Only the LEDs animate.
- **Patterns** — plasma, rainbow waves, twinkle, fire, aurora drift, breathe,
  rain, solid. Plus speed, content level, and hue-shift.
- **Breathing** — split the cloud into 2–6 vertical partitions, each with its
  own base colour and a slow, phase-staggered "breathe" pulse that mixes with
  whatever pattern is running (the pulse is baked into the LED buffer, so the
  preview and the streamed hardware stay identical). A left-hand oscilloscope
  shows each partition's breathing waveform live, in its base colour.

The controls are grouped into three menus: **Hardware** (cloud size, LED grid,
build estimate, diffuser, streaming), **Pattern** (the animated content and the
cloud surface look), and **Breathing** (partitions, rate/depth/mix, base colours).
- **Live hardware streaming** — pushes frames to a [WLED](https://kno.wled.ge/)
  controller over its real-time UDP protocol (DNRGB), with serpentine or
  row-major wiring and a configurable frame rate.

## The physical model (so you can trust the preview)

Each LED's light spreads onto the diffuser as a **flux-conserving 2-D Gaussian**.
The spread (std-dev) in millimetres is:

```
sigma_mm = sqrt( (distance * 0.5)^2  +  haze^2 )
```

- `distance * 0.5` is the geometric spread of the light cone between the LED and
  the diffuser (an effective ~27° half-angle).
- `haze` is the diffuser sheet's intrinsic blur, added in quadrature (which is
  how convolving two Gaussians combines).

What matters for uniformity is the spread **relative to the LED pitch**
(`sigma_mm / pitch_mm`), shown live in the HUD:

| spread / pitch | look | meaning |
| --- | --- | --- |
| < 0.6 | **hotspots** | individual LEDs / rows visible |
| 0.6–1.0 | **soft dots** | gentle texture, LEDs still readable |
| > 1.0 | **even** | smooth wash, no hotspots |

Because the Gaussian conserves flux, moving the LEDs farther back both widens
**and** dims each spot — so the total light is preserved while hotspots vanish.
That's the real distance-vs-uniformity tradeoff. The pitches are independent per
axis, so if your rows are farther apart than the LEDs along a strip you'll see
horizontal banding appear before the LEDs merge sideways (as is typical).

A practical workflow:

1. Set the **cloud dimensions** to your real surface size.
2. Pick an **LED type** and adjust **rows / cols** until the *Build Estimate*
   shows a density your chosen product can hit (feasibility reads "OK").
3. Set the **brightness** you'll actually drive at.
4. Increase **LED distance** until the HUD reads "even" — that's the minimum
   standoff depth you need to build behind the cloud to hide the hotspots.

Read off the *Build Estimate* for the order: total LEDs and metres of strip
(or number of pixel nodes) to buy.

## Stack

- Frontend: Vite + TypeScript + Three.js (single full-screen GLSL shader) + lil-gui.
- Bridge: Node.js (Express + ws) → UDP relay to WLED. Browsers can't send UDP,
  so this small process does it.

## Quick start

```bash
npm install

# 1) Simulator (visual only)
npm run dev          # opens http://localhost:5173

# 2) Hardware bridge (only needed to drive real strips)
npm run server       # ws://localhost:8081  ->  UDP to WLED
```

Use the on-screen panel to dial in the look: increase **LED distance** (or the
material **haze**) to blend distinct LED dots into a soft, even glow, and raise
**bumpiness** in *Cloud Surface* for a more volumetric, lumpy cloud. Individual
LED spots always render round — the bumps are a relief layer on top and never
reshape the light.

## Driving real LED strips

This targets **WLED** (ESP32 / ESP8266 + WS2812B/SK6812 strips), the most common
DIY ecosystem.

1. Flash your controller with WLED and wire up your matrix of strips.
2. In WLED, set the LED count and, for a zig-zag matrix, confirm your physical
   wiring direction. (You can also configure the 2D matrix in WLED's settings.)
3. Find the controller's IP address (WLED app or your router).
4. Run the bridge: `npm run server`.
5. In the simulator's **Stream to Hardware** panel:
   - set **WLED IP** to your controller's address,
   - set **wiring** to `serpentine` if alternate rows are reversed (typical for
     a boustrophedon strip layout), otherwise `row-major`,
   - tick **enable stream**.

The bridge sends DNRGB packets on UDP port `21324`, chunked at 489 LEDs/packet,
with a 2-second realtime timeout (WLED reverts to its normal effect if frames
stop). Brightness and gamma are applied before sending.

### Mapping the grid to your strips

- The simulator treats the grid as `rows × cols` with the **top-left** LED as
  index `0`, filling left-to-right, top-to-bottom (row-major).
- If your matrix snakes back on every other row, choose **serpentine** wiring so
  the visual lines up with the physical layout.
- For multiple independent controllers, run one bridge per controller (set
  `PORT=8082 npm run server`, point a second simulator tab's `bridge ws` at it).

## Other hardware / protocols

- **Art-Net / sACN (E1.31)**: WLED also speaks these; the same byte stream maps
  cleanly to DMX universes. Swap the UDP packing in `server/index.mjs`.
- **Direct serial (no Wi-Fi)**: a future option is the Web Serial API to push
  to an Arduino/Teensy running a simple serial-to-LED sketch (e.g. Adalight),
  removing the Node bridge entirely.

## Project layout

```
index.html            # canvas + HUD
src/
  config.ts           # all tunable parameters + defaults
  patterns.ts         # pattern engine (source of truth for LED colors)
  cloudShader.ts      # GLSL: LED glow accumulation + fbm cloud bumps
  ledField.ts         # color buffer, GPU data texture, hardware byte packing
  streamer.ts         # WebSocket client -> bridge
  gui.ts              # lil-gui controls
  main.ts             # render loop wiring it all together
server/
  index.mjs           # WebSocket -> UDP (WLED DNRGB) bridge
```
