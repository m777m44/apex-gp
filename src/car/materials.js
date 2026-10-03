/**
 * APEX GP — car material library.
 *
 * One `CarMaterials` bundle per car. The expensive maps are baked once and
 * shared through the asset registry; only colour and a couple of scalars differ
 * between teams, so twenty cars cost twenty small material objects.
 *
 * The goal is to never read as plastic. Every surface here has a real physical
 * story:
 *
 *   paint      pigment + metallic flake under a separate clearcoat lobe, with a
 *              per-texel clearcoat map so swirl marks, fingerprints and dust
 *              break up the reflection. Uniform roughness is the enemy.
 *   carbon     genuine 2x2 twill: 5 mm tows, a bulged cross-section, filament
 *              striations, and an ANISOTROPY MAP whose direction rotates 90 deg
 *              per tow so the specular streaks follow the weave the way real
 *              pre-preg does. Resin clearcoat on top.
 *   metals     anodised aluminium, brushed titanium (anisotropic), and an
 *              Inconel exhaust whose heat tint comes from a real thin-film
 *              iridescence layer rather than a painted-on gradient.
 *   glass      tinted visor / camera lens with iridescence and a clearcoat.
 *   rubber     matte carcass, very low env response, sheen at grazing angles.
 *
 * BODY UV CONVENTION (shared with car/chassis.js and car/livery.js):
 *   u = 0 at the nose tip -> 1 at the rear crash structure (longitudinal)
 *   v = 0 right flank, 0.25 top, 0.50 left flank, 0.75 floor.
 */

import * as THREE from 'three';
import { assets } from '../core/assets.js';
import { brushedMetal, rubber, mapsToMaterial, cloneMaps, setRepeat } from '../textures/procedural.js';
import { fbm, makeRng, clamp, lerp, smoothstep } from '../core/rng.js';
import { bodySurfaceMaps, buildTeamDecals } from './livery.js';

// ---------------------------------------------------------------------------
// Bakes
// ---------------------------------------------------------------------------

function dataTex(bytes, size, colorSpace) {
  const t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 16;
  t.needsUpdate = true;
  return t;
}

/** sRGB transfer function — authoring reflectance in LINEAR and encoding once. */
function srgbEnc(x) {
  const v = clamp(x, 0, 1);
  return (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;
}

// ---------------------------------------------------------------------------
// TOKSVIG MIPS — the fix for the weave aliasing, and it cannot be done with
// `generateMipmaps`.
// ---------------------------------------------------------------------------
//
// The 5 mm tow pitch is correct in world units and lands at ~2 screen pixels at
// `chase`. Averaging the ALBEDO and the NORMAL down a mip chain is fine; what
// breaks is that the ROUGHNESS is averaged too, so a minified texel keeps a
// crown roughness of ~0.25 while the geometry it now covers contains a dozen
// tows pointing in a dozen directions. A tight lobe over a surface whose normal
// is really a wide cone is exactly an undersampled specular: it is what makes
// the twill resolve as a round-dot halftone at `beauty` and what serrates every
// diffuser strake and endplate edge at `chase`, because the weave's specular
// contrast survives all the way to the silhouette.
//
// The standard answer (Toksvig 2004) is to fold the NORMAL-MAP VARIANCE into
// the roughness as it is minified: box-average the normals as vectors, and
// wherever the average is short — i.e. the normals disagreed — widen the lobe
// by that much. `1 - |Navg|` is the disagreement, and adding it to r^2 in
// quadrature is the same convolution a longer filter would have applied.
//
// Once roughness rolls off correctly the crown can go BACK to the sharp value
// the review asked for, because it now only applies where the tow is actually
// resolved. The anisotropy strength is rolled off by |Navg| for the same
// reason: an averaged direction is not a direction.
const TOKSVIG_K = 1.75;

/** Box-halve an RGBA byte image. */
function halveRGBA(src, w) {
  const h = w >> 1;
  const dst = new Uint8Array(h * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < h; x++) {
      const o = (y * h + x) * 4;
      for (let c = 0; c < 4; c++) {
        const a = ((y * 2) * w + x * 2) * 4 + c, b = ((y * 2) * w + x * 2 + 1) * 4 + c;
        const d = ((y * 2 + 1) * w + x * 2) * 4 + c, e = ((y * 2 + 1) * w + x * 2 + 1) * 4 + c;
        dst[o + c] = (src[a] + src[b] + src[d] + src[e] + 2) >> 2;
      }
    }
  }
  return dst;
}

/**
 * Build the mip chains for a weave's {normal, orm, aniso} together.
 *
 * @param {Uint8Array} nrm0  level-0 tangent normals, RGBA bytes
 * @param {Uint8Array} orm0  level-0 ORM (G = roughness)
 * @param {Uint8Array} ani0  level-0 anisotropy (B = strength)
 * @param {number} size      level-0 side
 * @returns {{normal:Array, orm:Array, aniso:Array}} mip level arrays, level 0 first
 */
function weaveMipChains(nrm0, orm0, ani0, size) {
  const normal = [{ data: nrm0, width: size, height: size }];
  const orm = [{ data: orm0, width: size, height: size }];
  const aniso = [{ data: ani0, width: size, height: size }];

  // Carry the normals as floats so the average is a genuine vector mean rather
  // than a byte-quantised one; `len` is what the roughness fold consumes.
  let w = size;
  let nx = new Float32Array(size * size), ny = new Float32Array(size * size), nz = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    nx[i] = nrm0[i * 4] / 127.5 - 1;
    ny[i] = nrm0[i * 4 + 1] / 127.5 - 1;
    nz[i] = nrm0[i * 4 + 2] / 127.5 - 1;
  }
  let ormL = orm0, aniL = ani0;

  while (w > 1) {
    const h = w >> 1;
    const ox = new Float32Array(h * h), oy = new Float32Array(h * h), oz = new Float32Array(h * h);
    const nrmB = new Uint8Array(h * h * 4);
    const ormB = halveRGBA(ormL, w);
    const aniB = halveRGBA(aniL, w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const o = y * h + x;
        const a = (y * 2) * w + x * 2, b = a + 1, c = a + w, d = c + 1;
        let X = (nx[a] + nx[b] + nx[c] + nx[d]) * 0.25;
        let Y = (ny[a] + ny[b] + ny[c] + ny[d]) * 0.25;
        let Z = (nz[a] + nz[b] + nz[c] + nz[d]) * 0.25;
        const len = Math.max(1e-4, Math.hypot(X, Y, Z));
        ox[o] = X; oy[o] = Y; oz[o] = Z;
        const inv = 1 / len;
        nrmB[o * 4] = clamp(X * inv * 0.5 + 0.5, 0, 1) * 255;
        nrmB[o * 4 + 1] = clamp(Y * inv * 0.5 + 0.5, 0, 1) * 255;
        nrmB[o * 4 + 2] = clamp(Z * inv * 0.5 + 0.5, 0, 1) * 255;
        nrmB[o * 4 + 3] = 255;

        // Widen the lobe by the disagreement between the four normals.
        const variance = clamp(1 - Math.min(1, len), 0, 1);
        const r = ormB[o * 4 + 1] / 255;
        ormB[o * 4 + 1] = clamp(Math.sqrt(Math.min(1, r * r + TOKSVIG_K * variance)), 0, 1) * 255;
        // An averaged direction is not a direction.
        aniB[o * 4 + 2] = aniB[o * 4 + 2] * Math.min(1, len);
      }
    }
    normal.push({ data: nrmB, width: h, height: h });
    orm.push({ data: ormB, width: h, height: h });
    aniso.push({ data: aniB, width: h, height: h });
    nx = ox; ny = oy; nz = oz;
    ormL = ormB; aniL = aniB; w = h;
  }
  return { normal, orm, aniso };
}

