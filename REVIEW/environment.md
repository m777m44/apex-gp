# Round-5 findings — environment

Files you own: `src/track/environment.js`

8 findings (0 fatal).

## 1. [MAJOR] track/environment.js

**Defect:** Nothing in the pit lane casts a shadow. In the `grid` frame the pit lane is fully lit (measured 0.205 linear luma, brightest ground in shot) yet all ~40 crew figures, the tyre stacks, the trolleys, the wheel guns and the bollards float with no contact and no cast shadow. The ground-shadow fatal is fixed everywhere except here.

**Prescribed fix:** The pit-lane instanced meshes are missing castShadow. Run setShadows(root, true, true) over PitLane and its crew/furniture children, and confirm the pit lane is inside the cascade radius at the grid camera position — probe reports castCount dropping from 366 (tv) to 256 (grid), which suggests the pit-side content is being culled out of the shadow frustum.

## 2. [MAJOR] track/environment.js

**Defect:** Distant vegetation is a mass of hard-edged, high-contrast, identical green blobs at full saturation across the entire horizon of `wide`, with no distance-based desaturation or haze lift. The tall poplars are flat cards, all the same size and silhouette, visibly repeated. r3's version was softer and read better; r4 fixed the card seams but broke the read.

**Prescribed fix:** Restore aerial perspective on FarLandscape/Woodland: lerp albedo toward the sky horizon colour and drop saturation as a function of distance, tuned so a 3 km treeline sits between the 200 m trees and the 8 km skyline. Add 3-4 canopy silhouette variants and per-instance scale/hue jitter so the blob repeat stops being legible.

## 3. [MAJOR] track/environment.js

**Defect:** The pit garages — the single largest structure in the `grid` frame — are untextured flat mid-grey boxes with dark rectangular openings, a couple of white cuboids inside, and no interior lighting, depth or equipment. Reads as blockout geometry that shipped.

**Prescribed fix:** Give the garage bays a recessed interior box with a warm interior light, a back wall with team graphics, a roller-door lintel, floor markings and a few silhouette props (toolboxes, tyre sets, a hanging gantry). Even three depth planes per bay would remove the flat read.

## 4. [MAJOR] track/environment.js

**Defect:** Grandstand structure is an extruded slab roof sitting on plain rectangular columns — no truss, no purlins, no fascia depth, no underside detail. The crowd is a wall of identically-posed standing sprites in perfect rows: nobody seated, no aisles, no visible steps, and in `grid` the whole stand is one unlit black mass with zero tonal gradation.

**Prescribed fix:** Add a simple lattice truss to the roof edge and purlins to the underside (instanced, cheap). Mix seated and standing crowd cells in the atlas, cut vertical aisle gaps every ~12 columns, and give the stand a front-to-back ambient gradient so the front rows catch sky light.

## 5. [MINOR] track/environment.js

**Defect:** A tree/foliage card intersects the interior of the main grandstand — a floating green blob visible inside the structure at the same world position in both `grid` (approx x520,y350 of the stand crop) and `beauty` (approx x520,y215).

**Prescribed fix:** Add a rejection test in the tree scatter against the SpectatorEstate/Grandstands footprint volumes, not just the track corridor.

## 6. [MINOR] track/environment.js

**Defect:** There is no astroturf or green transition strip outboard of any kerb, and the grass tufts along the barrier in `beauty` are identical, evenly spaced on a perfect line, and sprout directly out of the tarmac edge with no soil or verge transition.

**Prescribed fix:** Add the green transition strip to corridorAt's outboard sequence, and jitter the grass-card scatter with a soil/dirt gradient card at the tarmac boundary.

## 7. [MINOR] track/environment.js

**Defect:** The run-off band between the outer white line and the grass in `wide` is a mottled purple-brown noise field that reads as neither gravel, asphalt nor dirt. It was clean dark asphalt in r3.

**Prescribed fix:** Pick one material per corridor segment and commit: either gravel() at its real 1.5 m worldSize with a warm neutral tint, or asphalt run-off at a lighter, greyer value than the racing surface. Remove the violet from whichever noise layer is currently on it.

## 8. [MINOR] track/environment.js

**Defect:** Heavy aliasing on catch-fence wires, grandstand handrails and the distant white lines in `grid` and `beauty`. The crowd sprite field in particular is a noise storm that will crawl in motion.

