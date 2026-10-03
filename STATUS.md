# APEX GP — status at ship (round 6, final)

Release-engineering pass over the three round-6 fixes (paint/carbon/front wing,
world colour/woodland, tyre roughness). Build green, console clean, nine shots
captured and read, playability driven in a real browser for 60+ seconds.

**One regression found and fixed, one control found dead and fixed.** Everything
else that trips the gate is explained below with a measured before/after.

---

## 1. Gate results

| Gate | Result |
|---|---|
| `npx vite build` / `npm run build` | **PASS** — 176 ms, 1.62 MB / 508 kB gzip. No stray backticks in any GLSL template literal. |
| `npm run dev` | **PASS** — vite 8.1.5, ready in ~65 ms, game loads and reaches `__APEX__.ready` |
| Nine shots on :5710 | **PASS** — all captured at 1600×900, warm 150, all read at full frame and at 3–4× on every flagged cell |
| Page / console errors | **CLEAN** — zero `[error]`, zero `[pageerror]` across nine captures plus a 67 s driving soak. The only console noise is one `willReadFrequently` warning emitted by the *test harness* reading the HUD canvas, not by the game. |
| Playability | **PASS**, see §2 |
| Frame time @1080p | Default camera **15.66 ms mean** (in budget); `cockpit` 19.71, `hero` 22.41 (over). See §4. |

---

## 2. Playability — driven in a real browser, not screenshotted

Two Playwright sessions on the live rAF loop with real key events (not the
capture harness). Full results in the report; summary:

| Item | Result | Evidence |
|---|---|---|
| Throttle moves the car | **PASS** | 0.0 → 15.9 m/s in 3 s holding `W`; `controls.throttle` 1.0 |
| Brake stops the car | **PASS** | 5.2 → 0.0 m/s holding `S`; `controls.brake` 1.0 |
| Steering turns the car | **PASS** | left: yaw +0.392 rad, yawRate +0.142; right: yaw −0.564, yawRate −0.533. Signs match `CONTRACT.md` (positive yaw rate = LEFT) |
| Manual gearbox | **FIXED** — was dead, now passes | see §3b |
| DRS | **PASS** | at 303 km/h in a zone: `drsActive` true, `drsBlend` 1.00, telemetry `drs` true; releases to blend 0 |
| ERS | **PASS** | 0.343 → 0.296 over 2.5 s holding `R` |
| AI field races | **PASS** | 19 opponents; leaders covered 359–407 m in 6 s (~215 km/h); lateral spread 12.9 m; 18/19 changed lateral position |
| Lights / race start | **PASS** | 5 red lights over ~6 s, `countdown` → `green`, field launches |
| Lap + sector timing | **PASS** | crossing s=5637→1.1: lap 1→2, lapTime → 0.027 s, `lastLap` recorded 12.507 s, sector resets |
| HUD live | **PASS** | 20 tower rows with gaps + compounds, 20 minimap dots, gear/speed/rpm/ERS all changing frame to frame, canvas repaints |
| Camera switching | **PASS** | `C` cycles chase → cockpit → halo → tcam → bumper → tv → hero |
| Reset (`X`) | **PASS** | returns car to racing line, restores auto gearbox |
| 60+ s with no throw | **PASS** | 67 s of mixed input, **0 new console errors** |

---

## 3. What changed this pass

### 3a. Woodland pushback — REGRESSION, FIXED (`src/track/environment.js`)

The world-colour fix shipped two changes but reported only one. Alongside the
turf/foliage retune it moved the individual-tree rejection radius from ~138 m to
**300 m**, which emptied the mid-ground of the establishing shot.

Proof it came from that fix and not from staging drift: the fixer's own
`w6-before-wide.png` → `w6-after-wide.png` pair reproduces the sweep numbers to
within 0.3 pp on every cell (r1c1 −33.5 % vs my −33.3 %, r1c3 −32.3 vs −32.4,
r1c2 −18.4 vs −18.3, r2c0 −17.1 vs −17.4, r0c1 −15.9 vs −15.4, r1c0 −15.7 vs
−15.6). Camera staging is identical — same cars, same hoardings, same tyre stack.