/** A DataTexture whose mip chain was baked above, not generated by the driver. */
function mippedTex(levels, size, colorSpace) {
  const t = dataTex(levels[0].data, size, colorSpace);
  t.mipmaps = levels;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function normalFromHeight(h, size, strength) {
  const px = new Uint8Array(size * size * 4);
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      px[i] = (nx * inv * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      px[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

/**
 * 2x2 twill carbon fibre with a matching anisotropy map.
 *
 * TOWS is the number of tow crossings per tile. At `worldSize` 0.25 m and 50
 * tows the pitch is 5 mm, which is what a real pre-preg 3k twill measures — get
 * this wrong and the weave reads as a knitted jumper or as flat grey.
 *
 * @returns {{map, normalMap, ormMap, anisotropyMap, worldSize}}
 */
function carbonWeaveMaps() {
  return assets.get('mat:carbonWeave', () => {
    const SIZE = 1024;
    const TOWS = 50;
    const albedo = new Uint8Array(SIZE * SIZE * 4);
    const orm = new Uint8Array(SIZE * SIZE * 4);
    const aniso = new Uint8Array(SIZE * SIZE * 4);
    const height = new Float32Array(SIZE * SIZE);

    for (let y = 0; y < SIZE; y++) {
      const v = (y + 0.5) / SIZE;
      for (let x = 0; x < SIZE; x++) {
        const u = (x + 0.5) / SIZE;
        const su = u * TOWS, sv = v * TOWS;
        const cu = Math.floor(su), cv = Math.floor(sv);
        const fu = su - cu, fv = sv - cv;

        // 2/2 twill: the warp floats over two picks, then under two, and the
        // float start shifts by one each column — that is what makes the
        // diagonal rib.
        const warpOver = (((cv - cu) % 4) + 4) % 4 < 2;
        const across = warpOver ? fu : fv;   // across the visible tow
        const along = warpOver ? fv : fu;    // along the visible tow

        // Cross-section of a flattened tow: a broad bulge that pinches at the
        // edges where it dives under its neighbour.
        const bulge = Math.pow(Math.sin(Math.PI * clamp(across, 0, 1)), 0.65);
        // The float dips slightly at both ends as it crosses under.
        const floatPhase = warpOver ? (((cv - cu) % 4) + 4) % 4 : (((cu - cv) % 4) + 4) % 4;
        const dip = 1 - 0.16 * Math.abs((floatPhase + along) / 2 - 0.5) * 2;

        // Filaments: fine striations running ALONG the tow.
        const fil = fbm(warpOver ? u * 1.0 : v * 1.0, warpOver ? v * 0.04 : u * 0.04,
          { freq: 380, octaves: 2, seed: 17 });
        const grain = fbm(u, v, { freq: 9, octaves: 3, seed: 53 });

        // ALBEDO: near-uniform graphite. This used to run 0.026 to ~0.074 — a
        // 2.8:1 ratio, which after sRGB encoding is a strong checkerboard that
        // stays fully legible in shadow, and it turned the tow crowns cream. Real
        // carbon under clearcoat is one flat dark grey whose weave only appears
        // where the specular grazes it, so the range is compressed to ~1.6:1 and
        // the read is moved into the specular below (anisotropy + a wider crown /
        // interstice roughness split). The weave should VANISH in shade and BLAZE
        // in the highlight.
        // ROUND 5 — THIS WAS AUTHORED IN THE WRONG SPACE, and it is the reason
        // every carbon part on this car needed a huge reflection gain propping
        // it up. `l` ran 0.030..0.048 and was written STRAIGHT into an
        // `SRGBColorSpace` texture, so the renderer decoded it as
        // (0.030/12.92 .. ) -> about 0.0023..0.0055 LINEAR reflectance. Cured
        // pre-preg carbon measures 0.02..0.045 linear. The bucket was therefore
        // an order of magnitude too dark, the diffuse term could not light it,
        // and the only thing keeping the front wing visible was a specular gain
        // of 1.83 physical pointed at a blue sky — which is precisely the cobalt
        // finding. Author the reflectance in LINEAR and encode it once.
        const l = 0.0205 + bulge * 0.0135 * dip + fil * 0.0055 + grain * 0.0035;
        const i = (y * SIZE + x) * 4;
        // Tint: epoxy over black filament is very slightly COOL, but 1.14 in blue
        // against 0.96 in red is a 19 % channel spread, and on a large flat panel
        // (front wing, endplates, floor edge) that silhouettes as navy plastic
        // rather than as carbon. 1.05 / 0.99 keeps the resin's cool cast at the
        // few-per-cent level a photograph shows.
        // NEAR-NEUTRAL, and warm rather than cool. A 5 % blue lift in the albedo
        // survives every lighting change and stacks with a sky-coloured
        // reflection; measured, that stack is what put the largest carbon area
        // on the car at B-R +38.6. The resin's cool cast belongs in the
        // specular, where `apexEnvGain.z` now controls it.
        albedo[i] = srgbEnc(l * 1.010);
        albedo[i + 1] = srgbEnc(l * 1.000);
        albedo[i + 2] = srgbEnc(l * 0.985);
        albedo[i + 3] = 255;

        height[y * SIZE + x] = bulge * dip * 0.86 + fil * 0.06;

        // Resin pools in the interstices, so the weave valleys are both darker
        // and glossier than the crowns. That split was 0.30 + edge*0.30; widened
        // to 0.26 + edge*0.36 (0.26..0.62 instead of 0.30..0.60) so the contrast
        // the albedo just gave up comes back as a SPECULAR one — the only place a
        // viewer should ever find carbon weave.
        //
        // The review asked for 0.22 + edge*0.42. Measured on `beauty`, that crown
        // roughness of 0.22 is too sharp for the geometry it lands on: the floor
        // edge and front-wing footplates present 5 mm tows at a grazing angle and
        // well under a pixel each, and a lobe that tight turns golden-hour sun into
        // a shimmering tan basketwork — an undersampled specular, not a weave.
        // 0.26 keeps the shade/highlight swing and stops the aliasing.
        //
        // ROUND 4 adds the low-frequency term the review asked for. The weave
        // was still reading BIMODAL — near-black in shade, one flat value when
        // lit — because both the albedo and the roughness were periodic at the
        // 5 mm tow pitch and nothing else. Two tows away is the same surface, so
        // a whole panel switches between two states together as the view moves.
        // `sheenBreak` is a 0.15 m feature (freq 1.7 against a 0.25 m tile), i.e.
        // the scale of a real lay-up's resin richness and autoclave bag print,
        // and it makes the sheen TRAVEL across a panel instead of flicking.
        const edge = 1 - bulge;
        const sheenBreak = (fbm(u, v, { freq: 1.7, octaves: 2, seed: 401 }) - 0.5) * 0.13;
        // ROUND 5. Back to the 0.22-ish crown the review asked for, now that
        // `weaveMipChains` widens the lobe as the tow stops being resolved:
        // 0.23 + edge*0.40 is 0.23..0.63, the full shade-to-blaze swing, and
        // minification opens it instead of shimmering it.
        // AO floor 0.42 -> 0.56. This is a 5 mm tow crossing, not a crevice:
        // 0.42 was occluding 58 % of the ambient over the whole interstice, and
        // on a bucket that is almost entirely ambient-lit (an aero element in
        // the nose's shadow) that alone took the front wing to a third of the
        // luminance the geometry deserves. Real weave AO measures ~0.65 in the
        // valley.
        orm[i] = clamp(0.56 + bulge * 0.44, 0, 1) * 255;
        orm[i + 1] = clamp(0.23 + edge * 0.40 - fil * 0.06 + grain * 0.05 + sheenBreak, 0.12, 0.88) * 255;
        orm[i + 2] = clamp(0.10 + bulge * 0.16, 0, 1) * 255;
        orm[i + 3] = 255;

        // Anisotropy direction, in tangent/bitangent space. Warp tows run along
        // v, weft tows along u; the strength falls off at the tow edges — the
        // floor of 0.38 (was 0.35) lifts the interstices just enough to keep the
        // twill's diagonal reading once the albedo no longer carries it.
        aniso[i] = (warpOver ? 0.5 : 1.0) * 255;
        aniso[i + 1] = (warpOver ? 1.0 : 0.5) * 255;
        aniso[i + 2] = clamp(0.38 + bulge * 0.60, 0, 1) * 255;
        aniso[i + 3] = 255;
      }
    }

    const chains = weaveMipChains(normalFromHeight(height, SIZE, 2.2), orm, aniso, SIZE);
    return {
      map: dataTex(albedo, SIZE, THREE.SRGBColorSpace),
      normalMap: mippedTex(chains.normal, SIZE, THREE.NoColorSpace),
      ormMap: mippedTex(chains.orm, SIZE, THREE.NoColorSpace),
      anisotropyMap: mippedTex(chains.aniso, SIZE, THREE.NoColorSpace),
      worldSize: 0.25,
    };
  });
}

function normalTex(bytes, size) { return dataTex(bytes, size, THREE.NoColorSpace); }

/**
 * CLEARCOAT normal for painted panels — orange peel and metallic flake.
 *
 * This map is the correct home for every sub-millimetre feature on a painted
 * surface, and the reason is worth stating: it is wired ONLY to
 * `clearcoatNormalMap`, so it perturbs the coat's specular lobe and nothing else.
 * Diffuse shading, AO and the base layer never see it. Put the same detail in a
 * base `normalMap` and it terminator-shades the whole panel, which is how a car
 * ends up looking like hammered metal (see `livery.paintRelief`).
 *
 * SCALE. The map covers a 60 mm patch of body (repeat 90 x 32 against a 5.45 m x
 * ~1.9 m unwrap), which is what buys the sub-mm detail. The old version tiled a
 * 0.30 m patch and asked for freq 150 out of a 256 px texture — 1.7 px per cycle,
 * i.e. straight past Nyquist, so the finest "flake" octave was pure aliasing that
 * mip-filtering then averaged to flat grey. 512 px over 60 mm gives freq 34 a
 * comfortable 15 px/cycle and the sparse flake domes 3 texels each.
 *
 * Three physical layers, three different length scales:
 *   orange peel  ~10 mm undulation from the spray gun's droplet pattern
 *   coat texture ~1.8 mm, the sanded-and-polished micro-relief
 *   flake        sparse ~0.4 mm aluminium platelets, a few degrees off normal.
 *                Density and TILT make a flake glint, not amplitude — one flake
 *                per ~110 texels is what reads as sparkle rather than as noise.
 */
function flakeNormalMap() {
  return assets.get('mat:flakeNormal', () => {
    const SIZE = 512;
    const h = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const u = x / SIZE, v = y / SIZE;
        h[y * SIZE + x] = fbm(u, v, { freq: 6, octaves: 2, seed: 211 }) * 0.62
                        + fbm(u, v, { freq: 34, octaves: 2, seed: 907 }) * 0.30;
      }
    }

    const rng = makeRng('mat:flake');
    const wrap = (a) => ((a % SIZE) + SIZE) % SIZE;
    const flakes = Math.round((SIZE * SIZE) / 110);
    for (let k = 0; k < flakes; k++) {
      const cx = Math.floor(rng() * SIZE), cy = Math.floor(rng() * SIZE);
      const a = (0.55 + rng() * 0.45) * 0.5;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          h[wrap(cy + dy) * SIZE + wrap(cx + dx)] += a * (dx || dy ? 0.40 : 1);
        }
      }
    }

    const t = normalTex(normalFromHeight(h, SIZE, 0.14), SIZE);
    t.repeat.set(90, 32);          // body UV: 5.45 m x ~1.9 m -> a ~60 mm tile
    return t;
  });
}