**Prescribed fix:** Mip-bias the fence and crowd alpha maps toward blur with distance, or swap the fence to a distance-faded alpha-blended sheet past ~40 m. SMAA is not going to save a 1-pixel wire grid.


---
# ALL 14 REGRESSIONS logged against round 4 (fix any that are yours)

- chase: crushed blacks nearly tripled. Pixels below L=6 went 1.85% -> 4.72%. The hero car's rear wing underside, beam wing, crash structure and diffuser are now a single readable-form-free black slab (shots/r4-motion-chase.png, car crop x=430..1050 y=330..770). A sunlit chase car under an open sky must never crush — sky bounce fills those faces in every reference frame.

- chase: aerial perspective is gone. r3 separated the hills, city towers and grandstand with haze; r4's far towers and hillsides now carry the same saturation and local contrast as the mid-ground hoardings, so the frame flattens into one depth plane. You overcorrected the round-3 'photograph of a photograph' note — the fix was to sharpen the far field, not to delete atmospheric falloff.

- hud: highlight range collapsed. Pixels above L=192 fell 13.2% -> 2.15% and mean luminance 81.1 -> 67.8. Some of that is the tighter framing (less sky), but the tarmac itself sits materially lower and the whole frame reads muddy rather than filmic.

- cockpit: the halo void got bigger and the out-of-focus cumulus sitting on top of it got worse. At 2x (shots/r4-motion-cockpit.png x=0..800 y=0..260) that cloud shows a regular diagonal dither weave from the raymarch AND ~200 px of horizontal smear — the exact 'no onboard camera has ever done this' artefact postfx.js:542-546 claims to have graded out.

- Front wing / all `carbonMatte` went cobalt blue. Measured on `beauty`, patch (800,600,200x60): B-R +28.5 (r3) -> +38.6 (r4), saturation 0.63 -> 0.80, mean RGB 9.9/18.2/48.5. The largest carbon area on the car now reads as blue plastic where r3 read as dark slate.

- Floor / diffuser edge at `tv` brightened 74% while the road under it darkened. Same 180x30 patch at (620,560): Ymean 36.1 -> 62.8; the surrounding tarmac at (200,700,300x80) went 57.0 -> 52.7. A sky-facing satin plank is now brighter than the asphalt it hovers over.

- The carbon twill now resolves as a regular round-dot halftone lattice on the front wing at `beauty` (5x crop), where r3 showed a diagonal hatch. Higher ambient against the same undersampled weave made the aliasing legible instead of noisy.

- Paint environment specular was reduced, not raised: PAINT_ENV 0.42 -> 0.30 effective (0.30 with ENV_SPEC_NORM 1/2.15 against a 2.15x envMapIntensity). The flank reflection I named last round's deciding factor is measurably weaker in r4 than in r3.

- Carbon silhouettes serrate. At `chase` every diffuser strake, endplate leading edge and beam-wing edge shows a regular notched zipper along the boundary (r4c crop at 2.6x) because the weave's specular contrast survives to the silhouette at ~2 px rib pitch.

- Aerial perspective on the far landscape was stripped. Measured on the same crop of `wide`: distant woodland r3 (82,110,79) -> r4 (93,114,66), 13 units of blue removed and saturation raised. The 3 km treeline now sits at full saturation while the 8 km skyline is still correctly hazed, so the depth ordering inverts. r3's horizon read like a photograph; r4's does not.

- Far vegetation silhouette got harder and more cartoon. The woodland is now a legible mass of identical high-contrast green 'pebble' blobs tiling across the whole horizon of `wide`. r3's soft/hazy version was more believable even with its visible rectangular card seams (which r4 did correctly fix).

- Sky/cloud regressed on `grid` and `chase`. r3's clouds were softer with altitude layering and a milky horizon band; r4's are hard-edged, flat-bottomed white puffs stamped on a more saturated blue, with the horizon haze band gone. Reads as a painted mobile-game skybox.

- The run-off strip between the outer white line and the grass in `wide` was clean dark asphalt in r3; in r4 it is a mottled purple-brown noise field that does not read as gravel, asphalt or dirt — it reads as pixel dirt.

- Sky luminance dropped ~8% (wide sky sample 188,195,188 -> 172,178,172) while the track was lifted ~50%, compressing the sky-to-ground separation that carried the establishing shot in r3.