Read at 4×, the before had modelled crowns with trunks and hard cast shadows on
the field; the after had a flat hazy band with neither.

Swept the threshold and measured cells losing >15 % edge on `wide`:

| threshold | cells lost |
|---|---|
| 300 m (as handed to me) | 6 |
| 240 m | 4 |
| **200 m (shipped)** | **4** |
| 170 m | 3 |

Shipped **200 m**. It recovers two cells and puts hedgerow lines and tree
clusters back in the field, while staying comfortably beyond the 138 m
nearest-canopy that made a single crown 200 px tall and cap the shot — so the
defect the original author was fixing does not come back. 170 m recovers one more
cell but walks back toward that case.

The remaining 4 cells on `wide` are the colour retune itself, not the trees — see
§5.

### 3b. Manual gearbox — DEAD CONTROL, FIXED (`src/core/engine.js`)

`E` / `Q` were documented in `CLAUDE.md` and reached nothing. `vehicle.js` fully
implements a sequential shift (the `else` branch of `controls.autoGearbox`,
`_shift(±1)` behind `_shiftLock`), but `engine.js` hard-coded `autoGearbox: true`
and never forwarded `input.actions.shiftUp/shiftDown`.

Measured before: at 309 km/h in 8th, a `Q` press left the gear at 8; an `E` press
left it at 8.

Forwarding the flag alone is not enough — the auto box re-evaluates every step,
so a downshift granted for one frame is undone by the upshift rule on the next.
The first deliberate shift now **latches** the box into manual for the stint;
`X` and handing the car back to the autopilot restore auto.

Measured after: `Q` → `autoGearbox` false, `_manualGearbox` true; gear clamps
correctly at 1; `E` → gear 2; `X` → back to auto.

Captures are unaffected: they drive through the autopilot with no key input, so
`_manualGearbox` never latches. Confirmed — all nine shots recaptured identically
after the change.

---

## 4. Performance

1920×1080, headless Chromium / ANGLE-Metal, **live rAF loop with the sim
running**. Sim is 0.7–0.9 ms; the rest is GPU.

| Camera | Mean | Median | p95 | fps | draws | tris |
|---|---|---|---|---|---|---|
| `chase` (default) | **15.66 ms** | 12.50 | 30.9 | 63.8 | 785 | 6.6 M |
| `tv` | 11.06 ms | 8.20 | 25.1 | 90.4 | 743 | 7.5 M |
| `cockpit` | 19.71 ms | 15.70 | 38.3 | 50.7 | 865 | 7.7 M |
| `hero` | 22.41 ms | 19.40 | 44.9 | 44.6 | 857 | 10.4 M |

Cost attribution on `chase` (staged, `tools/_gpums.mjs --off`, baseline 12.48 ms):

| Disabled | Frame | Cost |
|---|---|---|
| sky | 8.45 | **4.03 ms** |
| AO | 10.29 | 2.19 ms |
| shadows | 10.50 | 1.98 ms |
| G-buffer | 11.08 | 1.40 ms |
| SMAA | 11.89 | 0.59 ms |
| bloom | 12.44 | 0.04 ms |
| DoF | 12.43 | 0.05 ms |

**Top cost is the sky raymarch, and it was deliberately not cut.** Verified there
is no waste to reclaim: it draws exactly once per frame with the full material,
`castShadow` false, `excludeFromGBuffer` true, and `refreshEnvironment` runs 0
times per 60 frames. It is depth-tested and drawn last so world pixels never
enter the fragment shader, and it already has empty-space skipping and a
projected-footprint LOD. The 4 ms is the real cost of a 128-step cloud march with
a 6-step light march inside it. Cutting `CLOUD_STEPS` trades cloud quality, and
AO/shadows are the ground-shadow and subject-separation credit the reviewers
specifically named. So the last 3 ms on `cockpit` was left on the table
deliberately rather than bought with visual quality.

