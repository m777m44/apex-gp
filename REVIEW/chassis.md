# Round-5 findings — chassis

Files you own: `src/car/chassis.js`

4 findings (0 fatal).

## 1. [MAJOR] car/chassis.js (cockpit hands) 

**Defect:** The driver's gloves are faceted grey/white clay lumps with no fingers, no thumb wrap, no knuckles, no seams and visible low-poly facets — see shots/r4-motion-cockpit.png x=520..1140 y=520..900. At cockpit framing they are the second-largest object in the frame after the wheel and they are the single most damning object in the view. The wheel rim itself is a flat matte torus with no grip material.

**Prescribed fix:** Four separated finger tubes wrapping the rim (a swept capsule per finger is enough at this framing) plus a thumb over the top, a normal-mapped suede/fabric material on the glove and a grip-textured rim (the existing `fabric()` generator will do both). Fingers reading as fingers matters far more than polycount here.

## 2. [MAJOR] camera/cameras.js (cockpit mount) + car/chassis.js (halo)

**Defect:** The halo occupies the top ~28% of the cockpit frame as a pure-black featureless void with zero shading, zero specular and no edge highlight — a viewer reads it as a letterbox bar, not as a carbon hoop. Real F1 25 cockpit cam shows a slim shaped hoop with a bright rim light along its top edge and legible carbon.

**Prescribed fix:** Raise the eye point a few cm and/or thin the halo's rendered cross-section so it reads as a hoop with sky visible above it, and put a real material on it: carbonMatte with a rim/Fresnel term so the top edge catches a highlight against the sky. Right now it has neither form nor value separation from the frame border.

## 3. [MAJOR] car/materials.js + car/chassis.js

**Defect:** The deciding factor from last round is still not in frame: the flank carries zero environment gradient. At `tv` the sidepod is one flat red slab (the sd of 90 in that patch is entirely the white sponsor rectangle, not a gradient). The team's own analysis in the PAINT_ENV comment is correct on the physics and wrong about the car: they measured a gain of 20 as pixel-identical to a gain of 0 because their sidepod flank is effectively VERTICAL, so its reflection vector points into 13% tarmac. Real F1 sidepods roll over onto a sky-facing top deck and undercut hard beneath it, and the top deck is exactly where F1 25's sky band lives.

**Prescribed fix:** This is geometry, as their comment concludes — then they shipped nothing. Put a 60-100 mm roll-over radius on the sidepod shoulder stations and a real undercut below it in `chassis.js`, so the upper flank sees above the horizon and the lower flank sees the tarmac. Only then restore PAINT_ENV specular to ~0.45. Raising the gain alone will just put the magenta back on the tub.

## 4. [MINOR] car/chassis.js

**Defect:** Front wing element separation is soft. At `front` the four flaps read as one corrugated slab because the inter-element slots are ~1 px and receive no light; there is no dark gap line and no lit trailing-edge chamfer to separate them.

**Prescribed fix:** Widen the slot gaps and add a small bright chamfer to each element's trailing edge, so the gap reads as a dark line and the element behind it catches a lit edge. This is the single cheapest silhouette win left on the front wing.


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