/**
 * The flake map at a different tiling.
 *
 * Necessary because the map is now scaled for BODY UV (repeat 90 x 32 over a
 * 5.45 m x 1.9 m unwrap = a 60 mm tile), and the carbon buckets are unwrapped in
 * METRES by `chassis.metricUV`/`loftUV` — one UV unit there is ~0.4 m, so reusing
 * the body repeat would ask for a 4 mm tile and drive every flake octave below a
 * pixel. Mip selection would then quietly average it back to flat and the coat
 * would lose its micro-normal altogether. A clone re-uses the same GPU upload, so
 * this costs a texture object and nothing else.
 */
function flakeTiled(key, rx, ry) {
  return assets.get(`mat:flakeNormal:${key}`, () => {
    const t = flakeNormalMap().clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    return t;
  });
}

/** Shared metal maps, each with its own tiling. */
function metalMaps(key, opts, repeat) {
  return assets.get(`mat:metal:${key}`, () => {
    const m = cloneMaps(brushedMetal({ ...opts, key: `mat:metalSrc:${key}` }));
    setRepeat(m, repeat[0], repeat[1]);
    return m;
  });
}

/**
 * Anisotropy map for brushed metal: one constant direction (the brush runs
 * along u) at full strength.
 */
function brushDirectionMap() {
  return assets.get('mat:brushDir', () => {
    const SIZE = 8;
    const px = new Uint8Array(SIZE * SIZE * 4);
    for (let i = 0; i < SIZE * SIZE; i++) {
      px[i * 4] = 255; px[i * 4 + 1] = 128; px[i * 4 + 2] = 255; px[i * 4 + 3] = 255;
    }
    const t = dataTex(px, SIZE, THREE.NoColorSpace);
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    return t;
  });
}

// ---------------------------------------------------------------------------
// PER-MATERIAL ENVIRONMENT RESPONSE
// ---------------------------------------------------------------------------
//
// `material.envMapIntensity` IS DEAD CODE ON THIS CAR, and it has been all
// along. three r185, WebGLRenderer.setProgram:
//
//   if ( ( material.isMeshStandardMaterial || ... ) &&
//        material.envMap === null && scene.environment !== null ) {
//     m_uniforms.envMapIntensity.value = scene.environmentIntensity;
//   }
//
// Nothing on the car binds its own `envMap` — the IBL arrives through
// `scene.environment` — so every single `envMapIntensity` literal in this file
// was being overwritten with `scene.environmentIntensity` (1.0) before the draw.
// Measured live at `front`: setting `paint.envMapIntensity` to 0.0001, to 3, or
// to 60 produced pixel-identical frames; binding `paint.envMap =
// scene.environment` by hand and repeating the sweep changed the car
// dramatically. So the entire material hierarchy this file thought it was
// authoring — gloss carbon 1.5, titanium 1.7, visor 2.6, tyre 0.5, Nomex 0.35 —
// was flattened to a single 1.0, and `setWetness`'s env ramps did nothing at all.
//
// The fix has to live here rather than in `render/lighting.js` (not mine) and
// must not depend on a texture that does not exist at construction time (the
// PMREM is rebuilt periodically and the render target is replaced each time), so
// it is a shader patch: the two IBL accessors get a per-material `vec2` gain,
// `x` on the diffuse irradiance and `y` on the specular radiance. It is a
// UNIFORM, not a `#define`, so one extra program serves the whole car and
// `setWetness` can still ramp it every frame.
//
// SPLITTING DIFFUSE FROM SPECULAR IS THE POINT, not a convenience. The single
// worst thing in the paint was that a full-strength clearcoat mirror over the
// whole body erased the livery: on the `front` capture the nose — painted
// #0e1014, i.e. near black — rendered as a silver-pink smear, because a nose
// cone seen head-on presents almost nothing but grazing angles and Schlick then
// hands the coat most of the sky. Cutting the DIFFUSE term would have crushed
// the shadow side; cutting the SPECULAR term alone gives the paint its colour
// back and leaves the ambient fill intact.
//
// ---------------------------------------------------------------------------
// THE PROBE HAS NO GROUND, WHICH IS WHY NOTHING ON THIS CAR REFLECTS ANYTHING
// ---------------------------------------------------------------------------
//
// `render/lighting.js` builds the PMREM with `envScene = { sky.envMesh }` and
// nothing else. `sky.envMesh` is a SPHERE, so the lower hemisphere of the probe
// is not the ground — it is the sky, mirrored. Measured off the live `tv` frame
// by rendering the PMREM to a lat-long strip (linear radiance, one row per 11
// degrees of elevation):
//
//     +87  0.774    +42  0.193     -3  0.205    -48  0.370
//     +76  0.650    +31  0.152    -14  0.087    -59  0.338
//     +65  0.433    +20  0.222    -25  0.139    -70  0.535
//     +53  0.331     +8  0.215    -37  0.136    -82  0.888
//
// The brightest cell in the entire probe is 82 degrees BELOW the horizon. A
// sidepod is a convex mirror: as its normal rotates through ~120 degrees across
// the flank the reflection vector sweeps most of the sphere, and if every
// direction returns the same 0.2-0.8 there is no image in it — just a flat
// sheen that adds to the diffuse and reads as more diffuse. That is the whole
// defect. It is not a missing binding (scene.environment is live, 768x1024, and
// the gain uniform below demonstrably reaches it), it is not envMapIntensity,
// and it is not roughness: `livery.js` already floors the coat at 0.030, which
// is a genuine mirror. There was simply nothing to see.
//
// The same fact explains the pale block under the nose that has been logged
// twice: the two `carbonMatte` plates at the nose/wing joint face DOWN-forward,
// so they reflect the brightest part of the probe. Setting `envGain.y = 0` on
// carbonMatte alone makes the block vanish (measured on `front`), which is what
// identified it — it was never an untextured material, it was a mirror pointed
// at a fake sky.
//
// FIX, and why it lives here. Adding a ground plane and the trackside band to
// `Lighting.envScene` is the physical fix and it is one line, but it is in a
// file I do not own. What I can do is composite the ground into the probe at
// the point of use: `getIBLRadiance` already has the reflection vector in WORLD
// space (`transformDirectionByInverseViewMatrix`), so everything needed to draw
// a horizon is in hand. Below the horizon the sky sample is replaced by tarmac
// radiance, with a narrow brighter band right under the line for barriers,
// hoardings and grandstands. The transition half-width scales with the lobe's
// own roughness, so the clearcoat gets a hard line and a satin surface gets a
// gradient — which is exactly the difference between a lacquered flank and a
// matte one.
//
// The ground's BRIGHTNESS is taken from the probe itself (the fully-blurred mip
// in the +Y direction, i.e. the sky's own average radiance) rather than from a
// constant, so it tracks time of day, cloud cover and weather with no CPU hook
// and nothing to keep in sync. One extra `textureCubeUV` fetch per IBL radiance
// evaluation; the top mip is 1x1-ish and always in cache.
//
// `getIBLAnisotropyRadiance` calls `getIBLRadiance`, so the weave gets the
// horizon for free.
//
// NOT applied to `getIBLIrradiance`. That term is the ambient fill, it is
// cosine-weighted over a hemisphere and mostly upward, and cutting the bounce
// off downward-facing normals is what crushes the shadow side of `wheel`. The
// image lives in the SPECULAR; leave the fill alone.

/**
 * The synthetic lower hemisphere, as fractions of the sky's own average
 * radiance (so all four numbers are exposure-, weather- and time-of-day-free).
 *   rgb  tarmac reflectance. Dry asphalt is ~7% and slightly warm; 13% here
 *        because the probe average is a hemisphere mean and the road the car
 *        actually sits on is the SUNLIT part of it.
 *   a    the trackside band: Armco, hoardings, marshal posts and the lower
 *        grandstand. Roughly half the radiance of the horizon sky behind them.
 */
const ENV_GROUND = { value: new THREE.Vector4(0.130, 0.124, 0.118, 0.40) };

