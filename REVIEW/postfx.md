# Round-5 findings — postfx

Files you own: `src/render/postfx.js`

5 findings (2 fatal).

## 1. [FATAL] render/postfx.js

**Defect:** The ego-subject protection is derived from screen velocity, and the comment at postfx.js:571-575 deliberately excludes the wheels — but the implementation blurs the wheel's SILHOUETTE, not just its surface. Rotation cannot move the boundary of a circle; a spinning wheel's outline is invariant. In shots/r4-motion-chase.png the left rear tyre has no edge whatsoever (formless olive ellipse, colour bled in from outside the object), and in shots/r4-motion-hud.png both rear tyres fade into the tarmac as soft gradients with no rim, no sidewall, no brake glow. This is now the single loudest 'screen-space hack' tell in the frame, and it got MORE visible this round precisely because everything bolted to it is pin sharp.

**Prescribed fix:** Two changes. (1) Make the motion-blur gather depth-aware: reject or heavily down-weight taps whose linear depth differs from the centre pixel by more than ~0.4 m, so the ground's 226 px/frame velocity can never gather colour across the tyre boundary. That alone restores the silhouette without touching the tangential smear. (2) Confine the wheel's own blur to its tangential axis: the spin group already writes correct velocity, so clamp the gather direction to the projected tangential vector and cap it at ~24 px so the tread band smears into a spun ring while the outer edge stays hard.

## 2. [FATAL] render/postfx.js + fx/particles.js

**Defect:** Zero contact occlusion under the hero car. In shots/r4-motion-hud.png the tarmac directly beneath the floor, between the rear tyres and under the diffuser is the same luminance as tarmac 3 m behind. Same in chase. The car is a sticker on the road. GTAO is not reaching those fragments — the near tarmac is fully motion-blurred before AO can bite, and the AO world radius is smaller than the floor-to-ground gap.

**Prescribed fix:** Order AO before the near-field smear so the gather blurs an already-occluded surface, and add a cheap contact-darkening proxy: one ground-projected multiply card per car, sized to the floor plan, ~0.45 opacity, soft-edged, drawn with polygonOffset. Every Codemasters title has this exact card; it is the cheapest grounding win available and it costs one draw call per car.

## 3. [MAJOR] render/postfx.js

**Defect:** The near-tarmac blur is undersampled and destroys albedo. At 2x (x=0..560 y=300..700 of chase) the smear shows discrete parallel ghost stripes rather than a continuous streak, and the asphalt's aggregate, tar seams, racing line and rubber marbles are all gone — the road is a flat purple-grey gradient. Real motion blur preserves variation ACROSS the streak direction.

**Prescribed fix:** Jitter each tap's offset per-pixel with a blue-noise/interleaved-gradient dither keyed to gl_FragCoord (breaks the banding into grain at zero cost), and blend the gathered result toward a small-radius (2-3 px) sample of the unblurred source at ~15-20% so the low-frequency albedo survives the smear.

## 4. [MINOR] render/postfx.js / core/engine.js

**Defect:** Cockpit is the only gameplay camera under budget: 13.58 ms batch at 1600x900 (rafFps 63.4), which STATUS.md already concedes is 52-56 fps at 1080p. The camera a player spends a whole race in should not be the slowest one.

**Prescribed fix:** Add the cockpit-specific budget STATUS.md already scopes: drop shadow cascade 3 when the near field fills the frame, halve GTAO resolution, and skip the far-DOF pass (there is nothing at the focal far plane behind a halo).

## 5. [MINOR] render/postfx.js

**Defect:** The racing surface carries a ~6% magenta tint — `wide` track samples RGB (87,82,84), green channel 5 units low against both red and blue. On the biggest surface in every frame this is what makes the tarmac read violet rather than as asphalt.

**Prescribed fix:** Neutralise the LUT's midtone in the 0.08-0.15 luma band, or pull the shadowTint magenta out of makeLookLUT. Real dry asphalt should sit neutral-to-very-slightly-warm at mid grey.


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
