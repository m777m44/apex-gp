# APEX GP — Engine Contract

This is the binding interface document for the APEX GP renderer. Fifteen
specialists work on this tree in parallel. **Anything documented here is a
promise other modules rely on.** Change a signature and you break someone else;
add to it freely.

---

## 0. Conventions

### Units and axes
| Thing | Convention |
|---|---|
| Length | **metres** |
| Angle | **radians** (degrees only in a few named `...Deg` parameters) |
| Time | **seconds** |
| Mass | kg, force N, torque Nm |
| Speed in UI | m/s internally, km/h only at the HUD boundary |
| Up | **+Y** |
| Handedness | right-handed (three.js default) |

### Car-local frame (identical for every car)
```
-Z = forward        +X = the car's right        +Y = up
origin = ground plane directly under the centre of gravity
front axle  z = -1.62      rear axle z = +1.98      wheelbase 3.60
nose tip    z = -3.00      tail      z = +2.45      overall width 2.00
```
Yaw ψ is a rotation about +Y. Forward = `(-sin ψ, 0, -cos ψ)`, right =
`(cos ψ, 0, -sin ψ)`. **Positive yaw rate = turning LEFT. Positive steer =
turning RIGHT.**

### Track frame
For any circuit sample:
```
tangent = direction of travel
right   = tangent x up      (the driver's right hand)
s       = arc length in metres from the start/finish line, wraps at circuit.length
lateral = signed metres along `right` from the centreline
curvature k = dT/ds . right     (POSITIVE = the track turns right)
```

### Wheel order
`[frontLeft, frontRight, rearLeft, rearRight]` — everywhere, without exception.