/**
 * Probe contrast: [pedestal as a fraction of the sky average, gain, knee].
 *
 * A GAIN ON ITS OWN DOES NOT BUY BANDING — measured, and this is the single most
 * useful number in the file. Sweeping `PAINT_ENV[1]` at 0.42 / 1.00 / 1.60 /
 * 2.40 on `tv` and reading a 20-row luminance profile down the sidepod flank:
 *
 *     row (px)   35 (shoulder)   45 (flank)   peak:trough   flank saturation
 *     0.42            122            69           1.77            0.34
 *     1.00            165            93           1.77            0.27
 *     1.60            189           108           1.75            0.24
 *     2.40            207           119           1.74            0.21
 *
 * The ratio never moves. Multiplying the probe multiplies the band AND the
 * pedestal under it, so all a gain does is add grey and wash the livery out —
 * which is exactly what the `front` capture showed (a pink-silver nose from
 * ~0.7 upward, the failure this file already logged once).
 *
 * The reason is in the probe. Measured elevations 20-53 deg all sit inside
 * 0.15..0.33 linear, and a vertical flank viewed from a broadcast tower
 * reflects precisely that band — the flattest 1.3:1 slice of the whole sphere.
 * There is no image in it to amplify.
 *
 * So: expand the sky about its own mean instead of scaling it. Subtract a
 * pedestal, apply a modest gain, and the dull mid-sky a nose-on view samples
 * gets DARKER while the high sky a shoulder samples gets brighter — structure
 * without a wash.
 *
 * THIS IS NOT A SECOND EXPOSURE PATH. It is a bounded remap of one texture
 * fetch, its slope is 1.6, and anything already above the knee (sunlit cumulus
 * at ~1.35, the sun disc at ~19) passes through IDENTICALLY, so the brightest
 * thing the car can reflect is unchanged and bloom sees exactly what it saw
 * before. Re-captured `chase` after this landed; no blowout.
 */
const ENV_SKY_CURVE = { value: new THREE.Vector3(0.45, 1.60, 0.90) };

const APEX_ENV_GROUND = /* glsl */`
uniform vec3 apexEnvGain;
uniform vec4 apexGround;
uniform vec3 apexSkyCurve;

vec3 apexSkyContrast( const in vec3 rad, const in vec3 avg ) {
  vec3 e = max( vec3( 0.0 ), ( rad - avg * apexSkyCurve.x ) * apexSkyCurve.y );
  float k = smoothstep( apexSkyCurve.z, apexSkyCurve.z * 2.5, dot( rad, vec3( 0.2126, 0.7152, 0.0722 ) ) );
  return mix( e, rad, k );
}

vec3 apexGroundProbe( const in vec3 rawSky, const in vec3 skyAvg, const in vec3 dir, const in float rough ) {
  vec3 skyRad = apexSkyContrast( rawSky, skyAvg );
  // A polished coat resolves a LINE; a satin surface resolves a gradient. The
  // square keeps the clearcoat (rough ~0.03) at well under a degree of arc while
  // matte carbon (~0.45) softens across a quarter of the hemisphere.
  float soft = 0.014 + rough * rough * 1.35;

  // 1. Below the horizon: tarmac. Dark, slightly warm, and lit by the same sky
  //    the probe already measured, so it needs no CPU-side upkeep.
  float below = smoothstep( -soft, soft, -dir.y );
  vec3 env = mix( skyRad, skyAvg * apexGround.rgb, below );

  // 2. ACROSS the horizon: the trackside furniture. This band is the reason the
  //    number is not simply "sky above, road below". Armco is ~1 m and the
  //    hoardings ~2 m, so from a car's own eye level they cover the first few
  //    degrees ABOVE the horizon as well as hiding the road immediately behind
  //    them — and they are dark. Without it, every near-grazing reflection on
  //    the car returns bright horizon sky, and since Schlick hands a clearcoat
  //    almost all of the environment at grazing incidence, a nose cone seen
  //    head-on turns into the silver-pink smear this file has fought twice. The
  //    band widens with the lobe so a rough surface averages across it.
  float band = exp2( -pow2( ( dir.y - 0.015 ) / max( 0.075, soft ) ) );
#ifdef APEX_ENV_DEBUG
  // ?envdbg=1 — false-colour what each pixel's reflection actually SEES.
  // RED = tarmac, GREEN = the trackside band, BLUE = open sky. Use it before
  // believing anything about this function: "the nose is too bright" looks
  // identical whether the nose is mirroring the sky, the horizon or the sun.
  return vec3( below, band * 0.72, max( 0.0, 1.0 - below - band * 0.72 ) ) * 0.5;
#endif
  return mix( env, skyAvg * apexGround.a, band * 0.72 );
}
`;

/** `?envdbg=1` paints the reflection classification. See `apexGroundProbe`. */
const ENV_DEBUG = (() => {
  if (typeof location === 'undefined') return 0;
  const v = new URLSearchParams(location.search).get('envdbg');
  return v ? parseInt(v, 10) : 0;
})();

const ENV_PARS = APEX_ENV_GROUND + THREE.ShaderChunk.envmap_physical_pars_fragment
  .replace('return PI * envMapColor.rgb * envMapIntensity;',
    'return PI * envMapColor.rgb * envMapIntensity * apexEnvGain.x;')
  .replace('return envMapColor.rgb * envMapIntensity;',
    'vec3 apexSkyAvg = textureCubeUV( envMap, vec3( 0.0, 1.0, 0.0 ), 1.0 ).rgb * envMapIntensity;\n'
    + '\t\t\tvec3 apexRad = apexGroundProbe( envMapColor.rgb * envMapIntensity, apexSkyAvg, reflectVec, roughness );\n'
    // SPECULAR DESATURATION (apexEnvGain.z), and it is the fix for cobalt carbon.
    // A dark, near-black part under an open sky has NO diffuse colour of its own
    // to compete with its own reflection, so whatever hue the probe carries is
    // the hue of the part: measured on `beauty`, the front wing read
    // 10/19/49 (B-R +39, sat 0.79) and setting this material's specular gain to
    // zero took it to 1/1/13 — the cobalt was ENTIRELY the reflected sky, not
    // the albedo and not the ambient (the diffuse gain measured pixel-neutral).
    // Physically the missing term is that an epoxy resin coat over black
    // filament is a broadband dielectric mirror sitting inside a wing box: it
    // sees the underside of the nose, the tyres and the road far more than it
    // sees zenith. Rather than fake that with an occlusion map that does not
    // exist, roll the CHROMA of the reflection toward its own luminance by a
    // per-material amount. Paint keeps its sky colour (z = 0) because a lacquered
    // flank genuinely does mirror a blue sky; carbon does not.
    + '\t\t\treturn mix( apexRad, vec3( dot( apexRad, vec3( 0.2126, 0.7152, 0.0722 ) ) ), apexEnvGain.z ) * apexEnvGain.y;');

/**
 * THE REFLECTION IS NOT A LIGHTING KNOB, AND THIS IS WHAT KEEPS THEM APART.
 *
 * `scene.environmentIntensity` does double duty in three: it scales the diffuse
 * IBL irradiance (which IS a lighting quantity — it is the sky's share of the
 * illuminance, and `lighting.js` meters it into the exposure) and it scales the
 * specular IBL radiance (which is an IMAGE — how bright the sky looks reflected
 * in a clearcoat). Round 4's shadow rebalance had to raise the first by 2.15x;
 * every one of the eighteen `specular` numbers below was swept and signed off
 * against the OLD value, so riding that multiplier would have silently retuned
 * all eighteen at once — visible immediately as the nose cone at `front` going
 * blue-violet again.
 *
 * So: the specular gains stay in "environmentIntensity = 1" units and are
 * normalised here, once. Keep this the reciprocal of `Lighting`'s
 * `environmentIntensity` default. The diffuse gain deliberately does NOT get
 * normalised — the ambient fill on the car SHOULD track the sky's real share,
 * and it is what lifts the shadow side of `wheel` and `beauty` with everything
 * else in the frame.
 */
const ENV_SPEC_NORM = 1 / 2.15;

/**
 * Retune a patched material's env response in the SAME units `envResponse`
 * takes. `wheels.js` derives five materials by cloning and then rewriting the
 * gain; writing `userData.envGain` by hand bypasses the normalisation above and
 * would leave those five parts reflecting 2.15x harder than every other surface
 * on the car. Use this instead.
 *
 * @param {THREE.Material} mat  a material that has been through `envResponse`
 */
export function setEnvGain(mat, diffuse, specular, desat) {
  const g = mat.userData && mat.userData.envGain;
  if (!g || !g.isVector3) return mat;
  g.set(diffuse, specular * ENV_SPEC_NORM, desat ?? g.z);
  return mat;
}

/**
 * Give `mat` a real, live environment response.
 *
 * @param {THREE.Material} mat
 * @param {number} diffuse   gain on `getIBLIrradiance` (ambient fill)
 * @param {number} specular  gain on `getIBLRadiance` (the reflection itself)
 * @returns {THREE.Material} `mat`, with `mat.userData.envGain` as the live handle
 *
 * NOTE ON CLONES. `Material.copy()` JSON round-trips `userData` and does not
 * copy own-property `onBeforeCompile`, so a clone silently loses the patch and
 * its `envGain` decays to a plain `{x, y}`. Every clone below is therefore run
 * through `envResponse` again.
 */