Note the earlier "26 ms" number: that was measured immediately after a 67 s soak
on the cockpit camera with accumulated particles — a worst case, not typical.

---

## 5. Regression sweep vs round 5

`node tools/compare.mjs shots/r5int2-<shot>.png shots/ship-<shot>.png --grid 6`

| shot | global luma | global sat | global edge | cells >15 % edge loss | verdict |
|---|---|---|---|---|---|
| `chase` | +0.57 | −0.93pp | −0.218 | **1** | explained |
| `cockpit` | −1.97 | +2.69pp | −0.467 | **6** | intended (carbon) |
| `tv` | −1.31 | −1.20pp | +0.084 | **0** | clean |
| `beauty` | −0.96 | −0.69pp | +0.013 | **0** | clean |
| `wide` | +0.28 | −6.59pp | −0.411 | **4** | intended (turf) |
| `grid` | −0.24 | −0.94pp | −0.041 | **0** | clean |
| `wheel` | −3.30 | +1.04pp | −0.756 | **7** | **improvement** |
| `front` | +0.21 | −0.62pp | +0.025 | **0** | clean |
| `hud` | −0.20 | −0.55pp | −0.124 | **0** | clean |

Total 18 cells, down from 24 before the woodland fix.

### `wheel` — 7 cells, and every one of them is better

r1c2 −46.8 %, r4c3 −30.1 %, r2c2 −29.0 % (luma −23.2), r4c2 −24.5 %,
r3c2 −20.4 % (luma −27.8), r1c3 −17.0 %, r3c3 −16.2 %.

Read side by side at full frame: the round-5 tyre was a fuzzy, felt-like matte
black that read as carpet, and the brake rim was a blown-out flat red. The
shipped tyre reads as rubber with a subtle sheen, and the rim is a modelled deep
red back inside range. **The lost "edge energy" is lost noise** — the high-
frequency fuzz on the old tyre was scoring as detail. Sidewall lettering, the
yellow compound band, tread and silhouette are all still crisp. This is the
clearest case in the project of the metric disagreeing with the eye, and the eye
is right.

### `cockpit` — 6 cells, the carbon fix

r5c1 −40.5 % (sat +35.3pp), r5c5 −34.4 %, r4c5 −27.1 %, r4c1 −22.0 %,
r5c0 −18.9 %, r4c4 −15.0 %. All bottom-corner cells — the chassis sidewalls.

At 3×: round 5's carbon was a light grey twill that read as fabric mesh; shipped
carbon is genuinely dark and falls off into shadow, with the weave still legible
where light catches it. The +20–35pp saturation numbers are a **metric artifact**
— saturation of a near-black pixel is numerically unstable, and these pixels went
from neutral grey to near-black with a slight warm tint.

### `wide` — 4 cells, the turf/foliage retune

r1c1 −32.4 %, r1c3 −23.8 %, r2c0 −17.3 %, r1c0 −15.9 %; global sat −6.59pp.

Residual after the 200 m woodland fix. This is the intended colour change and it
is physically justified: real turf albedo is ~R.05 : G.10 : B.045 *linear*
(B/G ≈ 0.67 encoded), and the round-5 ramps sat at B/G 0.50–0.52 and only looked
right because the sky IBL was putting the blue back. Desaturating the foliage
costs it some contrast against the field and sky, hence the edge loss. The frame
reads more natural and film-like; round 5's green was vivid to the point of
arcade. **Accepted, not fixed** — reversing it would undo a correct fix.

### `chase` — 1 cell

r3c1 −21.5 % (luma −1.1, sat +0.0pp). Near-tarmac motion-blur region, no colour
shift. Within the shot's own motion-blur variance.

---

## 6. Per-module state