### Render order / layers
| renderOrder | contents |
|---|---|
| `0` | all opaque world geometry |
| `1000` | `Sky` mesh (depthTest **on**, depthWrite off, drawn LAST of the opaque list — it emits depth 1 in the vertex shader, so an LEQUAL test is identical to drawing it first with the test off, except the world's pixels never pay for the 128-step cloud march). Carries `userData.excludeFromGBuffer`. |
| `20` | particle systems (`fx/particles.js`) |
| `30` | rain (`weather/weather.js`) |
| DOM `z-index: 10` | HUD canvas overlay |

Transparent surfaces use `depthWrite: false`. Coplanar decals (track lines,
grid boxes, start line) use `polygonOffset` with **negative** factor/units;
surfaces that must sit *behind* (run-off apron, pit lane) use positive.

### Determinism
`Math.random` is banned outside `src/core/rng.js`. Everything seeds from
`MASTER_SEED`. Use `makeRng(seed)` or `rngFor('some/name')`.

---

## 1. Module map

```
src/
  main.js                 boot + loading overlay + debug HUD
  core/
    engine.js             renderer, scene, fixed-step loop, window.__APEX__
    input.js              keyboard + gamepad -> normalised control state
    assets.js             procedural asset registry + loft/superellipse/merge helpers
    rng.js                seeded PRNG, value/ridged/worley noise, clamp/lerp/smoothstep
  textures/
    procedural.js         THE shared texture library (see §4)
  render/
    sky.js                Preetham sky + clouds, infinite skybox
    lighting.js           sun, hemisphere fill, PMREM IBL from the sky, shadow cascade
    postfx.js             GTAO -> DOF -> CA/motion blur -> bloom -> ACES -> LUT/flare/grain -> SMAA
  track/
    circuit.js            centreline, road/kerb/line meshes, THE sampling API (see §3)
    environment.js        terrain, run-off, barriers, fence, stands+crowd, pits, gantries, trees
  car/
    chassis.js            body geometry + CarModel assembly
    materials.js          per-team material bundle
    livery.js             TEAMS, grid, livery texture painting, decal helper
    wheels.js             tyres, rims, brakes, double-wishbone linkage
  physics/
    vehicle.js            3-DOF rigid body, Pacejka tyres, aero, gearbox, ERS
  ai/
    opponents.js          speed profile, pure-pursuit AI, OpponentField
  camera/
    cameras.js            CameraRig: chase/cockpit/halo/tv/hero/wide
  hud/
    hud.js                Canvas2D broadcast HUD + lap-time formatters
  fx/
    particles.js          smoke / dust / sparks / spray / debris pools
  audio/
    engine.js             WebAudio V6 turbo-hybrid synthesis
  weather/
    weather.js            weather states, wet grip, drying line, rain
  game/
    race.js               grid, lap/sector timing, standings, flags, DRS enablement
```

Dependency direction (no cycles): `rng -> textures -> assets -> {render, track,
car, fx} -> {physics, ai, camera, hud, weather, game} -> core/engine -> main`.
`car/chassis.js` imports UV constants from `car/livery.js`, never the reverse.

---

## 2. The capture contract

`src/core/engine.js` installs:

```js
window.__APEX__ = {
  ready: false,                    // true only after sky, IBL, world and cars exist
  version: 'apex-gp-1',
  engine,                          // the live Engine instance (debugging)
  pause(),                         // stop rAF; frames become manual
  resume(),
  capture(shotName, frameIndex),   // async; poses camera + sim deterministically
  renderFrame(i),                  // advance the sim by exactly 1/60 and render one frame
  settle(),                        // async; awaits PMREM + shader compilation
  stats(),                         // { fps, drawCalls, triangles, simMs, renderMs }
};
```

`capture()` supports these shot names. Each one restages the **entire field**,
sets time of day, weather, HUD visibility and the post-processing look, then
snaps the camera:

| shot | pose |
|---|---|
| `chase` | spring chase camera, mid-corner, at racing pace |
| `cockpit` | driver eye point behind the halo hoop |
| `tv` | nearest trackside broadcast tower, long lens |
| `beauty` | stationary hero orbit, golden hour, DOF |
| `wide` | elevated establishing shot of a circuit section |
| `grid` | full 20-car starting grid from behind, morning light |
| `wheel` | tight front wheel / suspension / brake detail, DOF |
| `front` | head-on, front-wing detail, DOF |
| `hud` | chase view down a DRS straight with the full HUD |

Moving shots are staged **upstream** of the target point by `pace * 1.45 s` so
the car arrives there after the harness's ~90 warm-up frames. Static shots set
`engine.frozen = true` so `renderFrame` renders without stepping physics.

**Debug query flags** (`?flag=value`, engine reads them once at boot):
`fx=0` bypass the whole post stack, `ao|dof|bloom|smaa|look|preGrade=0|1`,
`env=<float>` IBL intensity, `exposure=<float>`, `fog=0`.

---

## 3. Circuit sampling API — `track/circuit.js`

The single source of truth for where the road is. Physics, AI, cameras, HUD,
weather and environment placement all go through it.

```js
const circuit = new Circuit({ width = 13.4 });
circuit.build();                  // -> THREE.Group (the engine adds it to the scene)

circuit.length                    // centreline length, metres
circuit.step                      // metres between stored samples (~2.0)
circuit.halfWidth                 // half the racing surface width
circuit.samples                   // Sample[] — read-only, indexed by s / step
circuit.sectorStarts              // [0, L/3, 2L/3]
circuit.drsZones                  // [{ detectS, startS, endS, length }]

circuit.wrapS(s)                  // -> s in [0, length)
circuit.sampleIndex(s)            // -> index into samples[]
circuit.sampleAt(s, out?)         // -> interpolated Sample (allocates unless `out` given)
circuit.frameAt(s)                // alias of sampleAt
circuit.pointAt(s, lateral, lift, out?)   // -> THREE.Vector3 world position on the surface
circuit.curvatureAt(s)            // -> 1/m, +ve = right
circuit.racingLineOffset(s)       // -> lateral metres of the ideal line
circuit.racingLinePoint(s, lift?) // -> THREE.Vector3
circuit.nearest(vec3, hintS?)     // -> { s, lateral, height, surfaceY, sample }
circuit.onTrack(lateral)          // -> boolean
circuit.sectorOf(s)               // -> 0 | 1 | 2
circuit.drsZoneAt(s)              // -> zone | null
circuit.gridSlot(i)               // -> { s, lateral, position, heading, tangent }
circuit.surfaceHeightAt(x, z)     // -> y
```

`Sample = { s, position, tangent, right, up, curvature, banking, racing, width }`
(all `THREE.Vector3` fields are live references into `samples[]` — **do not
mutate them**; `sampleAt` returns a fresh/interpolated object you may mutate).

Always pass `hintS` to `nearest()` when you have a previous value — it turns an
O(cells) search into an O(1) local scan.

---

## 4. Procedural texture API — `textures/procedural.js`

### MaterialMaps
Surface generators return:
```js
{
  map,          // albedo, SRGBColorSpace
  normalMap,    // tangent-space normal, NoColorSpace, OpenGL +Y
  ormMap,       // R = AO, G = roughness, B = metalness (glTF ORM packing)
  aoMap, roughnessMap, metalnessMap,   // all === ormMap (one sampler, three slots)
  normalScale,  // THREE.Vector2
  size,         // pixels per side
  worldSize,    // metres covered at repeat = 1
}
```
Usage:
```js
import { asphalt, mapsToMaterial, cloneMaps, setRepeat, repeatForMetres } from '../textures/procedural.js';
const maps = asphalt({ wear: 0.5 });
const mat = new THREE.MeshStandardMaterial({ ...mapsToMaterial(maps), vertexColors: true });
```

**TILING RULE (important).** Generators are memoised, so two callers get the
*same* `THREE.Texture` objects and therefore share `texture.repeat`. If you need
your own tiling, call `cloneMaps(maps)` first (cheap — the clone reuses the same
GPU upload) or pass a unique `key` option to the generator.

### Surface generators
| function | worldSize | notes |
|---|---|---|
| `asphalt({size, wear, coarse, key})` | 4 m | aggregate, patches, thin tar seams |
| `carbonFibre({size, tows, tint, key})` | 0.25 m | 2×2 twill, filament streaks |
| `rubber({size, scuff, key})` | 0.5 m | matte granular carcass |
| `brushedMetal({size, roughBase, anisotropy, key})` | 0.3 m | metalness 1 |
| `concrete({size, stain, key})` | 2 m | pits, streak grime |
| `grass({size, dry, key})` | 3 m | blades + clumps |
| `gravel({size, key})` | 1.5 m | run-off trap |
| `paintedLine({size, colour, wear, key})` | 2 m | worn white paint |
| `kerbStripe({size, a, c, blocks, ribs, key})` | 4 m | U runs ALONG the kerb |
| `fabric({size, colour, key})` | 1 m | team kit / banners |

`SURFACES` is a name → generator map for the registry.

### Sprites, atlases and single textures
```js
crowdSprite({cell})            // 8x4 spectator atlas (CROWD_COLS/CROWD_ROWS exported)
crowdSpriteUV(i)               // -> { offset, scale }
decalAtlas({cell})             // 4x4 sponsor/marking atlas; DECAL_NAMES exported
decalAtlasUV(name)             // -> { offset, scale }
tyreProfileMap({compound, size, repeats})  // u = circumference, v = across the profile
                               // v: 0 inner bead, 0.5 tread crown, 1 outer bead
COMPOUND_COLOURS               // { soft, medium, hard, inter, wet }
smokeSprite({size, wisp})      // soft alpha blob
sparkSprite({size})            // hot streak
flareSprite({size, ring})      // lens-flare element
foliageSprite({size, hue})     // alpha-tested tree card
gradientStrip(stops, {width})  // 1-D ramp for HUD bars
noiseTile({size})              // NoColorSpace, NearestFilter, no mips
setTextureAnisotropy(n)        // called once by the engine
disposeAll()                   // teardown only
```

---

## 5. Module APIs

### `core/assets.js`
```js
assets.attachRenderer(renderer)
assets.get(key, factory)        // memoised; also .geometry() .material() .texture()
assets.slowest(n)               // bake-time budget report
assets.stats() / assets.dispose()

loft(sections, { closed, caps })       // sections: Vector3[][] with equal point counts
superellipse(count, hw, hh, n, opts)   // closed cross-section ring
mergeGeometries(list)                  // position/normal/uv/index merge
setShadows(root, cast, receive)
```
`loft` winding: **(ring tangent) × (row direction) points OUT of the surface.**
Ribbon builders in `circuit.js` / `environment.js` follow the same rule —
`right × tangent = +up`, so a ground ribbon indexes `(a, b, d), (b, e, d)`.

### `core/input.js`
```js
const input = new Input(window, { steerRate, pedalRate, deadzone });
input.update(dt) -> state   // { steer -1..1, throttle 0..1, brake, clutch, drs, ers, lookBack, gamepad }
input.actions               // edge-triggered: shiftUp, shiftDown, camera, reset, pause
input.on(name, cb) / input.endFrame() / input.isDown(action)
input.setVirtual(partial|null)   // force the state (capture, replay, AI-driven player)
```

### `render/sky.js`
```js
const sky = new Sky({ timeOfDay, turbidity, cloudCoverage, cloudDensity, intensity,
                      cloudGain, cloudAmbient, cloudContrast, cloudErosion });
sky.mesh                     // add to the scene; renderOrder 1000, depthTest on,
                             // depthWrite off, userData.excludeFromGBuffer
sky.envMesh                  // low-step twin, SHARES the uniform objects, for PMREM
sky.sunDirection             // unit Vector3, origin -> sun (READ ONLY)
sky.setTimeOfDay(hours)      // 0..24, retunes turbidity/mie for golden hour
sky.setSun(elevationDeg, azimuthDeg)
sky.setClouds({ coverage, density, scale, base, thickness, height,
                gain, ambient, contrast, erosion })
sky.sunColour(target?) / sky.sunIntensity() / sky.skyColour(target?)
sky.averageLuminance()       // scene-referred, post-uIntensity (the exposure meter)
sky.update(dt)               // drifts the cloud layer
```
Radiance is scaled by `uIntensity` (0.21) and SOFT-clamped toward `uMaxRadiance`
(40) by `x / (1 + x/M)`. The sun disc IS physically the brightest thing in frame
(`uSunDiscIntensity` 220 → ~20 after the ceiling); the direct sun is still a real
`DirectionalLight`.

**Cloud radiance is bounded by construction and must stay that way.** The march
is energy conserving (`S * (1 - T)`, saturating at `S`) and `S` is then soft-knee
compressed on LUMINANCE to `uCloudContrast` × the brightest sky probe
(`uSkyZenith` / `uSkyHorizon`) — self-calibrating, so golden hour allows brighter
cloud than mid-afternoon without a second tuning pass. Measured at 15:20 in
`chase`: zenith 0.31, mid-sky 0.41, brightest cloud pixel 1.35 — a **3.3:1**
cloud-to-sky ratio (a photograph shows ~3:1). Anything that divides the source
term by the extinction, or scales it by step length, reintroduces the unbounded
albedo that whited out every sun-facing frame.

Cloud knobs, all on `setClouds`: `gain` direct-scattering albedo scale (0.46),
`ambient` fraction of sky radiance a parcel re-scatters, ≤ 1 (1.00), `contrast`
the ceiling multiple (3.4), `erosion` how hard the detail octaves carve the
silhouette, 0 = smooth blobs (1.0). Shape is a weather map (two ~20–60 km
octaves) → coverage-thresholded base fbm → cumulus height profile → billow +
fine erosion, all combined by **linear** remaps (`remap01`), never `smoothstep`:
a smoothstep flattens the noise gradient into a plateau and gives cut-out edges.
The view march uses geometric step growth (36 steps, ×1.12, 105 km) because a
uniform march put `ds` above the base-noise wavelength on grazing rays; detail
octaves fade out past ~60 km as a Nyquist LOD.

### `render/lighting.js`
```js
const lighting = new Lighting(renderer, scene, sky, { shadowMapSize, shadowRadius, environmentIntensity });
lighting.sun                  // DirectionalLight, castShadow
lighting.fill                 // HemisphereLight
lighting.refreshEnvironment() // re-run PMREM from the sky (call after a sky change)
lighting.syncToSky()          // pull sun colour/intensity from the sky
lighting.setCascade(radius, distance)
lighting.setShadowFocus(vec3)
lighting.update(dt, focus)    // texel-snapped cascade follow + periodic IBL refresh
lighting.setEnvironmentIntensity(v)
```

### `render/postfx.js`
```js
const fx = new PostFX(renderer, scene, camera, { msaa });
fx.settings = { bloom{enabled,strength,radius,threshold}, ao{...}, dof{...},
                motionBlur{...}, aberration, vignette, grain, flare, lutMix,
                saturation, exposureTrim, smaa };
fx.applySettings() / fx.enable(name, on) / fx.render(dt) / fx.setSize(w, h) / fx.setCamera(cam)
fx.setMotionBlur(t01) / fx.setBlurCenter(u, v) / fx.setSunScreen(u, v, visibility)
fx.setLUT(data3DTexture)
makeLookLUT(size, { contrast, pivot, shadowTint, highlightTint, saturation, lift })
```
`bloom.threshold` is in **linear scene-referred** units. Sky radiance sits around
1–1.5 and the sun disc at 30; anything below ~2 makes the sky bloom and washes
the frame out. Pass ordering (linear before `OutputPass`, display after) is load
bearing.

### `track/environment.js`
```js
const env = new Environment(circuit, { detail: 'low'|'medium'|'high' });
env.build()                  // -> THREE.Group (the engine adds it to the scene)
env.update(dt)               // crowd bob, flags, grass wind — call once per RENDER frame
env.group
env.terrainHeightAt(x, z)    // -> y, valid everywhere including under the carve
env.corridorAt(s, side)      // -> { runoff, margin, barrier, tail, type }
env.setStartLights(n)        // 0..5 columns lit; 0 = all out (race start)
env.grandstands / env.barriers / env.crowd / env.startLights
```
Everything trackside is placed off ONE low-pass-filtered per-sample corridor
(`corridorAt`), so run-off, verge, barrier, hoardings, catch fence, terrain carve,
grandstands and marshal posts can never gap or z-fight. Named scene children the
rest of the engine may look up: `Terrain`, `RunOff`, `Verge`, `ServiceRoad`,
`Trackside` (`Barrier` / `Hoarding` / `CatchFence`), `TyreWalls`, `Grandstands`,
`Crowd`, `PitLane`, `Gantries`, `MarshalPosts`, `Towers`, `TracksideFurniture`,
`SpectatorEstate` (`ParkedCars` / `Coaches`), `GrassCards`, `Trees`
(`Canopy-0..3`), `FarLandscape` (`Hedgerows`, `Woodland-{near,mid,far}-0..3`),
`Skyline` (`City{band}-{kind}`).

**Ground colour is owned by one function.** `turfGrade(material, opts)` throws the
baked `grass()` albedo's *luminance* through a four-stop turf ramp
(`shadow → mid → dry`, plus `dirt` for tilled parcels) and adds mown stripes, a
158 m agricultural parcel mosaic with per-parcel corduroy, and two rotated
tuft-scale octaves. The verge, the open field and the instanced grass cards all
read from the same pair of turf colours, which is what keeps them inside one
tonal range — if you retune one, retune all three. Stripe profiles are a
*flattened sine*, never a square wave: a hard band pair aliases into fine
corduroy at grazing angles.

`detail` scales the grass-card budget (0 / 46 k / 132 k), tree count and whether
the spectator estate is built at all.

### `car/livery.js`
```js
TEAMS                 // 10 teams x 2 drivers
teamById(id) / fullGrid() -> [{ team, driver, number, index, seat }]
buildLiveryTexture(team, driver, seat?) -> CanvasTexture   // memoised, flipY = false
bodySurfaceMaps() -> { normalMap, ormMap, clearcoatMap }   // shared body relief
numberPanelTexture(team, driver) -> CanvasTexture
buildTeamDecals(entry, materials) -> Group   // rear-wing panels + halo tip sleeve
makeDecalPlane(name, w, h, material) -> Mesh
circumferenceAt(u) -> metres
BODY_Z0 / BODY_Z1 / BODY_LENGTH / bodyU(z) / BODY_V / LIVERY_W / LIVERY_H

// driver helmet (per DRIVER, not per team)
helmetTexture(team, driver) -> CanvasTexture        // sphere unwrap, see below
createHelmetMaterial(team, driver) -> MeshPhysicalMaterial
HELMET_UV_SPARE       // v below this is a flat strip for UV-pinned sub-parts

// halo — the spline lives here because the coloured tip must share it
haloCurve() -> CatmullRomCurve3
haloProfile(n, grow?) -> Vector2[]                 // teardrop, (across, vertical)
sweepUpLocked(curve, profile, segments) -> { geometry, sections }
```
**BODY-UV SPACE** (shared with `chassis.js` and `materials.js`):
`u` = longitudinal, 0 at the nose tip → 1 at the tail (`bodyU(z)`);
`v` = circumferential, `0.00` right flank → `0.25` top → `0.50` left flank →
`0.75` floor → `1.00` right again. The livery canvas is 2048×1024 and
`flipY = false`, so canvas Y maps straight to v.

**THE RIGHT FLANK IS ROTATED 180°, NOT MIRRORED.** Two flips stack there and
fixing only one is what makes sponsor wordmarks read backwards:
`v` is the ring angle measured **up** from +X, so on the right flank increasing
`v` climbs the car while increasing canvas Y goes down (the texture is upside
down); and an observer on that side sees the nose on their right, so increasing
`u` runs right-to-left for them. Hence `painter.text(..., { face: 'right' })`
draws with `scale(-1, -1)`. `face: 'left'` is drawn as-is; `face: 'top'` is
rotated −90° and reads from behind the car. `mirrorPoly` reflects `v` about 0.25
and is already correct for both flanks.

**HELMET-UV SPACE** — authored directly against `THREE.SphereGeometry`:
`u = phi/2π` with the seam at the **back** of the helmet, `v = 1 − θ/π` so
`v = 1` is the crown. The visor aperture is painted at `u 0.235..0.765`,
`v 0.115..0.665` and the glass patch sits inside it. `chassis.js` rotates the
sphere a quarter turn about +Y so `u = 0.5` faces −Z. Parts merged into the
helmet bucket that have no meaningful unwrap (aero fin, chin bar) pin every UV
into the flat strip at `v < HELMET_UV_SPARE`.

A new team is just a new `TEAMS` entry; override `team.paint(ctx, W, H, team, driver, seat)`
for a bespoke painter.

### `car/chassis.js`
```js
buildChassisGeometry(detail?) -> { buckets: Map<materialName, BufferGeometry>, drsFlap }
createCarModel(entry, { liveryTexture, detail }) -> CarModel
model.group / model.materials / model.wheels / model.anchors
model.setDRS(0..1) / setSteer(rad) / setWheelSpin([4]) / setSuspension([4]) / setBrakeHeat(t)
AXLE_FRONT_Z, AXLE_REAR_Z, WHEELBASE, TRACK_FRONT, TRACK_REAR, CAR_LENGTH, CAR_WIDTH
```
Body pieces are **merged per material** (9 meshes) and the geometry is cached
and shared by all 20 cars; only materials differ. Anything that animates must be
a separate child (see `drsPivot`).
`anchors = { cockpitEye, chaseTarget, nose, tail, exhaust, roll, frontWing }`.

Bucket names are `paint, carbon, carbonMatte, cockpitTrim, helmet, darkMetal,
glass, exhaust, rainLight`. All but `helmet` are keys on the `materials.js`
bundle. **`helmet` is not** — `CarModel` attaches
`materials.helmet = createHelmetMaterial(team, driver)` before it walks the
buckets, because helmets are per driver while the geometry is shared. Anything
else added to the bundle from outside is disposed correctly, since
`materials.dispose()` walks its own values.

**WEAVE UV SCALE (do not ship raw loft/extrude UVs into a carbon bucket).**
`materials.js` tiles the shared 0.25 m weave by `(4, 8)` for `carbon` and
`(3.4, 3.4)` for `carbonMatte`, so one UV unit must span `repeat * TOW_TILE`
metres of real surface. `chassis.js` exposes that as the `WEAVE` table and three
helpers — `loftUV(g, sections, tileU, tileV)` (perimeter/arc-length, for
anything from `loft`), `metricUV(g, tileU, tileV)` (per-vertex triplanar, for
extrudes and boxes) and the `matteUV` / `glossUV` shorthands. Default loft UVs
run 0..1 across a 30 mm blade and 0..1 along a 2 m halo, which stretches 5 mm
tows into 100:1 bands: that is what makes a halo read as a rubber hose and aero
furniture read as painted plastic.

**Gloss vs matte carbon is a LOOK decision, not a naming one.** `carbon` is a
full clearcoat lobe at `envMapIntensity 1.5`; any large, near-flat, sky-facing
panel put there mirrors the whole hemisphere and silhouettes as one uniform navy
slab. The entire front wing, all endplates, footplates, pylons and the underbody
are therefore `carbonMatte`; only the rear plane, beam wing, DRS flap and mirror
housings — which sit edge-on to the sky — keep the gloss.

### `car/materials.js`
`createCarMaterials(team, liveryMap)` → `{ carbon, carbonMatte, paint,
paintSecondary, accent, metal, darkMetal, titanium, exhaust, tyre, glass,
cockpitTrim, brakeDisc, brakeDuct, caliper, rainLight, decal, setBrakeHeat(t),
setRainLight(on), setWetness(w), dispose() }`.
Material-bucket names in `buildChassisGeometry()` must exist on this object.

### `car/wheels.js`
```js
buildWheelSet(materials, { frontZ, rearZ, frontTrack, rearTrack, chassis, detail }) -> WheelSet
set.setSteer(rad)                  // front only, Ackermann applied
set.setSpin([fl, fr, rl, rr])      // absolute wheel angle
set.setSuspension([fl, fr, rl, rr])// metres, +ve = compressed
set.setCompound('soft'|'medium'|'hard'|'inter'|'wet')
set.setBrakeGlow([4])
set.wheels[i] = { travelPivot, steerPivot, spinGroup, front, side, links, linkMeshes }
TYRE_RADIUS, TYRE_HALF_WIDTH_FRONT, TYRE_HALF_WIDTH_REAR, RIM_RADIUS
```

### `physics/vehicle.js`
```js
const v = new Vehicle({ circuit, config, id });
v.reset({ s, lateral, speed })
v.setControls({ steer, throttle, brake, drs, ers, shiftUp, shiftDown, autoGearbox })
v.step(dt)                    // FIXED dt only
v.pose = { position, quaternion }
v.telemetry = { speed, speedKph, rpm, rpmNorm, gear, throttle, brake, drs, ers,
                gLat, gLong, wheelSpin[], suspension[], slipRatio[], slipAngle[],
                tyreTemp[], tyreLoad[], brakeTemp[], lockup[], onTrack,
                trackS, trackLateral }
v.corneringLimit(speed)       // peak lateral m/s^2 (used by the AI profile)
v.surfaceProbe = (worldPos) => ({ grip, drag })   // injected by the game
DEFAULT_CONFIG                // every tunable, documented inline
```

### `ai/opponents.js`
```js
buildSpeedProfile(circuit, vehicle, { brakeG, accelG, safety, topSpeed }) -> Float32Array
new AIDriver({ vehicle, circuit, profile, skill, seed, name }).update(dt, rivalVehicles)
new OpponentField({ circuit, scene, entries, playerIndex, detail })
field.cars[i] = { entry, vehicle, model, ai, index }
field.profile / field.player / field.update(dt) / field.syncModels() / field.dispose()
```
`field.update(dt)` steps AI + physics + de-penetration. `field.syncModels()` is
the only thing that touches the scene graph — call it once per RENDER frame.

### `camera/cameras.js`
```js
const rig = new CameraRig(camera, { circuit, topSpeed, replaySeconds = 24 });
rig.follow({ position, quaternion, speed, telemetry })   // live references
rig.setMode(mode, { instant, transition })  / rig.cycleMode()
rig.update(dt) / rig.snap() / rig.addShake(0..1) / rig.setBaseFov(deg)

// read-back after update(dt)
rig.position / rig.lookAt / rig.velocity / rig.fov / rig.roll / rig.focusDistance
rig.mode / rig.roadShake / rig.shake

// tunables (all live)
rig.chase = { back, backSpeed, height, heightSpeed, fov, fovSpeed,
              lookAhead, lookAheadSpeed, swing, outside, rollPerG }
rig.mounts = { cockpitEye, tcam, bumper, chaseFocus }   // per-rig Vector3 copies
rig.orbitAngle / orbitAngleTrim / orbitSpeed / orbitRadius / orbitHeight
rig.orbitFov / orbitAim / orbitDolly / orbitLead        // hero; orbitSpeed = 0 = static
rig.transitionTime / rig.tvHoldMin / rig.tvHoldMax
rig.tvCameras           // the generated world-feed plan (read only)

// replay
rig.replay              // ReplayBuffer — always recording, even during playback
rig.startReplay({ offset, rate, mode }) -> bool
rig.stopReplay() / rig.seekReplay(secondsAgo) / rig.setReplayRate(r)
rig.replaying / rig.replayProgress / rig.recording

CAMERA_MODES = ['chase','cockpit','halo','bumper','tv','hero','wide']
MOUNTS                  // module-level defaults for rig.mounts
ReplayBuffer            // { push(dt, state), sample(t), oldest, newest, duration, clear() }
```
`setMode` cross-fades position/look/FOV/roll over `transitionTime` (smootherstep);
any change **into or out of `tv` is a hard cut**, because a world feed cuts.

Springs use **velocity feed-forward** (damping is relative to the target's own
velocity), otherwise a camera lags by `2v/ω` — ~35 m at racing speed. Chase
springs the follow **yaw**, not the position, so cornering lag reads as a
broadcast swing rather than as bad framing. `wide` feeds forward its circuit
anchor for the same reason. Cockpit/halo/bumper are rigid; only the look
direction and the helmet lag.

**Framing rule.** Every solver picks its FOV from a target subject size, then
expresses lead room / headroom / swing limits as a *fraction of the half-FOV*.
Do not add framing offsets in metres — they compose correctly at one distance
only.

`rig.focusDistance` is the live subject distance; `core/engine.js` feeds it to
`postfx.settings.dof.focus` for rig-driven DOF shots.

### `hud/hud.js`
```js
const hud = new HUD(container, { circuit });
hud.resize(w, h, dpr) / hud.setVisible(bool) / hud.dispose()
hud.render({ telemetry, race, cars, playerIndex, banner, flag })
formatLapTime(seconds) / formatGap(seconds)
```
`cars` is `[{ index, s, lateral, colour }]` (see `RaceSession.carDots()`).

### `fx/particles.js`
```js
const fx = new Particles(scene, { maxSmoke, maxDust, maxSpark, maxSpray, maxDebris, maxHaze, maxWind });
fx.attachRenderer(renderer, camera, postfx)      // soft particles + heat refraction
fx.emitSmoke(pos, vel, n, { colour }) / emitDust / emitSpray / emitDebris
fx.emitSparks(pos, vel, n, { floor, tangent, spread, rise, jitter, drag, colour })
fx.emitLockupHaze / emitMarbles / emitCarbonShards / emitContact / emitHeatHaze
fx.driveFromCar(car, dt, wetness)   // reads telemetry and emits the right effects
fx.update(dt) / fx.setWetness(w) / fx.setViewport(heightPx, fovDeg) / fx.reset() / fx.dispose()
```
**Particle `size` is a world-space RADIUS IN METRES**, converted to pixels in the
vertex shader by `uPixelScale = viewportHeight / (2 tan(fov/2))`. Call
`setViewport` whenever the viewport or FOV changes.

**`pos` / `vel` may be the caller's scratch vectors.** Every emitter jitters into
its own private scratch, so passing the module-level `_p` / `_v` (which is what
`driveFromCar` does, to stay allocation-free) is safe. Emitters used to
`set()` the vector they were still reading their origin from: x/z random-walked
and y — with no zero-mean term — climbed monotonically per particle, which lifted
the tail of each frame's burst up to a metre off the ground. Do not reintroduce
that pattern.

**`emitSparks(pos, vel, …)` takes a WORLD velocity**, not a car-relative one. A
chip scraped off the plank leaves at a fraction of the car's own velocity
(`driveFromCar` uses `0.62 · (fwd·u + right·v)`) and air-brakes from there, so it
trails the car in the car's frame while still moving forward in the world.
`tangent` (unit direction of travel) orients the launch fan across the direction
of travel; `floor` is the bounce plane.

**Streaked families (`STRETCH`) smear along APPARENT motion**, `aVel - uCamVel`,
scaled by `uCamRel` (1 for sparks, 0 for the wind pool) and capped at
`uMaxStreak` pixels. `Particles.update()` finite-differences the camera's own
world velocity, discarding teleports. The sprite stays centred on the particle's
true position with a one-sided capsule inside it — centring it on the middle of
the streak pushes a ground-skimming spark below the tarmac and the depth test
eats it.

### `audio/engine.js`
```js
const audio = new EngineAudio({ volume });
await audio.resume()          // must be called from a user gesture; safe to call anywhere
audio.attachPlayer(vehicle) / audio.update(dt) / audio.setMasterVolume(v)
audio.playShift(dir) / audio.playLockup(x) / audio.playKerb() / audio.dispose()
```
Nothing is constructed until `resume()` succeeds, which is what makes headless
capture silent and error-free.

### `weather/weather.js`
```js
const weather = new Weather({ sky, lighting, circuit, scene,
                              camera, rig, particles,      // optional
                              carMaterials, trackMaterial });

weather.setState(name, { immediate, transition })
weather.update(dt, cars, focus)        // cars = field.cars; focus = player position

// --- state -----------------------------------------------------------------
weather.state / .label / .params       // params = the live interpolated set
weather.wetness / .rain                // 0..1, what the SKY is doing
weather.surfaceWater / .lineWater      // 0..1, what the ROAD is actually like
weather.conditions                     // HUD-ready summary object

// --- surface, for physics/vehicle.js ---------------------------------------
weather.gripAt(s, lateral) -> 0..1          // feed into Vehicle.surfaceProbe
weather.probe(s, lateral, speed)            // -> { grip, drag, water, aquaplane }
weather.waterDepthAt(s, lateral) -> 0..1    // 1 = standing water
weather.aquaplaneRisk(s, lateral, speed)    // -> 0..1
weather.drynessAt(s, lateral) -> 0..1

// --- fields ----------------------------------------------------------------
weather.dryness                        // Float32Array per circuit sample (racing line)
weather.water / .basin / .rubber       // Float32Array[n * 21], (sample, lane) grid
weather.trackWetnessTexture            // DataTexture, u = s / circuit.length
weather.wetMapTexture                  // DataTexture, world-XZ projection
weather.dispose()

WEATHER_STATES / WEATHER_ORDER
```
**States** (wettest-last): `dry`, `lightCloud`, `overcast`, `drying`, `lightRain`,
`heavyRain`. The old names `cloudy | damp | wet | storm | rain` are still accepted
and alias onto these. Every state is a set of continuously interpolated scalars,
so a transition between *any* two is valid; `?weather=<name>` pins a state for the
live game and for every capture shot.

**The water field is simulated, not painted.** A `n x 21` (arc length x lane) grid
holds film depth. Rain fills it, sun and wind evaporate it, cars wipe it, and each
node's *capacity* comes from a boot-time measurement of how much of a local minimum
the road mesh actually is (`basin`) times how rubbered-in it is (`rubber`, a slow
integral of traffic). Because removal is proportional to depth, the equilibrium is
`inflow / removal`: a swept lane settles at a thinner film under rain and goes dry
when the rain stops, so **the drying line and the puddles are emergent**, not
authored. `setState(..., { immediate })` seeds the closed-form equilibrium so a
capture opens on the right-looking track instead of needing minutes of running.

**Exposure discipline.** Nothing here may cross the `postfx` calibration (diffuse
white 1.0, bloom threshold 1.25). Measured, all six states at `tv`/`chase`: p99 ≤
0.93, clipped pixels ≤ 0.06%. Two hard-won rules:
- **Only `exposureBias` changes image brightness.** `lighting`'s meter is driven by
  sky radiance, so dimming the sky, the ambient or the haze makes the meter open up
  by the same amount — measured, `skyDim`, `envScale` and `fogScale` are all
  *self-cancelling*. The per-state `ev` (stops) is applied as
  `lighting.exposureBias *= 2^ev`. It must **not** go through
  `sky.exposureCompensation`: `sky.js` assigns that field itself every update, so a
  weather trim written there is silently discarded.
- **Wet tarmac gets `envMapIntensity ≤ 1.0`.** At the grazing angles a wet track
  spends its screen area at, Fresnel is already ~1, so anything above 1.0 has the
  road out-radiating the sky it reflects and the far field goes milky.

`core/engine.js` adds `rain * 0.0020` to `scene.fog.density` on top of a ~0.00044
base, so the wet states carry `fogScale < 1` to keep the *product* sane.

### `game/race.js`
Race control (the session) **and** the game's front end. The constructor
signature is unchanged, so `core/engine.js` needs no edit; everything else is
additive. Optional constructor keys: `field, environment, weather, engine,
sessionType, format, difficulty, ui, seed`. Anything not passed is resolved
lazily from `window.__APEX__.engine` on the first `update()`.

```js
const session = new RaceSession({ circuit, cars, totalLaps, playerIndex });
session.start()                          // arm a grand prix + lights sequence
session.update(dt)                       // ONE FIXED STEP; call after field.update()
session.snapshot(index?)   // HUD-ready: lap, sector status, deltas, standings
session.carDots()          // minimap positions

// weekend
session.beginWeekend(format?, opts?)     // 'quick'|'grandPrix'|'sprint'|'timeTrial'
session.beginSession(type, opts?)        // 'practice'|'q1'|'q2'|'q3'|'race'|'timeTrial'
                                         // opts: { laps, minutes, formation, formationMetres,
                                         //         playerSlot, seedGrid }
session.advanceWeekend() / session.nextSessionType
session.classify()                       // -> [{ position, code, timeText, points, ... }]
session.setDifficulty('rookie'|'amateur'|'pro'|'expert'|'legend')
session.seedGrid({ scatter?, playerSlot? })   // invent a qualifying-shaped grid
session.gridTimes                        // pole-relative quali deficits, parallel to gridOrder
session.playerSlot                       // 1-based forced grid slot, or null

// race control
session.setFlag(f) / session.localFlag(sector, kind, seconds)
session.deployVSC(s) / session.endVSC()
session.deploySafetyCar(laps) / session.endSafetyCar()
session.throwRedFlag(reason) / session.resumeFromRed()
session.requestPit(index?, { compound }) / session.cancelPit(index?)
session.addPenalty(index, seconds, reason) / session.retire(index, reason)
session.skipFormation() / session.seedReferenceTimes()

session.standings / .phase / .flag / .sectorFlags / .drsEnabled
session.classification / .fastestLap / .messages / .frontEnd
```
`phase` ∈ `formation | grid | countdown | green | running | red | finished |
classified`. `flag` ∈ `green | yellow | double | blue | red | sc | vsc |
chequered`.

**It writes to the sim**, in three documented places only: `_kinematic()` poses
a car along the circuit where the tyre model cannot help (formation lap, pit
lane, garage, and `_updateParked()` for eliminated/retired cars, which must be
re-posed every frame or the field's AI simply drives them out of the garage
again); SC/VSC/limiter clamp `vehicle.u/v` *after* `field.update()` has stepped
physics; and `cfg.mass` / `cfg.tyreWearRate` track fuel and compound
(`_deriveGeometry()` is re-run so the static corner loads stay consistent).

**Never set `car.inPit`.** `OpponentField.update()` reads that flag as "a stop is
in progress" and hands the car to `_stepPit`, which dereferences `ai._pit` — an
object only the field creates. Race control parks cars with `_kinematic` instead.

**Gaps and intervals come from a timing trace, not from metres over a speed.**
Every driver banks `(progress, time)` into a 2048-sample ring at 30 Hz (~68 s,
about one lap). `_traceTimeAt(st, p)` binary-searches it for when that car was at
distance `p`, so a gap is literally "how long ago was the car ahead standing where
I am now" — stable through a braking zone, and interpolated to the millisecond.
`gap` is the measured quantity and `interval` is its first difference, so the
intervals telescope into the gap exactly the way a timing screen does. `progress`
is rebuilt from `lapsDone * length + s` on any jump over 45 m (a restage), never
integrated across it. `snapshot()` publishes `gap`/`interval` as **`null`**, never
`NaN`, when a driver has no time to compare.
It also publishes `telemetry.{fuelKg, compound, tyreAge, tyreLife}` for the HUD,
drives `environment.setStartLights(n)` for the five-red-lights sequence, and
rewrites the `aCell` attribute of the `MarshalPosts` flag instances so local
yellow/blue/chequered flags actually fly.

DRS follows the real rule: entitlement is latched when a car crosses a zone's
`detectS` within `DRS_WINDOW` (1.0 s) of the car ahead **on the road**, holds for
that zone only, and is re-decided at every detection loop. `state[i].drs` is the
entitlement; `state[i].drsOpen` (what `snapshot()` publishes as `drs`) is the flap
actually being open, which is what a tower's DRS pill means.

Starting compounds are chosen by `_startingCompound()` — softs and hards get
likelier toward the front and back of the grid respectively, so no contiguous
block of one compound can form. `seedGrid()` invents a qualifying-shaped order
from the AI personas plus ~0.2 s of driver scatter, calibrated so the pecking
order survives but team-mates interleave.

Exports: `RaceSession` (default too), `RaceFrontEnd`, `POINTS`, `TYRES`,
`DRY_COMPOUNDS`, `DIFFICULTIES`, `SESSION_DEFS`, `WEEKEND_FORMATS`,
`PIT_SPEED_LIMIT`, `formatDelta`, `formatClock`, `formatSector`,
`formatRaceTime` (hours field; `formatLapTime` has none, so a grand prix
classified through it reads "63:12.480" instead of "1:03:12.480").

**Front end.** `RaceFrontEnd` mounts `#apex-frontend` (z-index 40) into `#app`
and owns the title, setup, pause, settings and results screens, styled to the
HUD's design language. It drives the engine only through documented API
(`engine.frozen`, `rig.setMode`, `hud.setVisible/setGlass`, `weather.setState`,
`audio.setMasterVolume`, `vehicle.setAssists`). **It removes itself the instant
`engine.captureShot` is set and never mounts under `navigator.webdriver`**, so
`tools/shot.mjs` output is untouched. Query flags: `?ui=0` force off,
`?ui=1` force on (which is how the shell itself can be screenshotted).

The setup screen adds a **STARTING GRID** row (`AS QUALIFIED | POLE | P5 | P10 |
P16 | LAST`) which sets `session.playerSlot`. Attract mode borrows the hero rig
and hands its defaults back in `_startSession()`; the shell owns `orbitAngle`
while it is up (bounded sway around `ATTRACT_ANGLE`) because the rig's own
`orbitSpeed` integrates without bound and would rotate the framing away.

Race control likewise gets out of the way during a capture: it observes timing
and standings but never steers, and `seedReferenceTimes()` gives the staged
field a coherent set of lap/sector times derived from the AI speed profile so
the `hud` shot shows a real timing tower instead of dashes — seeded so the
timesheet AGREES with the running order (the car in front is, on average, the
quicker car), because a leader a second a lap slower than P4 is what makes a
tower read as fake. The `grid` shot gets five red lights on the gantry **and is
restaged into `gridOrder`** — the harness stages by car index, which is the entry
list, and produced a photograph with both cars of every team side by side in all
ten rows.

---

## 6. Performance budget (1080p, Apple M3 Max, target 60 fps)

| system | budget |
|---|---|
| draw calls | ≤ 450 (20 cars ≈ 260, environment ≈ 20, track 4) |
| triangles | ≤ 2.5 M |
| shadow pass | one 4096 cascade, ~55 m radius, texel-snapped |
| post stack | GTAO (12 samples) + bloom + SMAA; DOF only on hero shots |
| CPU sim | ≤ 2 ms for 20 cars at 1/60 |
| texture bakes | one-time, ~1 s total; check `assets.slowest()` |

Rules of thumb: instance anything repeated (barriers, crowd, trees, garages);
merge static geometry per material; never allocate `THREE.Vector3` inside a
per-frame loop (use the module-level scratch vectors each file already declares).