function envResponse(mat, diffuse, specular, desat = 0) {
  const gain = new THREE.Vector3(diffuse, specular * ENV_SPEC_NORM, desat);
  mat.userData.envGain = gain;
  // The two shared probe uniforms, published so a live sweep can reach them
  // (tools/_r5.mjs). They are the SAME objects every patched material uses, so
  // writing one retunes the horizon on the whole car.
  mat.userData.apexGround = ENV_GROUND.value;
  mat.userData.apexSkyCurve = ENV_SKY_CURVE.value;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.apexEnvGain = { value: gain };
    // ONE shared uniform object for every patched material on all twenty cars,
    // the same trick `lighting.js` uses for the cascade breaks: retuning the
    // horizon is a single write.
    shader.uniforms.apexGround = ENV_GROUND;
    shader.uniforms.apexSkyCurve = ENV_SKY_CURVE;
    shader.fragmentShader = (ENV_DEBUG ? '#define APEX_ENV_DEBUG\n' : '')
      + shader.fragmentShader.replace(
        '#include <envmap_physical_pars_fragment>',
        ENV_PARS,
      );
  };
  mat.customProgramCacheKey = () => 'apexEnvGain';
  // Other modules legitimately clone these (`wheels.js` derives the aero-cover
  // paint from `paintSecondary`, `livery.makeDecalPlane` clones `decal`), and a
  // bare clone would silently drop back to the renderer's 1.0 and stop matching
  // the part it was derived from. Re-patch on the way out, with a FRESH gain
  // vector so the clone can be retuned without dragging the original with it.
  // `specular`, NOT `gain.y` — `gain.y` has already been through ENV_SPEC_NORM
  // and feeding it back in would normalise the clone twice.
  mat.clone = function cloneWithEnv() {
    const c = Object.getPrototypeOf(this).clone.call(this);
    return envResponse(c, gain.x, specular, gain.z);
  };
  return mat;
}

/**
 * Dry-track env response for painted bodywork: [ambient, reflection].
 *
 * Reflection 0.42, not 1.45. The review asked for 1.45 on the theory that a
 * sharp coat reflecting a dim probe reads as an empty grey sheet — but the probe
 * is not dim. The sky renders at ~0.62 linear and a clearcoat at 70-80 deg of
 * incidence hands back half of that, which is more than the diffuse red under
 * it. Swept live (env 0 / 1.0 / 1.45 with the map bound by hand) the nose goes
 * from a rich black-and-red F1 nose, to a pink smear, to white. 0.55 is where
 * the sky sheen sits on top of the colour instead of replacing it, and it is
 * also roughly what a light meter says: F0 = 0.04 gives ~0.13 reflectance at
 * 70 deg, not the ~0.5 an unattenuated Schlick term produces at the shading
 * normals a low-poly nose cone actually presents.
 *
 * SWEPT ON THE LIVE FRAME, not guessed: [0.98, 0.55] / [0.85, 0.55] / [0.72,
 * 0.55] / [0.85, 0.40] / [0.98, 0.40] at `front`, via the gain uniform. The pink
 * wash across the tub shoulders tracks the SPECULAR number and only the specular
 * number — 0.72 ambient still had it, 0.40 reflection did not — so the ambient
 * stays high enough to keep the shadow side of `wheel` off the floor and the
 * reflection takes the cut.
 *
 * ROUND 4 raised this to 0.75 on the claim that the grounded probe had made the
 * old 0.42 under-read, and that 0.75 was "where the sidepod carries a legible
 * sky band and `front` still photographs as a black-and-red F1 nose".
 *
 * ROUND 4 INTEGRATION — BOTH HALVES OF THAT CLAIM ARE FALSE, MEASURED.
 *
 * 1. It buys NOTHING on the sidepod. Sweeping the live gain uniform on `tv`
 *    (0 / 0.30 / 0.45 / 0.75 / 20) and reading a 200x200 px block straight off
 *    the captured flank:
 *
 *        gain      0      0.30    0.75     20
 *        Ymax    187.2   187.2   187.3   187.2
 *        Ymin     16.3    16.3    16.3    16.3
 *        B-R     -76.5   -76.5   -76.5   -76.5
 *
 *    A gain of TWENTY is pixel-identical to a gain of ZERO. That is not a
 *    tuning question, it is Fresnel: a tower camera is broadside to the flank,
 *    so the incidence is ~30 deg, F0 = 0.04 puts the reflection at ~6 % — and
 *    the flank's reflection vector points DOWN, into the 13 % tarmac, so the
 *    whole term lands at ~0.4 % of the diffuse red under it. There is no sky in
 *    that direction to make a band out of. (The band is real and legible on a
 *    GRAZING view — see `front`, `beauty` — which is the same reason the number
 *    below matters at all.)
 *
 * 2. It costs `front` the nose. At 0.75 the identical grazing term that is
 *    invisible broadside runs at ~100 % Fresnel, and the capture comes back with
 *    a blue-violet nose cone and a magenta wash across the whole tub and both
 *    sidepod decks — the "pink smear" this file has now logged three times.
 *    Swept at `front`: 0.30 clean, 0.45 a trace on the shoulders, 0.60 washing,
 *    0.75 fully magenta.
 *
 * So the change was strictly a cost. The flank it was raised to rescue cannot
 * tell the difference; if that band is ever to become legible it needs GEOMETRY
 * (an undercut that lets the lower flank see above the horizon), not a bigger
 * multiplier.
 *
 * 0.30, not the old 0.42, because the shadow rebalance in `lighting.js` also
 * raised the car's IBL AMBIENT 2.15x (the diffuse gain is deliberately not
 * normalised — see ENV_SPEC_NORM), and that ambient is sky-coloured. Re-swept
 * at `front` against the new lighting: 0.42 still carries a violet cast on the
 * nose and a magenta trace on the tub shoulders, 0.30 is clean and still shows
 * the coat's highlight running down the tub crown, 0.20 goes flat.
 *
 * EVERYTHING FROM 'ROUND 4 INTEGRATION' TO HERE IS WRONG, and it is kept only
 * so the same mistake is not made a fourth time. Both sweeps it rests on were
 * taken through a uniform that `capture()` overwrites — see below.
 *
 * ---------------------------------------------------------------------------
 * ROUND 5 — THE NUMBER IN THIS FILE WAS NEVER THE NUMBER ON SCREEN.
 * ---------------------------------------------------------------------------
 *
 * Two measurement bugs have been feeding each other for three rounds.
 *
 * 1. `setWetness()` wrote `paint.userData.envGain.set(PAINT_ENV[0], 0.30)` —
 *    RAW, bypassing `ENV_SPEC_NORM`, where the constructor writes
 *    `0.30 * (1/2.15)`. `capture()` runs the weather state on every staged shot
 *    and `weather.setState` calls `setWetness`, so EVERY capture ever measured
 *    ran at gain 0.30, i.e. 2.15x what this constant claims and 0.645 in
 *    physical (environmentIntensity = 1) units. Both paths now go through
 *    `setEnvGain`, so the constant below is what ships.
 *
 * 2. Round 4's sweep ("a gain of TWENTY is pixel-identical to a gain of ZERO")
 *    poked `userData.envGain` and then called `capture()` — which runs
 *    `setWetness` and overwrites it. Five variants, one frame. Re-run with the
 *    override applied AFTER staging (tools/_r5.mjs), on `beauty`, patch
 *    (900,520,140x40) on the sunlit tub shoulder:
 *
 *        physical gain   0.00      0.645(ship)   6.45
 *        rgb             64/36/32  70/43/46      83/69/76
 *        saturation      0.497     0.387         0.174
 *
 *    It is not inert. It is a live, monotone lever, and 0.30 was simply low.
 */
const PAINT_ENV = [0.94, 0.80, 0.75];
//                  ^ambient  ^reflection  ^specular desaturation
//
// The DESATURATION is what lets the reflection go up 2.7x without the nose cone
// going violet. A metallic basecoat's Fresnel runs to 1.0 at grazing incidence,
// where it stops tinting and hands back the raw sky — and a head-on nose is
// almost entirely grazing, which is the "pink smear" this file has logged four
// times. Rolling the reflected CHROMA (not its energy) toward luminance leaves
// the band on the flank exactly as bright while taking the blue out of the
// grazing lobe. Measured at `front`, nose patch (770,425,80x55), B-R:
//
//     r4 shipped                                          -102.3
//     metalness 0.54, reflection 0.95, desat 0.00           -64.8   (violet)
//     metalness 0.44, reflection 0.80, desat 0.65           -98.0
//     metalness 0.44, reflection 0.80, desat 0.90          -108.4

