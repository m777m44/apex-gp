# Round-5 findings — fx

Files you own: `src/fx/particles.js`

1 findings (0 fatal).

## 1. [MAJOR] fx/particles.js

**Defect:** Skid-block sparks read as ~10 fat, isolated, identically-sized smooth orange lozenges with no white-hot core, no size or brightness variance, and several angled 30-45 degrees off the tarmac's streak direction (shots/r4-motion-hud.png x=470..1170 y=540..790). They also cast no light on the tarmac. Real titanium plank sparks are a dense fan of hundreds of fine white-hot streaks that visibly illuminate the road.

**Prescribed fix:** Raise count 10x and drop per-particle size ~4x; give each a white-hot (>1.0 linear) core with an orange falloff so bloom picks up only the core; randomise lifetime and size; align the launch fan to the tangent so streaks agree with the ground blur. Add one cheap additive ground decal under the shower for the bounce light.


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