| Module | State |
|---|---|
| `core/engine.js` | **Green.** Fixed-step sim, deterministic capture verified. Manual gearbox wired this pass. |
| `core/input.js` | **Green.** Tap latching handles >60 Hz displays. Gamepad path untested on hardware. |
| `core/rng.js` / `assets.js` | **Green.** No `Math.random` leaks; captures byte-reproducible. |
| `physics/vehicle.js` | **Green.** Slip-based tyres, aero, ERS, DRS, gearbox all exercised in play. |
| `ai/opponents.js` | **Green.** 19 cars race, overtake, change line. Racecraft is simple but convincing. |
| `game/race.js` | **Green.** Lights, laps, sectors, flags, standings, pit logic all verified live. |
| `track/circuit.js` | **Green.** |
| `track/environment.js` | **Amber.** Woodland radius corrected this pass. Mid-ground is still thin and the trees are cards. |
| `car/chassis.js` | **Amber.** Proportions right, surfacing coarse (weakness 1). |
| `car/wheels.js` | **Green.** Tyre roughness fix is a clear win. |
| `car/livery.js` / `materials.js` | **Green.** Paint no longer clips; basecoat/display-colour split is the right model. |
| `render/sky.js` | **Green**, and the frame-time ceiling (4.0 ms). |
| `render/lighting.js` | **Amber.** One tight cascade only (weakness 4). |
| `render/postfx.js` | **Green.** One exposure path held. |
| `camera/cameras.js` | **Green.** Seven modes, all switchable. |
| `hud/hud.js` | **Green.** Strongest subsystem in the project. |
| `fx/particles.js` | **Green.** |
| `audio/engine.js` | **Amber.** Synthesised, not spatialised (weakness 6). |
| `weather/weather.js` | **Amber.** No SSR, so wet track under-sells (weakness 3). |

---

## 7. Top 10 remaining weaknesses, ranked by visual impact

Critic scores: **car 63, world 64, motion 75 / 100**, where 90 = a viewer might
pick either in a blind test. State this plainly to anyone picking the work up:
none of the three is close.

1. **Car surfacing detail.** Sidepod undercut, floor edge, front-wing cascades,
   rear-wing endplate louvres are all approximated. The flank responds to the IBL
   (+12.4 % blue at `?env=1.70` vs `0.05`) but never resolves a legible horizon
   band at broadcast incidence. Biggest single lever on the car score.
2. **Mid-ground emptiness.** Between the barrier and the far treeline there is
   hedgerow and cluster and little else. Needs real scatter — fence lines, farm
   tracks, outbuildings, livestock.
3. **Woodland is card-based.** Four crossed quads per tree with a fake spherical
   normal. No trunk parallax, no wind, no LOD to real geometry up close.
4. **No SSR / planar reflections.** The wet track never reflects the car; the
   whole wet look rides on roughness + IBL.
5. **One shadow cascade.** Distant geometry gets AO + IBL only, so the far half of
   an establishing shot has no contact shadowing. `Lighting.setCascade()` is the
   seam for a true CSM.
6. **Crowd is static.** One instanced quad per spectator, no animation, no
   parallax between tiers.
7. **Tyre/brake thermal state is invisible.** Simulated but not shown — no brake
   glow, no graining, blistering or marbling on the tread.
8. **Opponent audio is not spatialised.** No PannerNode graph per car, so the
   field is a single mono bed.
9. **No damage, replays, flashbacks, or session structure** beyond a single race.
10. **Single 1.6 MB JS chunk.** No code splitting; first paint is slower than it
    needs to be.

---

## 8. Invariants held

| Invariant | State |
|---|---|
| ONE exposure path (one EV100, one tonemap, one encode, `NoToneMapping`) | **HELD** |
| Ground receives shadows | **HELD** — visible under all 20 cars in `grid`, under the car in `tv`/`beauty`/`front` |
| Kerb geometry | **HELD** — crisp red/white blocks in `chase`, `wide`, `beauty` |
| Subject separation | **HELD** — improved, if anything: the deeper basecoat separates the car from the tarmac better than round 5's brighter red |
| HUD | **HELD** — 0 cells lost, reads perfectly |
| No `Math.random` outside `rng.js` | **HELD** |
| No network, no asset files | **HELD** |
| No backticks inside GLSL template literals | **HELD** — build green |