/** Gloss carbon: [ambient, reflection, specular desaturation]. */
const CARBON_ENV = [1.30, 1.10, 0.55];
/**
 * Matte carbon — see the cobalt note on `apexEnvGain.z`.
 *
 * ROUND 6. Round 5 killed the cobalt by taking the weave albedo up an order of
 * magnitude (0.0023..0.0055 linear -> 0.0205..0.0395) and leaning on DIFFUSE for
 * the read. That works at noon and fails at golden hour: a diffuse-dominated
 * surface wears the light's own colour, so `beauty` measured the sunlit endplate
 * at 78.9/61.5/40.8, sat 0.483, luma 63.7 — cardboard. No layup is a luma-64
 * warm tan under any sun.
 *
 * The correction is a rebalance, NOT a return to r4: keep the physical albedo in
 * the shared weave (gloss `carbon`, the rear plane and the mirror pods, still
 * wants it), pull matte carbon's own reflectance down with `carbonMatte.color`,
 * and buy the luminance back on the SPECULAR side where the desaturation lever
 * lives — so the part gets brighter without getting more coloured. Measured on
 * `beauty`, endplate patch (760,610,60,60), with the sunlit-tarmac reference in
 * the same frame at 77.5/64.0/51.9 sat 0.334 as the scene's neutral floor:
 *
 *     r5 shipped                              78.9/61.5/40.8  sat 0.483  Y 63.7
 *     colour 0.55, reflection 1.50, cc 0.72   57.4/44.3/30.5  sat 0.470  Y 46.3
 *     colour 0.40, reflection 1.90, cc 0.80   49.4/38.7/27.9  sat 0.434  Y 40.2
 *     + cool albedo trim (this)               46.9/38.0/29.1  sat 0.378  Y 39.1
 *
 * i.e. luma 63.7 -> 39.1 and the chroma down to within 0.04 of a neutral surface
 * standing in the same light. Below that the sun's own saturation is the floor
 * and the only way past it is to make the carbon actively blue again.
 *
 * WHERE THE FRONT WING'S ELEMENT SEPARATION ACTUALLY COMES FROM. Swept as four
 * live overrides on `front` against a reconstructed r5 in the same page
 * (tools/_r5.mjs), reading `compare.mjs` edge energy on the two front-wing
 * cells, plus the sky-facing floor plate on `beauty` (480,560,90,25):
 *
 *                                          r3c2    r3c3   floor plate Y
 *     r5                                      0       0        118.6
 *     colour trim only                     -5.0 %  -5.9 %        —
 *     + reflection 1.90                    +0.4 %  +2.6 %      149.6
 *     + coat roughness 0.20 -> 0.09        +7.0 %  +9.9 %      175.6
 *     + coat 0.55 -> 0.80  (ships)        +13.8 % +14.1 %      192.8
 *
 * Two things fall out. The darker albedo Fix 2 needs COSTS about six points of
 * element separation on its own, so most of the reflection increase is paying
 * that back rather than adding gloss. And separation and the floor plate are the
 * same term: the blades read against each other because adjacent panels face
 * different parts of the probe, and a flat sky-facing panel is that same probe
 * at full strength. There is no split available from this file — `carbon
 * Matte` is one bucket and the floor, the endplates and the blades are all in
 * it. The plate is a KNOWN, PRE-EXISTING defect (logged in rounds 2 and 3, at
 * 118.6 before this change) and this round makes it worse in exchange for the
 * element separation the review asked for. The real fix is local occlusion: a
 * floor panel lives inside a wing box and sees the underside of the nose, not
 * the zenith, and nothing in `Lighting.envScene` knows that.
 */
const CARBON_MATTE_ENV = [1.05, 1.90, 0.90];
/** Wet endpoints for the same three, so the ramp in `setWetness` stays monotone. */
const CARBON_MATTE_WET = [2.10, 0.50];

/**
 * @param {object} team          entry from car/livery.js TEAMS
 * @param {THREE.Texture} liveryMap  body albedo in body-UV space
 */
