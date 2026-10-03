# Round-5 findings — circuit

Files you own: `src/track/circuit.js`, `src/textures/procedural.js`

2 findings (0 fatal).

## 1. [MAJOR] track/circuit.js

**Defect:** Kerbs are a flat painted ribbon at road height with zero geometric relief — no ribs, no vertical face, no bevel, no chamfer strip, no shadow at the join with the run-off, no rubber or dirt build-up. Verified in the tight `chase` kerb crop and again at the right edge of `beauty`. Called out in round 2 and round 3; unchanged. This is the single loudest hobby-project tell in the build.

**Prescribed fix:** Extrude the kerb as real geometry off the corridor: 45-60 mm proud of the racing surface, sawtooth or rounded-rib profile with a ~150 mm rib pitch, a chamfered inner lip and a bevelled outer face down to the run-off. Let it cast and receive shadows (it is already inside the cascade radius). Add an astroturf/green transition strip outboard, and darken the red blocks at the apex with laid rubber driven off `weather.rubber`.

## 2. [MAJOR] textures/procedural.js

**Defect:** asphalt() carries exactly one noise frequency — the aggregate. There is no mid-scale roller/bitumen mottle (0.3-1 m), no large-scale patch/seam/stain layer (5-20 m), no racing line, no rubber, no marbles, no repair patches. Result: the close-up in `beauty` reads well but from `wide`, `tv` and `grid` the entire racing surface collapses to one flat grey, and the single-frequency grain is the same pixel size at 1 m and 50 m so it will shimmer badly in motion.

**Prescribed fix:** Add two octaves above the aggregate: a 0.6 m bitumen-richness mottle into albedo+roughness, and a 12 m patch/seam mask with straight-edged repair rectangles and longitudinal joins. Then paint the racing line as a separate lane-width darkening driven off circuit.racingLineOffset(s) into a second albedo/roughness pass, with marbles accumulating outboard of it. Fade the aggregate normal to zero past ~25 m as a Nyquist LOD.


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
