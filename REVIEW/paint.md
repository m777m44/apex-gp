# Round-5 findings — paint

Files you own: `src/car/livery.js`, `src/car/materials.js`

4 findings (0 fatal).

## 1. [MAJOR] car/materials.js

**Defect:** Front wing, endplates, footplates and every other `carbonMatte` surface render cobalt blue. Measured on shots/r4-car-beauty.png at (800,600,200x60): RGB 9.9/18.2/48.5, B-R +38.6, saturation 0.80. Mechanism is stated in the file's own comment and then not acted on: `envResponse` normalises the SPECULAR gain by ENV_SPEC_NORM (1/2.15) but deliberately leaves the DIFFUSE gain un-normalised, so `lighting.js` raising environmentIntensity 2.15x multiplied the sky-coloured IBL irradiance on a panel whose base colour was simultaneously lifted to 0xcfcdcb at diffuse envGain 1.00. A near-white satin panel lit 2.15x by a blue hemisphere takes the hemisphere's hue.

**Prescribed fix:** Normalise the diffuse gain the same way, or drop `carbonMatte`'s diffuse envGain from 1.00 to ~0.45 and pull `carbonMatte.color` back toward 0x8a8886. Then desaturate what remains by mixing the diffuse IBL term toward its own luminance by ~0.5 before it hits the albedo. Target: B-R <= +12 on that same patch with Ymean unchanged.

## 2. [MAJOR] car/materials.js

**Defect:** The floor / diffuser edge at `tv` is a pale steel-blue plank that out-reads the road. Same 180x30 patch at (620,560): Ymean 36.1 (r3) -> 62.8 (r4), while tarmac at (200,700,300x80) went 57.0 -> 52.7. A near-horizontal sky-facing satin surface 60 mm off the ground is now 20% brighter than the asphalt beneath it; on a real car it is the darkest thing in the frame. Same root cause as the front wing.

**Prescribed fix:** After normalising the diffuse gain, re-measure: the floor-edge patch should land at 0.6-0.8x the tarmac luminance at `tv`. If it does not, the remaining error is `carbonMatte.color` — 0xcfcdcb is a light grey standing in for autoclaved carbon.

## 3. [MAJOR] car/materials.js (carbonWeaveMaps)

**Defect:** The 2/2 twill aliases badly at normal framing. The rib pitch is correct in world units (~9 mm), but that lands at ~2 screen px, and the specular contrast the file deliberately widened (roughness 0.26 + edge*0.36) survives minification. Result: a regular round-dot halftone lattice on the front wing at `beauty`, and a serrated zipper along every carbon silhouette at `chase` — diffuser strakes, endplate leading edges, beam wing. The file's comment already identifies this as 'an undersampled specular, not a weave' and then only backs the crown roughness off from 0.22 to 0.26.

**Prescribed fix:** Roughness clamping is not the fix — mip-aware variance is. Bake a Toksvig/LEAN term: compute the normal-map variance per mip level and fold it into the roughness mip chain, so the weave's specular contrast rolls off with distance instead of shimmering. That lets you go BACK to 0.22 crown roughness for close-ups and get crisp silhouettes at range.

## 4. [MINOR] car/materials.js

**Defect:** No metallic flake is visible anywhere. `flakeNormalMap` is exported and referenced but at 3x on the sunlit shoulder of the red flank in `beauty` there is not one glitter texel — the highlight is a smooth clearcoat lobe with a slight magenta cast in it (red-top patch B-R -63.6). F1 team paint at golden hour sparkles.

**Prescribed fix:** Verify the flake normal is actually bound to `paint` with a mip-clamped high repeat (flake must NOT fade with distance the way relief does), then raise its normalScale until a 200x200 px patch of sunlit flank shows per-texel glitter. Also warm the specular tint: the highlight currently goes pink, real flake red goes orange-to-white.


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