export function createCarMaterials(team, liveryMap) {
  const weave = carbonWeaveMaps();
  const body = bodySurfaceMaps();
  const flake = flakeNormalMap();               // body UV, ~60 mm tile
  const flakeMetric = flakeTiled('metric', 8, 8);  // metric UV, ~50 mm tile

  // --- carbon fibre --------------------------------------------------------
  // Two tilings: the wing bucket is unwrapped chordwise/spanwise, the floor and
  // aero furniture are unwrapped in world metres. Both land on ~5 mm tows.
  const carbonTiling = (key, rx, ry) => assets.get(`mat:weaveTiled:${key}`, () => {
    const t = {
      map: weave.map.clone(), normalMap: weave.normalMap.clone(),
      ormMap: weave.ormMap.clone(), anisotropyMap: weave.anisotropyMap.clone(),
    };
    for (const tex of Object.values(t)) { tex.repeat.set(rx, ry); tex.needsUpdate = true; }
    return t;
  });

  const wingWeave = carbonTiling('wing', 4, 8);
  const floorWeave = carbonTiling('floor', 3.4, 3.4);

  const makeCarbon = (maps, gloss) => new THREE.MeshPhysicalMaterial({
    map: maps.map,
    normalMap: maps.normalMap,
    normalScale: new THREE.Vector2(1.15, 1.15),
    aoMap: maps.ormMap,
    roughnessMap: maps.ormMap,
    metalnessMap: maps.ormMap,
    roughness: 1,
    metalness: 1,
    color: 0xffffff,
    // Raised from 0.85/0.55: the albedo is now near-uniform, so the anisotropic
    // streak along the tows is what has to carry the weave. Matte stops at 0.65
    // rather than the reviewed 0.75 — see the roughness note in carbonWeaveMaps.
    anisotropy: gloss ? 0.95 : 0.82,
    anisotropyMap: maps.anisotropyMap,
    // Matte carbon's coat goes 0.35 -> 0.55 at 0.32 -> 0.20 roughness. This is
    // the "lost trailing-edge highlight": an aero element's edge is a 2 mm
    // radius seen at 80-plus degrees of incidence, where a coat's Schlick term
    // is near unity — so the crisp bright line r2 had along every element edge
    // is a CLEARCOAT product, and thinning the coat to 0.35 is what erased it.
    // Bumping the base lobe instead would have lit the whole panel.
    // ROUND 6 takes the matte coat further the same way, 0.55 -> 0.80 at 0.20 ->
    // 0.12, because that trailing-edge Schlick line is now doing double duty: it
    // is also what separates the four front-wing blades from each other once the
    // diffuse term is no longer bright enough to do it. `compare.mjs` on `front`
    // scored r5 at edge -37.3 % in r3c3 against r4 — "one black mass with the
    // element separation gone to mush" — and a crisper, brighter coat lobe is the
    // only lever that puts contrast BETWEEN two adjacent dark panels rather than
    // lifting both of them together.
    clearcoat: gloss ? 1.0 : 0.80,
    clearcoatRoughness: gloss ? 0.055 : 0.12,
    clearcoatNormalMap: flakeMetric,
    clearcoatNormalScale: new THREE.Vector2(0.10, 0.10),
    specularIntensity: 1.0,
  });

  // Gloss carbon keeps a strong reflection because the parts left in this bucket
  // are edge-on to the sky (rear plane, beam wing, DRS flap, mirror pods). Matte
  // carbon goes BELOW unity: with the env gain silently pinned at 1.0 the front
  // wing, endplates and footplates were rendering at a mid-grey luminance of 82
  // with a saturation of 0.06 — flat plastic slabs. Autoclaved carbon under a
  // satin coat is darker than that and gets its read from the anisotropic streak,
  // not from ambient.
  const carbon = envResponse(makeCarbon(wingWeave, true), CARBON_ENV[0], CARBON_ENV[1], CARBON_ENV[2]);
  const carbonMatte = envResponse(makeCarbon(floorWeave, false),
    CARBON_MATTE_ENV[0], CARBON_MATTE_ENV[1], CARBON_MATTE_ENV[2]);
  // The light-grey block dead-centre in `front`, logged in round 2 and round 3
  // and blamed both times on a missing texture. It is the FLOOR — raycast at
  // (770, 522) hits car-local (0.16, 0.03, -0.25) with normal (0, 1, 0), i.e.
  // the plank, seen through the gap under the nose — and it is textured. It was
  // a pale mirror pointed straight up at a probe whose lower hemisphere WAS the
  // sky, at `envGain.y` 0.80. Setting that gain to 0 alone made the block vanish
  // on the live frame, which is what identified it.
  //
  // Grounding the probe does most of the work; the rest is here. Both numbers
  // were swept together on `beauty` (front-wing legibility) and `front` (the
  // block), because a horizontal carbon panel is the same shading problem in
  // both: albedo 0.42/0.63/0.79 linear moved the wing barely at all — this
  // bucket is almost entirely specular-lit at golden hour — while the reflection
  // gain moved both hard. 0.85 is where the wing elements get their form and
  // their trailing-edge line back and the block still measures 44 against the
  // 120 that was logged.
  // WHITE, because the weave now carries a real reflectance of its own.
  //
  // 0xcfcdcb was a fudge factor standing in for a texture that was ten times too
  // dark (see the albedo note in `carbonWeaveMaps`). Measured on `beauty`, patch
  // (800,600,200x60) — the largest carbon area on the car:
  //
  //     r4 shipped                  10.1/18.5/48.9   B-R +38.7  sat 0.79  Y 18.9
  //     linear albedo + desat,      8.2/ 7.7/17.5    B-R  +9.3  sat 0.56  Y  8.5
  //       colour still 0xcfcdcb
  //     ... with colour 0xffffff   19.5/17.0/24.9    B-R  +5.4  sat 0.32  Y 18.1
  //
  // i.e. the cobalt is gone (B-R +38.7 -> +5.4, saturation 0.79 -> 0.32) at the
  // SAME luminance the frame had before, which is the half of this the review
  // was explicit about and the half a darker albedo would have failed.
  //
  // ROUND 6: white was right for the gloss bucket and wrong for this one. See
  // the measured table on CARBON_MATTE_ENV — at 1.0 the matte parts are diffuse
  // dominated and therefore wear the golden-hour sun's own hue. This is a
  // reflectance trim, in LINEAR working space (setRGB, not a hex, so it is not
  // silently sRGB-decoded a second time): ~0.38 of the shared weave albedo,
  // which lands the bucket at 0.008..0.015 linear — the value a cured pre-preg
  // panel under a satin coat actually measures — with a 3 % cool spread across
  // the channels for the resin. Three per cent, not r4's nineteen: the cast has
  // to survive as "graphite, slightly cool in shade" and never restack with a
  // sky reflection into navy. It cannot, because the specular is now 0.90
  // desaturated.
  carbonMatte.color = new THREE.Color().setRGB(0.365, 0.385, 0.425, THREE.LinearSRGBColorSpace);

  // --- painted bodywork ----------------------------------------------------
  //
  // The livery map supplies all colour, so the base stays white.
  //
  // F1 PAINT IS A LABORATORY MIRROR. It is wet-sanded and machine-polished
  // between sessions and it reflects the barriers. `livery.js` now floors the
  // per-texel clearcoat roughness at 0.030 instead of 0.085 and lets swirl marks,
  // hand smears and dust own the falloff, so this side of the seam has to hold up
  // its half of the deal:
  //
  //   envGain [0.94, 0.42]  see PAINT_ENV. The ambient stays at unity so the
  //                         shadow side keeps its fill; the REFLECTION is halved,
  //                         because at unity the coat's grazing Schlick term was
  //                         out-radiating the pigment under it and the livery
  //                         simply vanished off the nose and the shoulders.
  //   clearcoatNormalScale 0.34  was 0.16, and with metalness only 0.17 that put
  //                         the flake below the visible threshold at 1600x900.
  //                         0.34 against the rebuilt `flakeNormalMap` (sparse
  //                         0.4 mm platelets) is what makes metallic red sparkle
  //                         when the sun tracks across it.
  //   normalScale 0.65      UNCHANGED, deliberately. The review also suggested
  //                         cutting this 4x to kill the orange peel, but that
  //                         normal map carries the panel lines, gills, shutlines
  //                         and fasteners at strength 3.4 — the good part — and
  //                         4x would erase them along with the fault. The fault
  //                         was the waviness TERM inside `paintRelief`, and it is
  //                         fixed there at source.
  //
  // KNOWN GAP, NOT MINE TO CLOSE: `render/lighting.js` builds the PMREM from
  // `sky.envMesh` alone, so the probe contains a sky gradient, clouds and the sun
  // and nothing else. A mirror coat therefore has a real horizon line and a real
  // sun to show, but no barrier verticals and no advertising colour. Adding the
  // trackside band and ground plane to `Lighting.envScene` is a one-line change
  // in a file I do not own; it would make this paint noticeably better.
  const paint = envResponse(new THREE.MeshPhysicalMaterial({
    map: liveryMap ?? null,
    color: liveryMap ? 0xffffff : new THREE.Color(team.primary),
    normalMap: body.normalMap,
    normalScale: new THREE.Vector2(0.65, 0.65),
    aoMap: body.ormMap,
    roughnessMap: body.ormMap,
    metalnessMap: body.ormMap,
    roughness: 1,
    // THE FLANK IS A CURVED MIRROR, AND FRESNEL ALONE CANNOT MAKE IT ONE.
    //
    // The blind-test note is that a broadcast side-on shot reads a bright sky
    // band across the upper flank, a transition at the horizon and a dark
    // reflected-track band below it. Three rounds tried to buy that with the
    // clearcoat's env gain and it cannot be bought there: a tower camera is
    // ~30 deg off broadside, and a DIELECTRIC coat at 30 deg hands back F0 =
    // 0.04, about 5 %. Swept live on `tv` (tools/_r5.mjs, override applied
    // after staging), the whole probe retune — tarmac 0.130 -> 0.070, trackside
    // band 0.40 -> 0.26, sky curve gain 1.6 -> 2.1, reflection 0.95 -> 1.6 —
    // moved the flank patch by ONE code value. There is nothing wrong with the
    // probe; there is 5 % of it arriving.
    //
    // What is actually missing is that F1 livery is a METALLIC BASECOAT. An
    // aluminium-flake base has F0 = its own albedo, not 0.04, so it reflects the
    // environment at every angle and reflects it TINTED — which is why a real
    // red sidepod shows a dark red-black track band and a hot red-white sky
    // band instead of washing to grey. 0.175 (the old 0.25 * 0.70) is a solid
    // non-metallic lacquer. Swept at `tv`: 0.35 / 0.55 / 0.75 — the band appears
    // between 0.35 and 0.55, and by 0.75 the coat's micro-relief starts
    // silhouetting as a quilt on the engine cover. Flank patch saturation goes
    // 0.458 -> 0.487 across the change, i.e. the livery gets MORE saturated, not
    // washed, which is the difference between this lever and a bigger gain.
    metalness: clamp(0.24 + (team.metallic ?? 0.25) * 0.80, 0, 0.78),
    clearcoat: 1,
    clearcoatMap: body.clearcoatMap,
    clearcoatRoughness: 1,
    clearcoatRoughnessMap: body.clearcoatMap,
    clearcoatNormalMap: flake,
    clearcoatNormalScale: new THREE.Vector2(0.34, 0.34),
    specularIntensity: 1.0,
    sheen: 0.0,
  }), PAINT_ENV[0], PAINT_ENV[1], PAINT_ENV[2]);

  const paintSecondary = envResponse(paint.clone(), PAINT_ENV[0], PAINT_ENV[1], PAINT_ENV[2]);
  paintSecondary.map = null;
  paintSecondary.normalMap = null;
  paintSecondary.color = new THREE.Color(team.secondary);
  paintSecondary.clearcoatMap = null;
  paintSecondary.clearcoatRoughnessMap = null;
  paintSecondary.clearcoatRoughness = 0.035;
  paintSecondary.roughnessMap = null;
  paintSecondary.aoMap = null;
  paintSecondary.metalnessMap = null;
  paintSecondary.roughness = 0.34;

  // Anodised accent — a coloured oxide over aluminium: metallic, slightly
  // rough, and it keeps its hue in reflection.
  const accent = envResponse(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(team.accent),
    roughness: 0.24, metalness: 0.85,
    clearcoat: 0.6, clearcoatRoughness: 0.10,
  }), 1.0, 1.35);

  // --- metals --------------------------------------------------------------
  const alu = metalMaps('alu', { roughBase: 0.26, anisotropy: 1.0 }, [3, 3]);
  const tita = metalMaps('titanium', { roughBase: 0.34, anisotropy: 1.4 }, [5, 1.4]);
  const brushDir = brushDirectionMap();

  // Bare metal is a pure specular surface — for a metal the diffuse gain does
  // nothing, and the reflection gain is the whole material. These are the
  // numbers this file always intended; until `envResponse` they were all 1.0.
  const metal = envResponse(new THREE.MeshPhysicalMaterial({
    ...mapsToMaterial(alu),
    color: 0xc4c8ce,
    roughness: 0.95, metalness: 1,
    anisotropy: 0.45, anisotropyMap: brushDir,
  }), 1.0, 1.50);

  const darkMetal = envResponse(metal.clone(), 1.0, 1.15);
  darkMetal.color = new THREE.Color(0x3d4046);
  darkMetal.roughness = 1.05;

  const titanium = envResponse(new THREE.MeshPhysicalMaterial({
    ...mapsToMaterial(tita),
    color: 0x9a9188,
    roughness: 0.9, metalness: 1,
    anisotropy: 0.8, anisotropyMap: brushDir,
  }), 1.0, 1.55);

  // Inconel tailpipe. The blue/straw heat tint is a real thin film, so let the
  // iridescence layer produce it — it then shifts correctly with view angle.
  const exhaust = envResponse(new THREE.MeshPhysicalMaterial({
    color: 0x4a443f,
    roughness: 0.36, metalness: 1,
    iridescence: 0.85, iridescenceIOR: 1.9,
    iridescenceThicknessRange: [180, 720],
  }), 1.0, 1.35);

  // --- rubber, glass, trim -------------------------------------------------
  const rubberMaps = assets.get('mat:tyreMaps', () => {
    const m = cloneMaps(rubber({ scuff: 0.35 }));
    setRepeat(m, 6, 2);
    return m;
  });

  // NOTE: `car/wheels.js` bakes and owns the tyre the game actually renders
  // (its own profile maps, per-corner materials, squash/heat uniforms). This one
  // is kept for the bundle's contract and for anything that wants plain rubber.
  const tyre = envResponse(new THREE.MeshPhysicalMaterial({
    ...mapsToMaterial(rubberMaps),
    color: 0x17171a,
    roughness: 1, metalness: 0,
    sheen: 0.35,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0x30323a),
  }), 0.60, 0.45);

  // Visor / camera lens. Iridescence gives the anti-reflective coating its
  // characteristic magenta-to-green shift.
  const glass = envResponse(new THREE.MeshPhysicalMaterial({
    color: 0x141c26,
    roughness: 0.05,
    metalness: 0.0,
    transparent: true,
    opacity: 0.55,
    iridescence: 0.55,
    iridescenceIOR: 1.35,
    iridescenceThicknessRange: [120, 460],
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    depthWrite: false,
    side: THREE.DoubleSide,
  }), 1.0, 2.20);

  // Nomex / suede cockpit lining — properly matte, no env response.
  const cockpitTrim = envResponse(new THREE.MeshPhysicalMaterial({
    color: 0x101116, roughness: 0.94, metalness: 0.0,
    sheen: 0.5, sheenRoughness: 0.85, sheenColor: new THREE.Color(0x2a2c34),
  }), 0.55, 0.30);

  const brakeDisc = envResponse(new THREE.MeshPhysicalMaterial({
    ...mapsToMaterial(metalMaps('brake', { roughBase: 0.62, anisotropy: 0.4 }, [8, 8])),
    color: 0x2e2a26,
    roughness: 0.85, metalness: 0.25,
    emissive: new THREE.Color(0xff3300), emissiveIntensity: 0.0,
  }), 0.70, 0.70);

  const brakeDuct = envResponse(new THREE.MeshPhysicalMaterial({
    map: floorWeave.map,
    normalMap: floorWeave.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    aoMap: floorWeave.ormMap,
    roughnessMap: floorWeave.ormMap,
    roughness: 1, metalness: 0.08,
    // A brake duct is a CARBON fairing. `0xbfbdbb` is a 0.75-albedo dielectric —
    // white plastic — and it multiplied a carbon weave that is already pale in
    // its own right, so the ducts read as cream-coloured tubes poking out of
    // every wheel and were the last thing on the car that looked like a toy.
    // Keep a touch of grey so the weave and the AO still read.
    color: 0x2e2f31,
    clearcoat: 0.3, clearcoatRoughness: 0.4,
  }), 0.85, 0.80);

  const caliper = envResponse(new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(team.accent),
    roughness: 0.30, metalness: 0.9,
    clearcoat: 0.4, clearcoatRoughness: 0.2,
  }), 1.0, 1.25);

  const rainLight = envResponse(new THREE.MeshStandardMaterial({
    color: 0x1a0303, emissive: new THREE.Color(0xff1100), emissiveIntensity: 0.0,
    roughness: 0.22, metalness: 0,
  }), 1.0, 1.10);

  // The sleeve's albedo is CLAMPED, and that is what stops it reading as a
  // butter-yellow pool noodle. A livery accent like #ffd400 is linear
  // (1.00, 0.66, 0.00): the red channel is at unity, i.e. a perfect reflector,
  // which no paint is. Head-on in the `front` capture the whole sleeve therefore
  // sat on the clip point with no terminator anywhere across it — a flat slab of
  // colour is what "no shading gradient at all" looks like. Real automotive
  // yellow tops out around 0.78 reflectance and carries a few per cent of
  // broadband binder, so the darker channels never sit at absolute zero either.
  // With both, the sun can actually draw a gradient down the tube.
  const tipCoat = new THREE.Color(team.accent);
  const tipMax = Math.max(tipCoat.r, tipCoat.g, tipCoat.b, 1e-4);
  tipCoat.multiplyScalar(0.78 / tipMax).addScalar(0.030);

  const haloTip = envResponse(new THREE.MeshPhysicalMaterial({
    color: tipCoat,
    // The halo sleeve is PAINTED CARBON under a clearcoat, and from the cockpit
    // camera it fills the bottom third of the frame. At roughness 0.24 plus a
    // full clearcoat the base lobe was as sharp as the coat, so the hoop picked
    // up one broad specular band down its length and read as a glossy rubber
    // hose. Let the clearcoat own the sharp highlight; the paint under it is
    // matte, which is what makes it read as a painted structural part.
    roughness: 0.46, metalness: 0.22,
    clearcoat: 1, clearcoatRoughness: 0.06,
    clearcoatNormalMap: flakeMetric,
    clearcoatNormalScale: new THREE.Vector2(0.12, 0.12),
  }), 0.88, 0.85);

  const decal = envResponse(new THREE.MeshStandardMaterial({
    color: 0xffffff, transparent: true, roughness: 0.28, metalness: 0.0,
    depthWrite: false, alphaTest: 0.02,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  }), 1.0, 1.05);

  const baseRough = { paint: 1, carbonCC: 0.055, tyre: 1 };

  return {
    carbon, carbonMatte, paint, paintSecondary, accent,
    metal, darkMetal, titanium, exhaust,
    tyre, glass, cockpitTrim,
    brakeDisc, brakeDuct, caliper, rainLight, haloTip, decal,

    /** Materials created lazily by `decorate()`; disposed with the bundle. */
    extra: [],

    /**
     * Per-car geometry that cannot live in the merged, shared chassis buckets:
     * rear-wing number panels and the coloured halo tip.
     * @param {{team:object, driver:object, seat:number}} entry
     * @returns {THREE.Group} car-local
     */
    decorate(entry) { return buildTeamDecals(entry, this); },

    /** Drives brake-disc incandescence. `t` is 0..1 of max temperature. */
    setBrakeHeat(t) {
      const k = Math.pow(Math.max(0, t), 2.2);
      brakeDisc.emissiveIntensity = k * 7.0;
      brakeDisc.emissive.setRGB(1.0, 0.10 + t * 0.34, 0.01 + t * 0.07, THREE.LinearSRGBColorSpace);
      // Hot discs also scale back: the surface oxidises to a matte grey.
      brakeDisc.roughness = lerp(0.85, 0.62, k);
    },

    setRainLight(on) { rainLight.emissiveIntensity = on ? 5.0 : 0.0; },

    /**
     * Wet-track look. Water fills the micro-roughness, so everything flattens
     * toward a mirror and the environment reflection strengthens.
     *
     * The reflection ramps go through `userData.envGain.y`, NOT through
     * `envMapIntensity` — see `envResponse`. Written to `envMapIntensity` (as
     * they were) they were discarded by the renderer every frame and a wet car
     * looked exactly like a dry one.
     */
    setWetness(w) {
      const x = clamp(w, 0, 1);
      paint.clearcoatRoughness = lerp(1, 0.30, x);
      paint.roughness = lerp(baseRough.paint, 0.42, x);
      setEnvGain(paint, PAINT_ENV[0], lerp(PAINT_ENV[1], 1.60, x), lerp(PAINT_ENV[2], 0.10, x));
      paintSecondary.userData.envGain.copy(paint.userData.envGain);
      carbon.clearcoatRoughness = lerp(baseRough.carbonCC, 0.02, x);
      // Wet carbon reflects a REAL image, so the desaturation that stops a dry
      // resin coat going cobalt is ramped out as the water film takes over.
      setEnvGain(carbon, CARBON_ENV[0], lerp(CARBON_ENV[1], 1.85, x), lerp(CARBON_ENV[2], 0.15, x));
      carbonMatte.clearcoat = lerp(0.80, 0.95, x);
      carbonMatte.clearcoatRoughness = lerp(0.12, 0.06, x);
      // The wet endpoints move with the dry ones. The old pair (1.45, 0.15) was
      // written against a dry reflection of 1.05; leaving it under a dry 1.90
      // would have made a wet car reflect LESS than a dry one, and dropping the
      // desaturation to 0.15 on top of the stronger gain is exactly the stack
      // that produced cobalt carbon in the first place.
      setEnvGain(carbonMatte, CARBON_MATTE_ENV[0], lerp(CARBON_MATTE_ENV[1], CARBON_MATTE_WET[0], x),
        lerp(CARBON_MATTE_ENV[2], CARBON_MATTE_WET[1], x));
      tyre.roughness = lerp(baseRough.tyre, 0.42, x);
      setEnvGain(tyre, 0.60, lerp(0.45, 1.60, x));
      setEnvGain(metal, 1.0, lerp(1.50, 1.90, x));
    },

    /** Grazing-angle rain-light halo used by weather.js. */
    setRainLightColour(hex) { rainLight.emissive.set(hex); },

    dispose() {
      for (const m of Object.values(this)) if (m && m.isMaterial) m.dispose();
      for (const m of this.extra) m.dispose();
      this.extra.length = 0;
    },
  };
}

// Kept for callers that want the raw weave (wheels, brake ducts, future parts).
export { carbonWeaveMaps, flakeNormalMap };

void smoothstep;
