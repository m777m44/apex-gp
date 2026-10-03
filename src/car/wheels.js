/**
 * APEX GP — tyres, rims, brakes and the double-wishbone suspension linkage.
 *
 * Each corner is a small kinematic chain, all expressed in CAR-LOCAL space:
 *
 *   travelPivot (Group)   vertical travel, y = TYRE_RADIUS - squash + travel
 *     steerPivot (Group)  rotation.y = steer angle (front axle only)
 *       spinGroup (Group) rotation.x = wheel angle
 *         tyre, compound band, marbles, rim barrel, aero cover, nut, disc
 *       upright, caliper, brake drum + vanes   (steer, do not spin)
 *
 * The wishbones, track rod and pushrod are unit-length aerofoil sections
 * re-oriented every frame between a chassis-side pickup and an upright-side
 * pickup, so the linkage genuinely follows the wheel.
 *
 * TYRE SPEC (2022-onward 18" Pirelli proportions)
 *   front 305/720-R18 -> section 0.305 m, outer diameter 0.720 m
 *   rear  405/720-R18 -> section 0.405 m, outer diameter 0.720 m
 * The tyre is lathed from a shared cross-section profile; `v` runs 0 at the
 * inner bead, 0.5 at the crown, 1 at the OUTER bead (the mesh is mirrored per
 * side, so v = 1 always faces outboard and the moulded lettering reads the
 * right way round on both sides of the car).
 *
 * Under load the tyre is flattened against the road and the sidewall bulges,
 * both in the vertex shader, un-rotated by the current wheel angle so the flat
 * spot stays at the bottom while the tyre spins.
 *
 * PUBLIC API
 *   buildWheelSet(materials, opts) -> WheelSet
 *   WheelSet.setSteer(rad)                  front wheels, +ve = turn right
 *   WheelSet.setSpin([fl,fr,rl,rr])         absolute wheel angle, radians
 *   WheelSet.setSuspension([fl,fr,rl,rr])   travel in metres, +ve = compressed
 *   WheelSet.setCompound('soft'|'medium'|'hard'|'inter'|'wet')
 *   WheelSet.setBrakeGlow(t | [fl,fr,rl,rr])   0..1 of peak disc temperature
 *   WheelSet.setTyreTemp([degC x4])         drives the hot-rubber sheen
 *   WheelSet.setRubberPickup(0..1)          marbles / pickup on the shoulders
 *   WheelSet.setWheelBlur(0..1)             manual override; otherwise automatic
 *   WheelSet.wheels[i]                      { travelPivot, steerPivot, spinGroup, ... }
 *
 * Wheel order is ALWAYS [frontLeft, frontRight, rearLeft, rearRight].
 */

import * as THREE from 'three';
import { assets, mergeGeometries, loft } from '../core/assets.js';
import { clamp, lerp, smoothstep, makeRng, hashSeed } from '../core/rng.js';
import { COMPOUND_COLOURS } from '../textures/procedural.js';
import { setEnvGain } from './materials.js';

export const TYRE_RADIUS = 0.360;          // 720 mm outer diameter
export const TYRE_HALF_WIDTH_FRONT = 0.1525;  // 305 section
export const TYRE_HALF_WIDTH_REAR = 0.2025;   // 405 section
export const RIM_RADIUS = 0.2286;          // 18 inch
/** Static contact-patch flattening at rest, metres. */
export const TYRE_SQUASH_STATIC = 0.0065;
export const COMPOUNDS = ['soft', 'medium', 'hard', 'inter', 'wet'];

const WET_COMPOUNDS = new Set(['inter', 'wet']);

/** Residual disc temperature a carbon brake never drops below in a session. */
const DISC_SOAK = 0.40;

/**
 * `?brakes=0..1` pins a minimum disc temperature. Staged captures reset the
 * cars, so their brakes are stone cold — this is how the heat ramp gets
 * inspected without faking it in the sim.
 */
const BRAKE_FLOOR = (() => {
  if (typeof location === 'undefined') return 0;
  const v = parseFloat(new URLSearchParams(location.search).get('brakes'));
  return Number.isFinite(v) ? clamp(v, 0, 1) : 0;
})();

/**
 * Pirelli marking colours are printed on black rubber, not lit paint — pull
 * them down so the band reads as a moulded stripe instead of a neon ring.
 */
function bandColour(compound) {
  return new THREE.Color(COMPOUND_COLOURS[compound] ?? '#e10600').multiplyScalar(0.52);
}

// ---------------------------------------------------------------------------
// Cross-section profile
// ---------------------------------------------------------------------------

/**
 * Half the tyre cross-section, inner bead -> crown centre, as
 * `[radius, axialFractionOfSectionHalfWidth]`. Points are spaced roughly
 * evenly along the arc so the default LatheGeometry `v` (which is uniform in
 * INDEX, not arc length) is close to uniform in millimetres — that is what
 * lets one texture layout serve both the narrow front and the wide rear.
 */
const HALF_PROFILE = [
  [0.2286, -0.930],   // 0  bead seat on the rim flange
  [0.2360, -0.968],   // 1  sidewall flare
  [0.2500, -0.995],   // 2
  [0.2680, -1.000],   // 3  maximum section width
  [0.2880, -0.994],   // 4
  [0.3060, -0.978],   // 5
  [0.3220, -0.950],   // 6
  [0.3360, -0.916],   // 7  shoulder
  [0.3470, -0.878],   // 8
  [0.3545, -0.830],   // 9
  [0.3585, -0.762],   // 10 tread edge
  [0.3603, -0.640],   // 11
  [0.3611, -0.430],   // 12
  [0.3614, -0.180],   // 13
  [0.3615, 0.000],    // 14 crown centre
];

/** Full profile, inner bead (v=0) -> outer bead (v=1). */
function fullProfile() {
  const out = HALF_PROFILE.map(([r, a]) => [r, a]);
  for (let i = HALF_PROFILE.length - 2; i >= 0; i--) {
    out.push([HALF_PROFILE[i][0], -HALF_PROFILE[i][1]]);
  }
  return out;
}
const PROFILE = fullProfile();
const PROFILE_N = PROFILE.length;                 // 29
const V_OF = (i) => i / (PROFILE_N - 1);

// Landmarks in texture v, used by both the texture bake and the band ring.
const V_TREAD_IN = V_OF(10);        // 0.357 inner tread edge
const V_TREAD_OUT = V_OF(18);       // 0.643 outer tread edge
const V_BAND_A = 0.820;             // compound colour band, outer sidewall
const V_BAND_B = 0.851;
const V_BRAND = 0.782;              // moulded brand wordmark, outboard of the band

/** Linearly interpolate the profile at a texture v. -> [r, aFrac] */
function profileAtV(v) {
  const f = clamp(v, 0, 1) * (PROFILE_N - 1);
  const i = Math.min(PROFILE_N - 2, Math.floor(f));
  const t = f - i;
  return [lerp(PROFILE[i][0], PROFILE[i + 1][0], t), lerp(PROFILE[i][1], PROFILE[i + 1][1], t)];
}

// ---------------------------------------------------------------------------
// Tyre textures — baked here rather than in textures/procedural.js because the
// layout is tied to this module's lathe profile.
// ---------------------------------------------------------------------------

function canvas2d(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, x: c.getContext('2d', { willReadFrequently: true }) };
}

/**
 * The team's base coat, recovered from the livery canvas.
 *
 * `materials.js` does not publish the team colours: `paint` carries the livery
 * texture and a white base, and the only named colours on the bundle are the
 * accent (`caliper`) and the dark secondary (`paintSecondary`). The aero cover
 * has to be the PRIMARY, so take the modal colour of the livery canvas — every
 * painter lays the primary down as a full-canvas band before a single graphic
 * goes on top, which makes the most common quantised colour the base coat by
 * construction. Nearest-neighbour downsample, or the resampler blends
 * neighbouring graphics into colours the car does not actually wear.
 */
function liveryBaseColour(paintMaterial) {
  const fallback = () => new THREE.Color(0x2a2c33);
  const img = paintMaterial?.map?.image;
  if (!img || !img.width) return fallback();
  try {
    const N = 256, M = 128;
    const { x } = canvas2d(N, M);
    x.imageSmoothingEnabled = false;
    x.drawImage(img, 0, 0, N, M);
    const d = x.getImageData(0, 0, N, M).data;
    const bins = new Map();
    let best = null;
    for (let i = 0; i < d.length; i += 4) {
      const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      let b = bins.get(key);
      if (!b) bins.set(key, b = [0, 0, 0, 0]);
      b[0] += d[i]; b[1] += d[i + 1]; b[2] += d[i + 2]; b[3]++;
      if (!best || b[3] > best[3]) best = b;
    }
    if (!best) return fallback();
    return new THREE.Color().setRGB(
      best[0] / best[3] / 255, best[1] / best[3] / 255, best[2] / best[3] / 255,
      THREE.SRGBColorSpace
    );
  } catch {
    return fallback();
  }
}

/** A small tileable grain tile, drawn repeatedly instead of per-pixel loops. */
function grainTile(seed, contrast) {
  const N = 256;
  const { c, x } = canvas2d(N, N);
  const img = x.createImageData(N, N);
  const rng = makeRng(hashSeed(seed));
  for (let i = 0; i < N * N; i++) {
    const v = 128 + (rng() - 0.5) * 255 * contrast;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = clamp(v, 0, 255);
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

function tileFill(x, tile, w, h, alpha, scale) {
  x.save();
  x.globalAlpha = alpha;
  x.globalCompositeOperation = 'overlay';
  const s = tile.width * scale;
  for (let py = 0; py < h; py += s) for (let px = 0; px < w; px += s) x.drawImage(tile, px, py, s, s);
  x.restore();
}

/** Sobel a greyscale height canvas into a tangent-space normal map. */
function heightToNormal(hc, strength) {
  const w = hc.width, h = hc.height;
  const src = hc.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const { c, x } = canvas2d(w, h);
  const out = x.createImageData(w, h);
  const at = (px, py) => src[(((py + h) % h) * w + ((px + w) % w)) * 4];
  for (let y = 0; y < h; y++) {
    for (let px = 0; px < w; px++) {
      const dx = (at(px + 1, y) - at(px - 1, y)) / 255 * strength;
      const dy = (at(px, y + 1) - at(px, y - 1)) / 255 * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const o = (y * w + px) * 4;
      out.data[o] = (nx * inv * 0.5 + 0.5) * 255;
      out.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out.data[o + 2] = (nz * inv * 0.5 + 0.5) * 255;
      out.data[o + 3] = 255;
    }
  }
  x.putImageData(out, 0, 0);
  return c;
}

function tyreTexture(canvas, colorSpace) {
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = colorSpace;
  t.anisotropy = 8;
  return t;
}

/**
 * Albedo + normal + ORM for one compound.
 *   u = around the circumference (1 wrap)
 *   v = across the profile, 0 inner bead .. 1 outer bead
 */
function tyreMaps(compound) {
  return assets.get(`wheels/tyremaps/${compound}`, () => {
    const W = 2048, H = 1024;
    const Y = (v) => (1 - v) * H;
    const wet = WET_COMPOUNDS.has(compound);
    const bandInk = '#' + bandColour(compound).getHexString();
    const rng = makeRng(hashSeed(`tyre/${compound}`));

    // --- albedo -----------------------------------------------------------
    const { c: al, x } = canvas2d(W, H);
    x.fillStyle = '#111114';
    x.fillRect(0, 0, W, H);

    // Sidewalls are a touch bluer and glossier than the scrubbed crown.
    const side = x.createLinearGradient(0, 0, 0, H);
    side.addColorStop(0.00, '#141519');
    side.addColorStop(1 - V_TREAD_OUT, '#0f1013');
    side.addColorStop(1 - V_TREAD_IN, '#0f1013');
    side.addColorStop(1.00, '#141519');
    x.fillStyle = side;
    x.fillRect(0, 0, W, H);

    // Scrubbed tread band: rubber that has been worked is lighter and browner.
    const crown = x.createLinearGradient(0, Y(V_TREAD_OUT), 0, Y(V_TREAD_IN));
    crown.addColorStop(0.00, '#0b0b0c');
    crown.addColorStop(0.14, '#1b1a18');
    crown.addColorStop(0.50, '#211f1c');
    crown.addColorStop(0.86, '#1b1a18');
    crown.addColorStop(1.00, '#0b0b0c');
    x.fillStyle = crown;
    x.fillRect(0, Y(V_TREAD_OUT), W, Y(V_TREAD_IN) - Y(V_TREAD_OUT));

    // Circumferential scrub streaks across the crown.
    for (let i = 0; i < 420; i++) {
      const v = V_TREAD_IN + rng() * (V_TREAD_OUT - V_TREAD_IN);
      const x0 = rng() * W, len = 60 + rng() * 420;
      x.globalAlpha = 0.05 + rng() * 0.09;
      x.strokeStyle = rng() > 0.4 ? '#4a463c' : '#0a0a0b';
      x.lineWidth = 1 + rng() * 3;
      x.beginPath();
      x.moveTo(x0, Y(v));
      x.lineTo(x0 + len, Y(v) + (rng() - 0.5) * 6);
      x.stroke();
    }
    x.globalAlpha = 1;

    // Compound colour band on both sidewalls (baked here, and repeated as real
    // geometry by buildBandGeometry so it catches a specular highlight).
    for (const [a, b, flip] of [[V_BAND_A, V_BAND_B, 1], [1 - V_BAND_B, 1 - V_BAND_A, -1]]) {
      const g = x.createLinearGradient(0, Y(b), 0, Y(a));
      g.addColorStop(0, '#00000000');
      x.fillStyle = bandInk;
      x.fillRect(0, Y(b), W, Y(a) - Y(b));
      void g; void flip;
    }

    // Lettering. v = 1 is the OUTER bead, so the outer sidewall is drawn
    // upright and the inner one mirrored.
    const REPEATS = 4;
    for (let i = 0; i < REPEATS; i++) {
      const cx = (i + 0.35) * (W / REPEATS);
      for (const [vBrand, vBand, flip] of [
        [V_BRAND, (V_BAND_A + V_BAND_B) / 2, 1],
        [1 - V_BRAND, 1 - (V_BAND_A + V_BAND_B) / 2, -1],
      ]) {
        x.save();
        x.translate(cx, Y(vBrand));
        x.scale(1, flip);
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillStyle = '#c2c2c2';
        x.letterSpacing = `${Math.round(W * 0.006)}px`;
        x.font = `900 ${Math.round(H * 0.038)}px Helvetica, Arial, sans-serif`;
        x.fillText('APEX', 0, 0);
        x.restore();

        x.save();
        x.translate(cx + W / (REPEATS * 2), Y(vBand));
        x.scale(1, flip);
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillStyle = compound === 'hard' ? '#101010' : '#f2f2f2';
        x.letterSpacing = `${Math.round(W * 0.003)}px`;
        x.font = `800 ${Math.round(H * 0.022)}px Helvetica, Arial, sans-serif`;
        x.fillText(`${compound.toUpperCase()}`, 0, 0);
        x.restore();
      }
    }

    // Wet compounds: dark grooves cut through the crown.
    if (wet) {
      x.strokeStyle = '#050506';
      x.lineWidth = H * (compound === 'wet' ? 0.026 : 0.017);
      x.lineCap = 'round';
      const lanes = compound === 'wet' ? 4 : 3;
      for (let i = 0; i < lanes; i++) {
        const v = V_TREAD_IN + (i + 0.5) / lanes * (V_TREAD_OUT - V_TREAD_IN);
        x.beginPath();
        for (let px = 0; px <= W; px += 8) {
          const y = Y(v) + Math.sin((px / W) * Math.PI * 2 * 9) * H * 0.018;
          px === 0 ? x.moveTo(px, y) : x.lineTo(px, y);
        }
        x.stroke();
      }
    }

    tileFill(x, grainTile(`tyregrain/${compound}`, 0.60), W, H, 0.31, 1.0);

    // --- height -> normal --------------------------------------------------
    const { c: hc, x: hx } = canvas2d(W, H);
    hx.fillStyle = '#808080';
    hx.fillRect(0, 0, W, H);

    // Moulded circumferential ribs on the sidewalls.
    for (let i = 0; i < 26; i++) {
      const v = 0.66 + (i / 26) * 0.33;
      for (const vv of [v, 1 - v]) {
        hx.strokeStyle = i % 2 ? '#8e8e8e' : '#727272';
        hx.lineWidth = H * 0.0035;
        hx.beginPath(); hx.moveTo(0, Y(vv)); hx.lineTo(W, Y(vv)); hx.stroke();
      }
    }
    // Band edge is a moulded step.
    for (const [a, b] of [[V_BAND_A, V_BAND_B], [1 - V_BAND_B, 1 - V_BAND_A]]) {
      hx.fillStyle = '#8c8c8c';
      hx.fillRect(0, Y(b), W, Y(a) - Y(b));
    }
    // Raised lettering.
    for (let i = 0; i < REPEATS; i++) {
      const cx = (i + 0.35) * (W / REPEATS);
      for (const [vBrand, vBand, flip] of [
        [V_BRAND, (V_BAND_A + V_BAND_B) / 2, 1],
        [1 - V_BRAND, 1 - (V_BAND_A + V_BAND_B) / 2, -1],
      ]) {
        hx.save();
        hx.translate(cx, Y(vBrand)); hx.scale(1, flip);
        hx.textAlign = 'center'; hx.textBaseline = 'middle';
        hx.fillStyle = '#e2e2e2';
        hx.letterSpacing = `${Math.round(W * 0.006)}px`;
        hx.font = `900 ${Math.round(H * 0.038)}px Helvetica, Arial, sans-serif`;
        hx.fillText('APEX', 0, 0);
        hx.restore();
        hx.save();
        hx.translate(cx + W / (REPEATS * 2), Y(vBand)); hx.scale(1, flip);
        hx.textAlign = 'center'; hx.textBaseline = 'middle';
        hx.fillStyle = '#d0d0d0';
        hx.letterSpacing = `${Math.round(W * 0.003)}px`;
        hx.font = `800 ${Math.round(H * 0.022)}px Helvetica, Arial, sans-serif`;
        hx.fillText(`${compound.toUpperCase()}`, 0, 0);
        hx.restore();
      }
    }
    if (wet) {
      hx.strokeStyle = '#2a2a2a';
      hx.lineWidth = H * (compound === 'wet' ? 0.026 : 0.017);
      hx.lineCap = 'round';
      const lanes = compound === 'wet' ? 4 : 3;
      for (let i = 0; i < lanes; i++) {
        const v = V_TREAD_IN + (i + 0.5) / lanes * (V_TREAD_OUT - V_TREAD_IN);
        hx.beginPath();
        for (let px = 0; px <= W; px += 8) {
          const y = Y(v) + Math.sin((px / W) * Math.PI * 2 * 9) * H * 0.018;
          px === 0 ? hx.moveTo(px, y) : hx.lineTo(px, y);
        }
        hx.stroke();
      }
    }
    // MOULD FLASH. Where the two mould halves meet, a thin proud bead of rubber
    // is squeezed out and left on the tyre. It runs right round the tread edge
    // on both shoulders and it is the single most recognisable piece of relief
    // on a new slick — the line that tells you the object was moulded rather
    // than turned.
    for (const v of [V_TREAD_IN - 0.012, V_TREAD_OUT + 0.012]) {
      hx.strokeStyle = '#c8c8c8';
      hx.lineWidth = H * 0.0022;
      hx.beginPath();
      for (let px = 0; px <= W; px += 6) {
        // A flash line wanders by a fraction of a millimetre; a perfectly
        // straight one reads as a decal.
        const y = Y(v) + Math.sin((px / W) * Math.PI * 2 * 3.5) * H * 0.0016;
        px === 0 ? hx.moveTo(px, y) : hx.lineTo(px, y);
      }
      hx.stroke();
    }

    // VENT PIPS — the little spew nubs left by the mould's air vents, scattered
    // over the shoulders. Sub-millimetre, but they catch a specular each and
    // they are why a real sidewall is never a clean surface of revolution.
    for (let i = 0; i < 260; i++) {
      const side = rng() > 0.5;
      const v = side ? 0.70 + rng() * 0.20 : 0.10 + rng() * 0.20;
      const px = rng() * W;
      const r = H * (0.0022 + rng() * 0.0026);
      const g = hx.createRadialGradient(px, Y(v), 0, px, Y(v), r);
      g.addColorStop(0, '#d6d6d6');
      g.addColorStop(1, '#80808000');
      hx.fillStyle = g;
      hx.beginPath(); hx.arc(px, Y(v), r, 0, Math.PI * 2); hx.fill();
    }

    // GRAINING across the crown: a worked slick tears in fine circumferential
    // ridges rather than wearing smooth.
    for (let i = 0; i < 340; i++) {
      const v = V_TREAD_IN + rng() * (V_TREAD_OUT - V_TREAD_IN);
      const x0 = rng() * W, len = 30 + rng() * 200;
      hx.globalAlpha = 0.12 + rng() * 0.16;
      hx.strokeStyle = rng() > 0.5 ? '#9a9a9a' : '#666666';
      hx.lineWidth = 1 + rng() * 2.5;
      hx.beginPath();
      hx.moveTo(x0, Y(v));
      hx.lineTo(x0 + len, Y(v) + (rng() - 0.5) * 4);
      hx.stroke();
    }
    hx.globalAlpha = 1;

    // THE PEBBLE, AND NOTHING MORE.
    //
    // Round 5 pushed this to `contrast 1.0, alpha 0.66` and the Sobel below to
    // `strength 5.0`, on the theory that a stronger normal reads as more surface.
    // It does the opposite. Full-amplitude white noise sobels into a normal that
    // is randomly tilted 50-60 degrees at EVERY texel; mip and anisotropic
    // filtering then clump neighbouring texels into the wormy, coral-like ridges
    // the review found, and — the real cost — a randomised normal scatters the
    // specular lobe uniformly, so a low-roughness band and a high-roughness band
    // reflect identically and the three-zone roughness map underneath renders as
    // one material. The surface has to be a FINE EVEN PEBBLE for the roughness
    // split to be visible at all: normal for the millimetre grain, roughness for
    // the material.
    tileFill(hx, grainTile(`tyrebump/${compound}`, 0.52), W, H, 0.38, 1.0);

    // --- ORM ---------------------------------------------------------------
    //
    // THE TYRE'S ROUGHNESS IS THE TYRE. Before round 5 this was one value —
    // 0.70 over the whole carcass with the CROWN pushed to 0.92, i.e. the
    // glossiest part of a real slick authored as the mattest thing on the car —
    // and the result is the "uniform sandpaper-grain field" finding: no scrub
    // band, no mould flash, no sheen, no relief in the lettering. A slick has
    // three distinct surfaces and they are three distinct roughnesses:
    //
    //   crown     0.42-0.52  scrubbed by the road every lap and coated in its own
    //                        melted rubber. It is GLOSSY, and the gloss is what
    //                        makes a hot tyre read as hot.
    //   shoulder  0.80       never touches the road at racing camber, keeps the
    //                        mould's blasted matte finish, collects marbles.
    //   sidewall  0.66       moulded rubber with a broad, low-frequency sheen —
    //                        a real sidewall shows a soft vertical highlight
    //                        travelling round it as the wheel turns.
    //
    // Raised to 1024x512 because the moulded lettering now carries its own
    // roughness (moulded relief is glossier than the blasted field around it)
    // and 512x256 could not resolve a letter stroke.
    const OW = 1024, OH = 512;
    const { c: oc, x: ox } = canvas2d(OW, OH);
    const OY = (v) => (1 - v) * OH;
    const orm = (ao, rough, metal = 0) => `rgb(${Math.round(clamp(ao, 0, 1) * 255)},${Math.round(clamp(rough, 0, 1) * 255)},${Math.round(clamp(metal, 0, 1) * 255)})`;

    // THE THREE BANDS, written in v and mirrored about the crown. The previous
    // pass authored these as one gradient whose "matte shoulder" plateau ran from
    // v 0.337 to v 0.663 — i.e. exactly the span the crown rectangle then painted
    // over — so the shoulder existed in the source and not in the texture, and
    // the tyre still shaded as sidewall-into-crown with no matte band between
    // them. The zone edges are now pinned to the LATHE PROFILE:
    //
    //   v 0.357..0.643   crown / contact band   ROUGH 0.30 .. 0.44
    //   v 0.643..0.745   shoulder               ROUGH 0.92          (and mirror)
    //   v 0.745..0.955   sidewall               ROUGH 0.46 .. 0.60  (and mirror)
    //   v 0.955..1.000   bead                   ROUGH 0.68, AO down (and mirror)
    //
    // The step from the shoulder to the sidewall is deliberately HARD (0.015 of
    // v, about two texels): on the real tyre it is the edge of the moulded
    // sidewall panel, and a soft ramp there is what makes the whole flank read as
    // one continuous material.
    const S = (v, ao, rough) => [1 - v, orm(ao, rough)];
    const ZONES = [
      S(1.000, 0.62, 0.68),   // outer bead, in the flange's shadow
      S(0.958, 0.86, 0.60),
      S(0.945, 1.00, 0.54),
      S(0.900, 1.00, 0.46),   // sidewall sheen crest — the soft vertical highlight
      S(0.860, 1.00, 0.55),
      S(0.820, 1.00, 0.47),   // second crest, on the compound-band step
      S(0.775, 1.00, 0.58),
      S(0.760, 1.00, 0.60),
      S(0.745, 1.00, 0.92),   // <- hard step into the matte shoulder
      S(0.660, 1.00, 0.92),
      S(0.643, 1.00, 0.72),   // tread edge; the crown gradient continues below
    ];
    const sheen = ox.createLinearGradient(0, 0, 0, OH);
    for (const [y, ink] of ZONES) sheen.addColorStop(clamp(y, 0, 1), ink);
    for (const [y, ink] of ZONES) sheen.addColorStop(clamp(1 - y, 0, 1), ink);
    ox.fillStyle = sheen;
    ox.fillRect(0, 0, OW, OH);

    // THE SCRUBBED CROWN. A slick's contact band is polished by the road and
    // glazed with its own melted rubber every lap: it is the GLOSSIEST surface on
    // the car after the visor, and at 0.30 against the shoulder's 0.92 it is a
    // three-to-one roughness step, which is what it takes for the two to read as
    // two materials rather than as one field with a gradient in it.
    const rg = ox.createLinearGradient(0, OY(V_TREAD_OUT), 0, OY(V_TREAD_IN));
    rg.addColorStop(0.00, orm(1, 0.72));
    rg.addColorStop(0.09, orm(1, 0.44));
    rg.addColorStop(0.28, orm(1, 0.33));
    rg.addColorStop(0.50, orm(1, 0.30));
    rg.addColorStop(0.72, orm(1, 0.33));
    rg.addColorStop(0.91, orm(1, 0.44));
    rg.addColorStop(1.00, orm(1, 0.72));
    ox.fillStyle = rg;
    ox.fillRect(0, OY(V_TREAD_OUT), OW, OY(V_TREAD_IN) - OY(V_TREAD_OUT));

    // Scrub streaks: the crown is not uniformly polished. These follow the same
    // circumferential direction as the albedo streaks above, so a gloss run and
    // a colour run land together the way a real scrub mark does.
    ox.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 260; i++) {
      const v = V_TREAD_IN + rng() * (V_TREAD_OUT - V_TREAD_IN);
      const x0 = rng() * OW, len = 40 + rng() * 260;
      ox.globalAlpha = 0.10 + rng() * 0.16;
      ox.strokeStyle = orm(1, rng() > 0.45 ? 0.34 : 0.62);
      ox.lineWidth = 1 + rng() * 4;
      ox.beginPath();
      ox.moveTo(x0, OY(v));
      ox.lineTo(x0 + len, OY(v) + (rng() - 0.5) * 5);
      ox.stroke();
    }
    ox.globalAlpha = 1;

    // The moulded compound band: a paint-filled step, glossier than the rubber.
    for (const [a, b] of [[V_BAND_A, V_BAND_B], [1 - V_BAND_B, 1 - V_BAND_A]]) {
      ox.fillStyle = orm(1, 0.30);
      ox.fillRect(0, OY(b), OW, OY(a) - OY(b));
    }

    // RELIEF LETTERING, in roughness as well as in the normal. A moulded
    // wordmark is formed against polished tool steel, so its faces come out
    // markedly glossier than the blasted field around them — that contrast is
    // most of what makes sidewall lettering read at all under a low sun.
    for (let i = 0; i < REPEATS; i++) {
      const cx = (i + 0.35) * (OW / REPEATS);
      for (const [vBrand, vBand, flip] of [
        [V_BRAND, (V_BAND_A + V_BAND_B) / 2, 1],
        [1 - V_BRAND, 1 - (V_BAND_A + V_BAND_B) / 2, -1],
      ]) {
        ox.save();
        ox.translate(cx, OY(vBrand)); ox.scale(1, flip);
        ox.textAlign = 'center'; ox.textBaseline = 'middle';
        ox.fillStyle = orm(1, 0.24);
        ox.letterSpacing = `${Math.round(OW * 0.006)}px`;
        ox.font = `900 ${Math.round(OH * 0.038)}px Helvetica, Arial, sans-serif`;
        ox.fillText('APEX', 0, 0);
        ox.restore();
        ox.save();
        ox.translate(cx + OW / (REPEATS * 2), OY(vBand)); ox.scale(1, flip);
        ox.textAlign = 'center'; ox.textBaseline = 'middle';
        ox.fillStyle = orm(1, 0.22);
        ox.letterSpacing = `${Math.round(OW * 0.003)}px`;
        ox.font = `800 ${Math.round(OH * 0.022)}px Helvetica, Arial, sans-serif`;
        ox.fillText(`${compound.toUpperCase()}`, 0, 0);
        ox.restore();
      }
    }

    // Bead shadow — the one place the tyre is genuinely occluded. AO only: the
    // bead's roughness is part of the zone ramp above, and re-flooding it here
    // (as a flat 0.74) was clipping the outer 5 % of the sidewall sheen off.
    for (const [a, b] of [[0.0, 0.048], [0.952, 1.0]]) {
      ox.save();
      ox.globalCompositeOperation = 'multiply';
      ox.fillStyle = 'rgb(150,255,255)';
      ox.fillRect(0, OY(b), OW, OY(a) - OY(b));
      ox.restore();
    }

    // Rubber pickup on both shoulders: marbles and melted rubber, which is
    // matte, blotchy and the reason a used tyre never reads as one material.
    // Coarser and weaker than round 5's: with the normal grain now fine and even
    // this is the only high-frequency term left on the roughness, and at 0.30 it
    // was speckling the crown's gloss back off again.
    tileFill(ox, grainTile(`tyreorm/${compound}`, 0.45), OW, OH, 0.17, 3.0);

    return {
      map: tyreTexture(al, THREE.SRGBColorSpace),
      // 5.0 -> 1.9: see the pebble note above. The relief that has to survive is
      // the LOW-frequency relief — the mould flash, the lettering, the band step
      // — and those are drawn as wide, high-contrast marks, so they lose far
      // less here than the per-texel grain does.
      normalMap: tyreTexture(heightToNormal(hc, 1.9), THREE.NoColorSpace),
      ormMap: tyreTexture(oc, THREE.NoColorSpace),
    };
  });
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Lathed tyre carcass. Axis is +X after the rotation.
 * `grooved` cuts real tread blocks into the crown for the wet compounds.
 */
function buildTyreGeometry(halfWidth, grooved) {
  const segs = grooved ? 176 : 96;
  const pts = PROFILE.map(([r, a]) => new THREE.Vector2(r, a * halfWidth));
  const g = new THREE.LatheGeometry(pts, segs);

  if (grooved) {
    // Radial grooves + circumferential lanes, displaced into the crown only.
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const v = uv.getY(i);
      if (v < V_TREAD_IN - 0.02 || v > V_TREAD_OUT + 0.02) continue;
      const u = uv.getX(i);
      const t = (v - V_TREAD_IN) / (V_TREAD_OUT - V_TREAD_IN);
      const lane = Math.abs(Math.sin((t * 3.5 + 0.25) * Math.PI));
      const block = Math.abs(Math.sin((u * 13 + t * 1.8) * Math.PI));
      const cut = Math.min(lane, block);
      if (cut > 0.32) continue;
      const depth = 0.0085 * (1 - cut / 0.32);
      const y = pos.getY(i), z = pos.getZ(i);
      const r = Math.hypot(y, z) || 1;
      pos.setY(i, y * (1 - depth / r));
      pos.setZ(i, z * (1 - depth / r));
    }
    pos.needsUpdate = true;
  }

  g.rotateZ(-Math.PI / 2);   // lathe axis Y -> car-local X
  g.computeVertexNormals();
  return g;
}

/** Mirror a tyre geometry's u so the moulded lettering reads on the far side. */
function mirrorU(geo) {
  const g = geo.clone();
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
  uv.needsUpdate = true;
  return g;
}

/** Thin proud ring following the sidewall, carrying the compound colour. */
function buildBandGeometry(halfWidth) {
  const pts = [];
  const N = 7;
  for (let i = 0; i < N; i++) {
    const v = lerp(V_BAND_A - 0.004, V_BAND_B + 0.004, i / (N - 1));
    const [r, aF] = profileAtV(v);
    const [r1, aF1] = profileAtV(Math.min(1, v + 0.01));
    const [r0, aF0] = profileAtV(Math.max(0, v - 0.01));
    const dr = r1 - r0, da = (aF1 - aF0) * halfWidth;
    const len = Math.hypot(dr, da) || 1;
    // outward surface normal of the profile curve
    const nr = da / len, na = -dr / len;
    pts.push(new THREE.Vector2(r + nr * 0.0018, aF * halfWidth + na * 0.0018));
  }
  const g = new THREE.LatheGeometry(pts, 96);
  g.rotateZ(-Math.PI / 2);
  g.computeVertexNormals();
  return g;
}

/** Turn a surface inside out, in place: reversed winding AND flipped normals. */
function flipFaces(g) {
  const idx = g.index;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i);
    idx.setX(i, idx.getX(i + 2));
    idx.setX(i + 2, a);
  }
  idx.needsUpdate = true;
  const n = g.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  n.needsUpdate = true;
  return g;
}

/** Explicit polygon ring — avoids Path.absarc's shared `curveSegments`. */
function circlePoly(r, n, cx = 0, cy = 0, cw = false) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (cw ? -1 : 1) * (i / n) * Math.PI * 2;
    pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
  }
  return pts;
}

/** Swept turbine-blade slot: the angle marches with radius so it reads as a fan. */
function bladeSlot(r0, r1, aMid, halfW, twist, seg = 8) {
  const pts = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg, r = lerp(r0, r1, t), a = aMid + twist * t + halfW;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  for (let i = seg; i >= 0; i--) {
    const t = i / seg, r = lerp(r0, r1, t), a = aMid + twist * t - halfW;
    pts.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return pts;
}

/** Outboard face of the rim barrel: where the aero cover sits. */
const coverPlaneX = (halfWidth) => halfWidth * 0.80;

// ---------------------------------------------------------------------------
// The 2022+ aero wheel cover
// ---------------------------------------------------------------------------
/**
 * A regulation aero cover is a NEARLY SOLID dished disc in the team's base
 * colour. It is not a wheel: there are no spokes, and from three metres you see
 * paint, not daylight. The numbers below are the whole finding — the slot ring
 * opens 28 % of a narrow annulus, which works out at 11 % of the cover face, so
 * every web is 2.6x wider than the slot beside it.
 *
 *   COVER_SLOT_R0 / R1   0.640 .. 0.838 of RIM_RADIUS: a 45 mm vent ring out by
 *                        the flange. The hub boss inside and the outer 16 % of
 *                        the radius are solid.
 *   COVER_SLOT_HALF      angular half-width, rad. Pitch is 2pi/12 = 0.5236, so
 *                        2*0.074 / 0.5236 = 28 % open over an annulus that is
 *                        itself 30 % of the face area — 8 % of the cover opens.
 *   COVER_DISH           the face is pulled 14 mm inboard toward the hub and
 *   COVER_LIP            rolls 5.5 mm back out over the last 10 % of the radius.
 *                        That roll is what catches a rim highlight; without it a
 *                        flat plate has no form at all.
 */
// 12 mm of rim flange around a 217 mm cover is 5 % of the radius — nine pixels
// on the `wheel` crop, which is not a material, it is an outline. A real 2022
// cover sits well inside the flange: the bead seat, the safety hump and the
// flange land together are 25-30 mm of bare turned aluminium. 26 mm puts the
// machined ring at 11 % of the radius, which is where it reads as metal.
const COVER_OUTER = RIM_RADIUS - 0.020;      // 0.2086
const COVER_HUB_HOLE = 0.040;
// 14 mm of dish across a 209 mm disc tilts the face by 7 degrees at its widest,
// which is not enough curvature for a reflection to move across it: every normal
// on the cover points within a few degrees of straight outboard, so the whole
// face samples one direction of the probe and shades to ONE value. That is the
// mechanism behind "no highlight anywhere on it" — the material was only half
// the story, the surface had no form for a highlight to sit on. 24 mm takes the
// edge tilt to 12-13 degrees, which is enough for the horizon to cut across the
// dish and for the arc to travel as the wheel moves. It is also what a real
// cover measures; they are noticeably concave in the pit lane.
//
// BUT NOT AS GEOMETRY. `ExtrudeGeometry` runs earcut on a 96-gon with thirteen
// holes in it, and earcut answers with long radial SLIVERS — single triangles
// spanning r = 0.03 to r = 0.20. Displacing their vertices onto a 24 mm dish
// leaves each sliver chording straight across the curve, and at 24 mm that chord
// error silhouettes as a hard wedge across the paint (visible at 2 o'clock in
// the first capture of this change). So the dish stays shallow in POSITION and
// the extra curvature is carried by the analytic normal instead — see
// COVER_NORMAL_CURVE. The silhouette of a wheel cover is a circle either way;
// the only thing the depth was ever for is the shading.
const COVER_DISH = 0.016;
const COVER_LIP = 0.0015;
const COVER_SLOTS = 12;
// The slots were 0.525..0.822 R — 68 mm long on a 217 mm radius, i.e. a third of
// the way to the centre. At that length twelve of them read as twelve SPOKES
// however solid the paint between them is, because the eye reads the long thin
// dark bars, not the field they sit in. A real cover's vent ring is short and
// sits out near the flange.
// Anchored to COVER_OUTER, not to RIM_RADIUS: the cover shrank to make room for
// the flange, and a ring pinned to the rim would now sit on the lip.
const COVER_SLOT_R0 = COVER_OUTER * 0.660;   // 0.1337
const COVER_SLOT_R1 = COVER_OUTER * 0.858;   // 0.1738
const COVER_SLOT_HALF = 0.0740;              // 2*0.074/0.5236 = 28 % open, webs 2.5x
const COVER_SLOT_TWIST = 0.115;

/** Outboard offset of the cover face at radius `r`, metres. */
function coverDish(r) {
  const t = clamp(r / COVER_OUTER, 0, 1);
  return -COVER_DISH * (1 - Math.pow(t, 1.9)) + COVER_LIP * smoothstep(0.90, 1.0, t);
}

/**
 * How much steeper the cover SHADES than it is. `dishRadially` already replaces
 * the faceted lid normals with the exact normal of the surface of revolution, so
 * scaling the slope there costs nothing and cannot chord: it is a smooth,
 * continuous normal field over a nearly flat plate. 2.2 gives the shading of a
 * 35 mm dish on 16 mm of geometry, which is the curvature the reflection needs
 * to sweep the horizon across the face without the triangulation showing.
 */
const COVER_NORMAL_CURVE = 2.2;

/** d(coverDish)/dr, central difference — used for the analytic dish normal. */
function coverDishSlope(r) {
  return (coverDish(r + 1e-4) - coverDish(r - 1e-4)) / 2e-4;
}

/**
 * Bend a flat extruded cover part onto the dish. The part is already rotated so
 * that +X is outboard and the (y, z) plane is the face, so this is a pure
 * function of radius and cannot shear the slot walls.
 *
 * The lid faces then get ANALYTIC normals. `ExtrudeGeometry` is non-indexed, so
 * `computeVertexNormals` produces per-triangle flat normals — and earcut
 * triangulates a 96-gon dish into long skinny slivers, which shaded as a dozen
 * visible flat plates rather than as a turned surface. The dish is a surface of
 * revolution, so its normal is exactly `(1, -f'(r) * rhat)`; only the slot walls
 * and the bevel (group 1) keep the faceted normals, which is correct for them.
 */
function dishRadially(g, bias) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    p.setX(i, p.getX(i) + bias + coverDish(Math.hypot(p.getY(i), p.getZ(i))));
  }
  p.needsUpdate = true;
  g.computeVertexNormals();

  const n = g.attributes.normal;
  const lids = g.groups.find((gr) => gr.materialIndex === 0) ?? { start: 0, count: p.count };
  for (let i = lids.start; i < lids.start + lids.count; i++) {
    const y = p.getY(i), z = p.getZ(i);
    const r = Math.hypot(y, z);
    if (r < 1e-5) continue;
    const s = n.getX(i) < 0 ? -1 : 1;
    const k = -coverDishSlope(r) * COVER_NORMAL_CURVE;
    const inv = s / Math.hypot(1, k);
    n.setXYZ(i, inv, inv * k * (y / r), inv * k * (z / r));
  }
  n.needsUpdate = true;
  return g;
}

/**
 * The wheel-well gradient, as GLSL rather than as vertex colours.
 *
 * A dished cover sunk 40 mm inside a 720 mm tyre is DARKER and BLUER toward the
 * hub: the well shades it and what light does reach the recess is sky ambient,
 * not sun. Two occluders, not one — the well shades the hub, and the tyre's own
 * bead flange overhangs the last 14 % of the radius, which is the darkest band
 * on a real cover and the thing that stops the disc silhouetting as a sticker.
 *
 * IT CANNOT BE A VERTEX ATTRIBUTE. `ExtrudeGeometry` runs earcut, and earcut
 * triangulates a 96-gon with twelve slot holes into long radial SLIVERS: a
 * single triangle can span r = 0.03 to r = 0.21, so a per-vertex ramp gets
 * linearly interpolated across the whole radius and the face renders as a set of
 * hard straight bands. (That is visible in `shots/w1-crop2.png` — the horizontal
 * streaks across the paint.) Evaluated per fragment from the fragment's own
 * radius it is exact whatever the triangulation does.
 */
/**
 * MACHINED AND USED, not moulded and clean.
 *
 * Injected at `roughnessmap_fragment` — `roughnessFactor` does not exist yet at
 * `color_fragment`, which is where the shade ramp below goes. Three things a
 * real cover has that a radial gradient does not: the turning marks left by the
 * tool (a fine circumferential corduroy, strongest out by the flange where the
 * surface speed was highest), a ring of witness marks at the twelve retaining
 * screws, and brake dust — a warm grey film that gets heavier toward the vent
 * ring, because that is where the air carrying it comes out. All three are
 * SURFACE, not paint: put them in the albedo and a machined part becomes a
 * printed one.
 */
const COVER_ROUGH_GLSL = `
  {
    float r = vCoverR;
    float turn = sin(vCoverA * 190.0) * 0.5 + 0.5;
    float dust = smoothstep(0.30, 0.98, r)
      * (0.5 + 0.25 * sin(vCoverA * 11.0 + r * 26.0) + 0.25 * sin(vCoverA * 23.0 - r * 41.0));
    float bolts = smoothstep(0.034, 0.0, abs(r - 0.385))
                * smoothstep(0.62, 1.0, abs(sin(vCoverA * 3.0)));
    roughnessFactor = clamp(roughnessFactor
      + turn * 0.042 * smoothstep(0.25, 1.0, r)
      + dust * 0.085
      - bolts * 0.10, 0.03, 1.0);
  }
`;

const COVER_SHADE_GLSL = `
  {
    float r = vCoverR;
    // Brake dust again, in the albedo this time and only faintly: a used cover
    // is a shade paler and a shade less saturated out by the vents.
    float dust = smoothstep(0.36, 1.00, r)
      * (0.5 + 0.25 * sin(vCoverA * 11.0 + r * 26.0) + 0.25 * sin(vCoverA * 23.0 - r * 41.0));
    diffuseColor.rgb = mix(diffuseColor.rgb,
      vec3(dot(diffuseColor.rgb, vec3(0.35, 0.42, 0.23))) * 1.30 + vec3(0.006, 0.005, 0.004),
      dust * 0.10);
    // The recess is 14 mm deep in a 217 mm disc, not a cave: at a 0.34 floor
    // spread over 86 % of the radius the middle of the cover read as a black
    // hole with a bump in it. Keep the ramp tight and shallow so it models a
    // dish, and let the flange band carry the strong occlusion.
    float well = smoothstep(0.00, 0.40, r);
    // The outer band is no longer overhung by the tyre — the machined flange now
    // occupies that radius — so the hard 0.40 cut there was darkening the paint
    // for an occluder that has moved outboard of it.
    float flange = 1.0 - 0.22 * smoothstep(0.90, 1.04, r);
    float k = mix(0.74, 1.0, well) * flange;
    diffuseColor.rgb *= vec3(k, k * mix(1.05, 1.0, well), k * mix(1.18, 1.0, well));
  }
`;

/** Rim barrel: the structural wheel, bead flanges seated on the tyre profile. */
function buildRimBarrelGeometry(halfWidth) {
  const parts = [];
  const w = halfWidth * HALF_PROFILE[0][1] * -1;   // bead seat, 0.93 * halfWidth

  const barrel = new THREE.CylinderGeometry(RIM_RADIUS - 0.005, RIM_RADIUS - 0.005, w * 2, 48, 1, true);
  barrel.rotateZ(-Math.PI / 2);
  parts.push(barrel);

  // Bead flanges. `+X` is outboard for every wheel (meshes are mirrored).
  for (const s of [1, -1]) {
    const lip = new THREE.TorusGeometry(RIM_RADIUS - 0.006, 0.0125, 8, 48);
    lip.rotateY(Math.PI / 2);
    lip.translate(s * w, 0, 0);
    parts.push(lip);
  }

  // Drive hub the cover bolts to, plus the brake bell. It has to END INBOARD OF
  // THE COVER DISH: at `plane - 0.030` its 60 mm outboard face stood 7.5 mm
  // proud of the dished face and punched a black dark-metal disc straight
  // through the middle of the cover, which is what the old proud hex nut used
  // to be hiding.
  const hub = new THREE.CylinderGeometry(0.060, 0.052, 0.075, 20);
  hub.rotateZ(-Math.PI / 2);
  hub.translate(coverPlaneX(halfWidth) - 0.055, 0, 0);
  parts.push(hub);
  parts.push(buildBrakeBellGeometry());

  return mergeGeometries(parts);
}

/**
 * THE MACHINED RIM FLANGE — the bare metal between the cover lip and the tyre
 * bead.
 *
 * `COVER_OUTER` is 12 mm inside `RIM_RADIUS` and the cover's lip sits ~8 mm
 * inboard of the bead seat, so there is a real annulus of turned aluminium
 * around the whole cover on the actual car. It was being drawn by the barrel's
 * `darkMetal` at roughness 1.05 — i.e. as an unlit dark ring — and that is why
 * the corner had no bare metal in it anywhere.
 *
 * It matters out of all proportion to its area. A polished ring is the one
 * surface on a wheel whose normal sweeps a full 360 degrees of azimuth, so under
 * any light at all it throws a hot circumferential streak at two points and
 * stays dark everywhere else, and that streak is what tells the eye the wheel is
 * METAL and the disc in the middle of it is PAINT. Without it the whole corner
 * is one material.
 *
 * The land is drawn as a separate mesh from the barrel purely so it can carry
 * its own material; it is 96-gon and adds ~380 triangles per corner.
 */
function buildRimFlangeGeometry(halfWidth) {
  const plane = coverPlaneX(halfWidth);
  const lip = plane + coverDish(COVER_OUTER) + 0.010;   // outboard face of the cover
  const bead = halfWidth * 0.930;                        // where the tyre seats
  const parts = [];

  // A CONE, not a flat annulus, and that is the whole trick. A flat ring has one
  // normal everywhere on it, so it shades to a single value and reads as a
  // painted outline. This is the INSIDE of a shallow funnel — the cover is
  // recessed 8 mm behind the bead, so what you see from outboard is the wall
  // sloping down to it — and its normal therefore points outboard AND inward,
  // which means the inward component sweeps a full 360 degrees of azimuth around
  // the wheel. One light source then lights one arc of the ring hard and leaves
  // the opposite arc black, and the arc travels as the car moves. That is the
  // "machined rim flange throwing a hot specular" the review asked for.
  //
  // DOUBLE SIDED, deliberately. `CylinderGeometry` winds an open cylinder normals
  // -OUT, i.e. away from the axis, so a funnel's visible inner wall is a back
  // face and FrontSide culling deletes the part completely. three flips the
  // shading normal by `gl_FrontFacing`, so DoubleSide gives the inward normal for
  // free rather than needing the geometry rebuilt inside out. (The same trap is
  // one sign away in every ring on this page: `RingGeometry` faces +Z, so
  // `rotateY(-PI/2)` aims it inboard and it vanishes.)
  const rise = Math.max(0.0035, Math.min(0.0090, bead - lip - 0.0010));
  const cone = new THREE.CylinderGeometry(RIM_RADIUS - 0.0020, COVER_OUTER - 0.0010, rise, 96, 1, true);
  cone.rotateZ(-Math.PI / 2);          // +Y (radiusTop) -> +X (outboard)
  cone.translate(lip + rise / 2, 0, 0);
  parts.push(cone);

  return mergeGeometries(parts);
}

/**
 * The mandated aero wheel cover: a near-solid dished disc, a narrow ring of
 * twelve turbine slots over the disc's friction band, twelve raised webs
 * between them and a rolled outer edge that tucks under the rim flange.
 *
 * The only thing you see daylight through is the slot ring, and behind that
 * sits the drum backplate — so what reads is the cherry-orange disc, not the
 * track. Everything here is one painted part; the centre-lock nut is captive
 * BEHIND the flush cap and never shows.
 */
function buildWheelCoverGeometry(halfWidth) {
  const plane = coverPlaneX(halfWidth);
  const DEPTH = 0.010;
  const parts = [];
  const pitch = (Math.PI * 2) / COVER_SLOTS;

  // --- dished face -------------------------------------------------------
  const shape = new THREE.Shape(circlePoly(COVER_OUTER, 96));
  shape.holes.push(new THREE.Path(circlePoly(COVER_HUB_HOLE, 20, 0, 0, true)));
  for (let i = 0; i < COVER_SLOTS; i++) {
    shape.holes.push(new THREE.Path(
      bladeSlot(COVER_SLOT_R0, COVER_SLOT_R1, i * pitch, COVER_SLOT_HALF, COVER_SLOT_TWIST, 6)
    ));
  }
  const face = new THREE.ExtrudeGeometry(shape, {
    depth: DEPTH, bevelEnabled: true, bevelThickness: 0.0016,
    bevelSize: 0.0020, bevelSegments: 1, curveSegments: 2,
  });
  face.rotateY(Math.PI / 2);       // extrude +Z -> +X (outboard)
  parts.push(dishRadially(face, plane));

  // --- rolled outer edge --------------------------------------------------
  // A short skirt running back inboard from the lip, closing the gap to the
  // bead flange. Without it the cover silhouettes as a disc floating in a hole.
  const SKIRT = 0.021;
  const skirt = new THREE.CylinderGeometry(COVER_OUTER, COVER_OUTER - 0.0035, SKIRT, 96, 1, true);
  skirt.rotateZ(-Math.PI / 2);
  skirt.translate(plane + coverDish(COVER_OUTER) + DEPTH - SKIRT / 2, 0, 0);
  parts.push(skirt);

  // --- raised webs --------------------------------------------------------
  // Shallow turbine vanes swelling ~2 mm out of the dish, one per web, filling
  // 55 % of the web so a slot never touches one. These are the cover's only
  // relief: a soft ridge on a solid face reads nothing like a through-spoke.
  for (let i = 0; i < COVER_SLOTS; i++) {
    const aMid = i * pitch + pitch / 2 + COVER_SLOT_TWIST * 0.5;
    const fin = new THREE.ExtrudeGeometry(
      new THREE.Shape(bladeSlot(COVER_SLOT_R0 - 0.002, COVER_SLOT_R1 + 0.006, aMid, 0.046, COVER_SLOT_TWIST, 6)),
      {
        // Almost all bevel and only 1.6 mm of wall: a soft swell in the paint,
        // not a rib. At 3.4 mm they threw twelve hard shadows and the cover read
        // as a twelve-spoke alloy again, in red.
        depth: 0.0016, bevelEnabled: true, bevelThickness: 0.0011,
        bevelSize: 0.0038, bevelSegments: 2, curveSegments: 2,
      }
    );
    fin.rotateY(Math.PI / 2);
    parts.push(dishRadially(fin, plane + DEPTH - 0.0008));
  }

  // --- flush captive centre cap ------------------------------------------
  // Flush: 4 mm of total relief. It reads as a machined cap sitting IN the dish,
  // where the old 43 mm hex read as a road-car centre lock sitting on top of it.
  const capX = plane + coverDish(0.030) + DEPTH;

  // NO HUB BOSS. A 3.5 mm machined step at r = 0.062..0.092 was tried to break
  // up the soft dark patch where the dish bottoms out, and at this camera
  // obliquity its side wall projects into a fat drum sitting on the paint — it
  // cost more than the smudge did. The dish reads as a dish; leave it.
  const collar = new THREE.CylinderGeometry(0.0555, 0.058, 0.0055, 32);
  collar.rotateZ(-Math.PI / 2);
  collar.translate(capX - 0.0002, 0, 0);
  parts.push(collar);

  // A SOCKET, not a dome. The 5 mm spun dome that used to sit here is the
  // "smooth featureless dome instead of a centre-lock nut" finding: it is a
  // convex surface in body paint, so it shades exactly like the dish around it
  // and adds no material change at the one point of the wheel the eye goes to
  // first. What is actually there on the car is a RECESS with an anodised
  // titanium nut at the bottom of it — and a recess is worth having because its
  // wall is a cone, so it always carries a bright arc on one side and a hard
  // shadow on the other whatever the light does.
  //
  // The wall stays in cover paint (it is part of the moulding); only the nut
  // and its clip are metal, and they live in `buildWheelNutGeometry`.
  const SOCKET_R = 0.0435, SOCKET_DEPTH = 0.0068;
  const wall = new THREE.CylinderGeometry(SOCKET_R, SOCKET_R - 0.0055, SOCKET_DEPTH, 32, 1, true);
  wall.rotateZ(-Math.PI / 2);
  wall.translate(capX + 0.0028 - SOCKET_DEPTH / 2, 0, 0);
  parts.push(wall);

  // The land between the collar's outer edge and the socket mouth.
  const land = new THREE.RingGeometry(SOCKET_R, 0.0555, 32, 1);
  land.rotateY(Math.PI / 2);
  land.translate(capX + 0.0028, 0, 0);
  parts.push(land);

  return mergeGeometries(parts);
}

/**
 * Exposed metal wheel furniture. A modern F1 corner shows six cover retaining
 * bolts and nothing else — the centre-lock nut is a captive part sitting
 * INBOARD of the cap, so it is modelled where it really is and is never seen
 * proud of the cover. (It used to be a 40 mm hex standing 43 mm off the face,
 * which is what made the whole corner read as a road-car alloy.)
 */
function buildWheelNutGeometry(halfWidth) {
  const parts = [];
  const plane = coverPlaneX(halfWidth);

  // Retaining bolts, sunk into the dish around the cap. At 5.8 mm standing
  // 1.5 mm proud they caught a specular each and rendered as six blown white
  // dots on the paint — the one thing on the cover that was not the cover.
  // Halved and dropped flush, so they read as fasteners at 1 m and as nothing
  // at 5 m, which is what they do on the car.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.26;
    const r = 0.080;
    const b = new THREE.CylinderGeometry(0.0040, 0.0040, 0.0055, 6);
    b.rotateZ(-Math.PI / 2);
    b.translate(plane + coverDish(r) + 0.0095, Math.cos(a) * r, Math.sin(a) * r);
    parts.push(b);
  }

  // THE CENTRE-LOCK NUT, sitting at the bottom of the cover's socket.
  //
  // A hex, because that is what it is, but SUNK: its outboard face is 1.4 mm
  // below the socket mouth, so the six flats read as a machined hexagon in
  // anodised titanium down a hole and never as the proud 43 mm hex that made
  // this corner photograph as a road-car alloy in round 2. Six flats also means
  // six different normals, so at any light angle two of them are lit hard and
  // two are in shadow — the specular event this part exists to provide.
  // MUST match `buildWheelCoverGeometry`'s capX, which is measured from the
  // OUTBOARD face of the extrusion — i.e. it includes the cover's 10 mm DEPTH.
  // Without it the nut sits a centimetre behind the paint and never shows.
  const capX = plane + coverDish(0.030) + 0.010;
  const NUT_R = 0.0345;
  const nut = new THREE.CylinderGeometry(NUT_R, NUT_R * 0.97, 0.020, 6);
  nut.rotateZ(-Math.PI / 2);
  nut.rotateX(0.26);
  nut.translate(capX - 0.0060, 0, 0);
  parts.push(nut);

  // Its retaining clip: a wire circlip lying across the nut face. Two hundred
  // triangles, and it is the difference between "a hexagon" and "a fastener".
  const clip = new THREE.TorusGeometry(NUT_R * 0.80, 0.0022, 6, 28, Math.PI * 1.62);
  clip.rotateY(Math.PI / 2);
  clip.translate(capX + 0.0038, 0, 0);
  parts.push(clip);

  return mergeGeometries(parts);
}

/**
 * 328 mm carbon-carbon disc — 0.164 m radius against RIM_RADIUS 0.2286, so it
 * fills 72 % of the 457 mm rim opening, which is what a real front corner does.
 */
export const DISC_RADIUS = 0.1640;
/** Fraction of DISC_RADIUS where the pad actually sweeps. */
const DISC_BAND_IN = 0.615;

/**
 * Carbon-carbon brake disc: a drilled annulus (real through-holes so the heat
 * glow reads through the wheel-cover slots) plus the mounting bell.
 */
function buildBrakeDiscGeometry(high) {
  const rOuter = DISC_RADIUS, rInner = 0.0980, thick = 0.032;
  const parts = [];

  const shape = new THREE.Shape(circlePoly(rOuter, 84));
  shape.holes.push(new THREE.Path(circlePoly(rInner, 40, 0, 0, true)));

  if (high) {
    // Two staggered rings of cooling drillings.
    for (const [radius, count, phase] of [[0.1165, 40, 0], [0.1440, 48, 0.5]]) {
      for (let i = 0; i < count; i++) {
        const a = ((i + phase) / count) * Math.PI * 2;
        shape.holes.push(new THREE.Path(
          circlePoly(0.0058, 7, Math.cos(a) * radius, Math.sin(a) * radius, true)
        ));
      }
    }
  }

  const disc = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  disc.translate(0, 0, -thick / 2);
  disc.rotateY(Math.PI / 2);
  parts.push(disc);

  return mergeGeometries(parts);
}

/**
 * The top-hat the disc hangs off. Kept OUT of the disc mesh: only the friction
 * band glows, and a bell that glowed with it would kill the effect.
 */
function buildBrakeBellGeometry() {
  const parts = [];
  const bell = new THREE.CylinderGeometry(0.058, 0.066, 0.060, 20, 1, true);
  bell.rotateZ(-Math.PI / 2);
  bell.translate(-0.030, 0, 0);
  parts.push(bell);
  const web = new THREE.RingGeometry(0.062, 0.101, 24, 1);
  web.rotateY(Math.PI / 2);
  parts.push(web);
  // Drive pegs into the disc's inner diameter.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const peg = new THREE.BoxGeometry(0.030, 0.018, 0.014);
    peg.translate(0, 0.104, 0);
    peg.rotateX(a);
    parts.push(peg);
  }
  return mergeGeometries(parts);
}

/** Six-piston monobloc caliper, clamped over the top-rear of the disc. */
function buildCaliperGeometry(side) {
  const parts = [];
  const R = 0.170;
  const body = new THREE.BoxGeometry(0.086, 0.130, 0.058);
  body.translate(0, R, -0.036);
  parts.push(body);
  const bridge = new THREE.BoxGeometry(0.068, 0.130, 0.052);
  bridge.translate(0, R, 0.038);
  parts.push(bridge);
  const spine = new THREE.BoxGeometry(0.060, 0.046, 0.140);
  spine.translate(0, R + 0.046, 0);
  parts.push(spine);
  // Piston bosses.
  for (let i = 0; i < 3; i++) {
    for (const s of [-1, 1]) {
      const p = new THREE.CylinderGeometry(0.019, 0.019, 0.018, 12);
      p.rotateZ(Math.PI / 2);
      p.translate(s * 0.048, R - 0.004, -0.038 + i * 0.038);
      parts.push(p);
    }
  }
  // Brake line union.
  const line = new THREE.CylinderGeometry(0.006, 0.006, 0.060, 8);
  line.rotateX(Math.PI / 2);
  line.translate(0, R + 0.056, -0.046);
  parts.push(line);

  const g = mergeGeometries(parts);
  g.translate(side * 0.010, 0, 0);
  return g;
}

/** Machined upright: hub carrier with top/bottom clevises and a steering arm. */
function buildUprightGeometry(front) {
  const parts = [];
  const main = new THREE.CylinderGeometry(0.058, 0.058, 0.072, 16);
  main.rotateZ(Math.PI / 2);
  parts.push(main);

  const web = new THREE.BoxGeometry(0.048, 0.250, 0.070);
  parts.push(web);

  for (const s of [1, -1]) {
    const clevis = new THREE.BoxGeometry(0.062, 0.058, 0.086);
    clevis.translate(0, s * 0.132, 0);
    parts.push(clevis);
    const pin = new THREE.CylinderGeometry(0.011, 0.011, 0.080, 10);
    pin.rotateX(Math.PI / 2);
    pin.translate(0, s * 0.132, 0);
    parts.push(pin);
  }

  // Steering / toe-link arm.
  const arm = new THREE.BoxGeometry(0.040, 0.048, 0.075);
  arm.translate(0, -0.030, front ? -0.090 : 0.090);
  parts.push(arm);

  return mergeGeometries(parts);
}

/**
 * Brake drum assembly: the inboard fairing that ducts air over the disc, the
 * outer fence that seals the wake, an inlet scoop and the internal vanes.
 */
function buildBrakeDuctGeometry(side, front, high, halfWidth) {
  const parts = [];
  const out = side;                       // +1 towards the outside of the car
  const inner = -out * (halfWidth * 0.86);  // inboard face of the wheel
  const fore = front ? -1 : 1;
  // The drum now wraps 1.72*pi. It used to wrap 1.30*pi with its mouth on the
  // rear-upper sector, which is exactly where a front-outboard camera looks
  // THROUGH the cover slot ring — so the aperture showed sky.
  const T0 = Math.PI * 0.14, TL = Math.PI * 1.72;

  const drum = new THREE.CylinderGeometry(0.194, 0.194, 0.150, 40, 1, true, T0, TL);
  drum.rotateZ(-Math.PI / 2);
  drum.translate(-out * 0.020, 0, 0);
  parts.push(drum);

  // Inner liner. An open-ended cylinder only has outward normals, so from
  // outboard — looking through the cover slots at the far wall of the drum — the
  // drum was backface-culled and contributed nothing. The liner is the surface
  // you actually see inside the aperture.
  const liner = flipFaces(new THREE.CylinderGeometry(0.1925, 0.1925, 0.148, 40, 1, true, T0, TL));
  liner.rotateZ(-Math.PI / 2);
  liner.translate(-out * 0.020, 0, 0);
  parts.push(liner);

  // FULL-CIRCLE BACKPLATE. This is the single thing that stops the wheel
  // reading as a hole: behind the disc there is now dark carbon in every
  // direction, so the slot ring frames a glowing disc against a shadowed drum
  // instead of framing daylight. Two rings back to back — RingGeometry is
  // single sided and the wheel is seen from both flanks.
  for (const n of [1, -1]) {
    const plate = new THREE.RingGeometry(0.022, 0.1945, 48, 1);
    plate.rotateY(n * out * Math.PI / 2);
    plate.translate(-out * (0.093 + (n > 0 ? 0 : 0.0015)), 0, 0);
    parts.push(plate);
  }

  // --- outboard shroud -----------------------------------------------------
  // MEASURED FROM THE FRAME, not assumed: at `wheel` the cover's slot ring was
  // showing the yellow caliper and a lit background patch straight through it.
  // The backplate above is 215 mm behind the cover face, and a sight line into a
  // slot is oblique — at 25 deg it drifts 100 mm radially over that distance, so
  // it clears the drum mouth (r 0.194) and the plate edge alike and comes out in
  // daylight. Nothing 200 mm back can close a 6 mm slit; the closure has to sit
  // just behind the slits.
  //
  // So: a top-hat backing 30-86 mm inboard of the cover face, full circle, from
  // the barrel bore right across to the hub. Every slot now looks into a
  // shadowed conical recess about 40 mm deep — real machined depth — and because
  // this is the DUCT material it carries the disc's radial glow bleed, which is
  // what actually reads through a spinning slot ring on a real car. You never
  // see the disc itself through a 6 mm slit at 120 mm; you see the drum interior
  // it is cooking.
  const sx = (d) => out * (halfWidth * 0.80 - d);
  const SHROUD = [[0.2085, 0.1180, 0.030, 0.068], [0.1180, 0.0200, 0.068, 0.086]];
  for (const [rA, rB, dA, dB] of SHROUD) {
    // `rotateZ(-pi/2)` puts radiusTop at +X, so the OUTBOARD radius has to be
    // handed to `radiusTop` on the +X side and to `radiusBottom` on the -X side.
    // Mirroring with `scale(-1,1,1)` instead would invert the winding.
    const cone = new THREE.CylinderGeometry(out > 0 ? rA : rB, out > 0 ? rB : rA,
      Math.abs(sx(dA) - sx(dB)), 56, 1, true);
    cone.rotateZ(-Math.PI / 2);
    cone.translate(sx((dA + dB) / 2), 0, 0);
    parts.push(cone);
  }

  // Twelve shallow ribs on the shroud cone, clocked half a pitch off the cover
  // slots so a slot always frames a rib edge rather than dead flat carbon. This
  // is the only structure in the aperture when the brakes are cold.
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    const rib = new THREE.BoxGeometry(0.040, 0.088, 0.0075);
    rib.translate(0, 0.163, 0);
    rib.rotateX(a);
    rib.translate(out * (halfWidth * 0.80 - 0.052), 0, 0);
    parts.push(rib);
  }

  // Inboard fence plate — the visible carbon "cake tin" behind the wheel.
  const fence = new THREE.BoxGeometry(0.011, 0.300, 0.330);
  fence.translate(inner - out * 0.012, -0.010, fore * 0.015);
  parts.push(fence);

  // --- forward-facing inlet ------------------------------------------------
  // The most recognisable front-corner detail after the wishbones, and it was
  // previously a box buried at |z| = 0.18 — INSIDE a tyre of radius 0.36, so it
  // could never be seen from anywhere. It has to reach past the tyre's leading
  // edge (|z| = 0.34 at this height) and sit inboard of the inner sidewall,
  // which is where a real duct mouth lives: in the gap between tyre and floor.
  const mouthRing = (z, cx, cy, w, h, k) => {
    const pts = [];
    const N = 14;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      const s = 1 / Math.pow(Math.abs(ca) ** k + Math.abs(sa) ** k, 1 / k);
      pts.push(new THREE.Vector3(cx + ca * s * w, cy + sa * s * h, z));
    }
    return pts;
  };
  const sections = [
    mouthRing(fore * 0.392, inner - out * 0.034, -0.048, 0.040, 0.072, 3.4),
    mouthRing(fore * 0.330, inner - out * 0.030, -0.050, 0.043, 0.074, 3.2),
    mouthRing(fore * 0.235, inner - out * 0.020, -0.056, 0.048, 0.070, 2.8),
    mouthRing(fore * 0.130, inner + out * 0.004, -0.062, 0.052, 0.062, 2.4),
    mouthRing(fore * 0.040, inner + out * 0.030, -0.058, 0.052, 0.056, 2.2),
  ];
  // `loft` winds by (ring tangent) x (row direction); the rings are CCW in XY,
  // so the rows must run in +Z for the normals to face out.
  if (fore > 0) sections.reverse();
  const inlet = loft(sections, { closed: true, caps: false });
  inlet.computeVertexNormals();   // `mergeGeometries` needs every part to carry them
  parts.push(inlet);

  // Bell-mouth lip and the mouth splitter, so the inlet reads as an opening.
  const lip = new THREE.TorusGeometry(0.056, 0.0055, 6, 20);
  lip.scale(0.76, 1.30, 1);
  lip.translate(inner - out * 0.034, -0.048, fore * 0.392);
  parts.push(lip);
  const splitter = new THREE.BoxGeometry(0.062, 0.006, 0.070);
  splitter.translate(inner - out * 0.032, -0.048, fore * 0.360);
  parts.push(splitter);

  if (high) {
    // Internal turning vanes. Now spread over the full wrap and pushed out to
    // r = 0.170 so they sit directly behind the cover's slot ring and read as
    // machined depth through it.
    for (let i = 0; i < 9; i++) {
      const a = T0 + TL * ((i + 0.5) / 9);
      const v = new THREE.BoxGeometry(0.108, 0.048, 0.008);
      v.translate(0, 0.170, 0);
      v.rotateX(a + Math.PI / 2);
      v.rotateY(out * 0.22);
      v.translate(-out * 0.030, 0, 0);
      parts.push(v);
    }
    // Louvres on the inboard fence.
    for (let i = 0; i < 4; i++) {
      const w = new THREE.BoxGeometry(0.048, 0.007, 0.075);
      w.translate(0, -0.075 + i * 0.055, fore * 0.075);
      w.rotateZ(out * 0.14);
      w.translate(inner - out * 0.040, 0, 0);
      parts.push(w);
    }
  }

  return mergeGeometries(parts);
}

/**
 * A unit-length aerofoil-section suspension member along +Y, chord along +Z.
 * Real F1 wishbones are teardrop fairings, not tubes — this is most of the
 * reason the linkage reads as a racing car rather than a toy.
 */
function buildAeroLinkGeometry(chord, thick) {
  const N = 9;
  const ring = [];
  const yt = (u) => thick * (1.4845 * Math.sqrt(u) - 0.63 * u - 1.758 * u * u + 1.4215 * u ** 3 - 0.5075 * u ** 4);
  for (let i = 0; i < N; i++) {
    const u = 0.5 - 0.5 * Math.cos((i / (N - 1)) * Math.PI);
    ring.push([yt(u), (u - 0.34) * chord]);
  }
  for (let i = N - 2; i >= 1; i--) {
    const u = 0.5 - 0.5 * Math.cos((i / (N - 1)) * Math.PI);
    ring.push([-yt(u), (u - 0.34) * chord]);
  }

  const M = ring.length;
  const pos = [], uv = [], idx = [];
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < M; i++) {
      pos.push(ring[i][0], r, ring[i][1]);
      uv.push(i / M, r);
    }
  }
  for (let i = 0; i < M; i++) {
    const a = i, b = (i + 1) % M, c = M + i, d = M + ((i + 1) % M);
    idx.push(a, c, b, b, c, d);
  }
  // Caps.
  const base = pos.length / 3;
  for (let r = 0; r < 2; r++) {
    for (let i = 0; i < M; i++) { pos.push(ring[i][0], r, ring[i][1]); uv.push(0.5, 0.5); }
  }
  for (let r = 0; r < 2; r++) {
    const o = base + r * M;
    for (let i = 1; i < M - 1; i++) {
      if (r === 0) idx.push(o, o + i + 1, o + i);
      else idx.push(o, o + i, o + i + 1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Irregular rubber marble picked up off-line, instanced around the shoulder. */
function buildMarbleGeometry() {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const rng = makeRng(hashSeed('wheels/marble'));
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.72 + rng() * 0.55;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * k * 0.8, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Angularly averaged rim, used as a cheap rotation-blur overlay. */
function blurTexture() {
  return assets.texture('wheels/blur', () => {
    const N = 256, R = N / 2;
    const { c, x } = canvas2d(N, N);
    x.clearRect(0, 0, N, N);
    const rings = [
      [0.00, 0.20, 'rgba(150,152,158,0.00)'],
      [0.20, 0.30, 'rgba(120,122,130,0.55)'],
      [0.30, 0.36, 'rgba(60,62,68,0.75)'],
      [0.36, 0.76, 'rgba(96,98,106,0.62)'],
      [0.76, 0.92, 'rgba(150,153,160,0.80)'],
      [0.92, 0.99, 'rgba(190,193,200,0.92)'],
    ];
    for (const [a, b, col] of rings) {
      x.fillStyle = col;
      x.beginPath();
      x.arc(R, R, b * R, 0, Math.PI * 2);
      x.arc(R, R, a * R, 0, Math.PI * 2, true);
      x.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

// ---------------------------------------------------------------------------
// Blackbody ramp for the carbon discs
// ---------------------------------------------------------------------------

/**
 * Absolute EXPOSED radiance of the friction band, [t, r, g, b].
 *
 * Two things were wrong before. The peak was `(1, 0.82, 0.56) x 9.5` — nine
 * times diffuse white and almost achromatic — so ACES clipped it and the glow
 * came out as a white blob with no colour information whatsoever, which is the
 * entire point of a heat ramp. And carbon-carbon at working temperature is
 * ~1000-1300 K: DEEP ORANGE. It never goes white; a white brake disc is a
 * 3000 K tungsten filament.
 *
 * Peak here is (2.55, 0.72, 0.09), luminance 1.06 — it sits just UNDER the 1.25
 * bloom threshold in luminance while its red channel is 2x over it, so the ring
 * blooms red-orange and the green/blue channels never clip. `postfx` authors the
 * threshold in exposed units, so these are exposed units too.
 */
const HEAT_RAMP = [
  [0.00, 0.000, 0.000, 0.000],
  [0.22, 0.090, 0.004, 0.001],
  [0.42, 0.420, 0.026, 0.003],
  [0.62, 0.980, 0.096, 0.010],
  [0.82, 1.680, 0.300, 0.030],
  [1.00, 2.550, 0.720, 0.090],
];

const _heat = new THREE.Color();

/** Sample HEAT_RAMP into `out` (linear-sRGB radiance). */
function heatRadiance(t01, out) {
  const t = clamp(t01, 0, 1);
  let i = 0;
  while (i < HEAT_RAMP.length - 2 && t > HEAT_RAMP[i + 1][0]) i++;
  const a = HEAT_RAMP[i], b = HEAT_RAMP[i + 1];
  const k = (t - a[0]) / (b[0] - a[0] || 1);
  return out.setRGB(lerp(a[1], b[1], k), lerp(a[2], b[2], k), lerp(a[3], b[3], k),
    THREE.LinearSRGBColorSpace);
}

/**
 * Drive one disc's heat. The glow is RADIAL and lives in the shader (see
 * `_discMaterial`): the bell is near-black, the pad sweep is the hot ring, and
 * the outer 7 % sheds into the airstream. The two uniforms are the radiance at
 * the hottest point and at the cooler shoulders of the band — sampling the same
 * ramp at 0.60 t gives the shoulder colour for free, so the ring always has an
 * orange-to-cherry gradient across it rather than one flat colour.
 */
function applyHeat(material, t01, glazes = true) {
  const t = clamp(t01, 0, 1);
  const u = material.userData.heatUniforms;
  if (u) {
    heatRadiance(t, _heat);
    u.uGlowHot.value.copy(_heat);
    heatRadiance(t * 0.60, _heat);
    u.uGlowCool.value.copy(_heat);
  }
  material.userData.heat = t;
  // Hot carbon also loses its matte look as the surface glazes. A duct fairing
  // taking the same heat signal does NOT — it is a cold carbon part.
  if (glazes) material.roughness = 0.72 - t * 0.24;
}

// ---------------------------------------------------------------------------
// Link orientation
// ---------------------------------------------------------------------------

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _side = new THREE.Vector3();
const _chord = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _up = new THREE.Vector3(0, 1, 0);
const _flow = new THREE.Vector3(0, 0, -1);   // car-local airflow direction

/**
 * Place a unit link between two points with its aerofoil chord aligned to the
 * airflow (car -Z) rather than an arbitrary roll.
 */
function orientLink(mesh, from, to) {
  _dir.subVectors(to, from);
  const len = _dir.length() || 1e-4;
  _dir.divideScalar(len);
  _chord.copy(_flow).addScaledVector(_dir, -_flow.dot(_dir));
  if (_chord.lengthSq() < 1e-6) _chord.set(1, 0, 0).addScaledVector(_dir, -_dir.x);
  _chord.normalize();
  _side.crossVectors(_dir, _chord).normalize();
  _m.makeBasis(_side, _dir, _chord);
  mesh.position.copy(from);
  mesh.quaternion.setFromRotationMatrix(_m);
  mesh.scale.set(1, len, 1);
}

// ---------------------------------------------------------------------------

export class WheelSet {
  constructor(materials, opts) {
    this.materials = materials;
    this.opts = opts;
    this.group = new THREE.Group();
    this.group.name = 'Wheels';
    this.wheels = [];
    this.compound = 'soft';
    this.steerAngle = 0;
    this.blur = 0;
    this.pickup = 0.30;
    this.high = (opts.detail ?? 'high') === 'high';

    const high = this.high;
    const maps = tyreMaps(this.compound);

    const geoKey = (n) => `wheels/${n}`;
    const tyreGeo = {
      front: assets.geometry(geoKey(`tyre/${TYRE_HALF_WIDTH_FRONT}/slick`), () => buildTyreGeometry(TYRE_HALF_WIDTH_FRONT, false)),
      rear: assets.geometry(geoKey(`tyre/${TYRE_HALF_WIDTH_REAR}/slick`), () => buildTyreGeometry(TYRE_HALF_WIDTH_REAR, false)),
    };
    tyreGeo.frontM = assets.geometry(geoKey(`tyre/${TYRE_HALF_WIDTH_FRONT}/slick/m`), () => mirrorU(tyreGeo.front));
    tyreGeo.rearM = assets.geometry(geoKey(`tyre/${TYRE_HALF_WIDTH_REAR}/slick/m`), () => mirrorU(tyreGeo.rear));
    this._tyreGeo = tyreGeo;

    const marbleGeo = assets.geometry(geoKey('marble'), buildMarbleGeometry);

    // Per-corner tyre materials: each carries its own spin/squash/heat state.
    this.tyreMaterials = [];
    this.discMaterials = [];
    this.ductMaterials = [];

    const corners = [
      { front: true, side: -1, z: opts.frontZ, track: opts.frontTrack },
      { front: true, side: 1, z: opts.frontZ, track: opts.frontTrack },
      { front: false, side: -1, z: opts.rearZ, track: opts.rearTrack },
      { front: false, side: 1, z: opts.rearZ, track: opts.rearTrack },
    ];

    for (const c of corners) {
      const hw = c.front ? TYRE_HALF_WIDTH_FRONT : TYRE_HALF_WIDTH_REAR;
      const hubX = c.side * c.track / 2;
      const travelPivot = new THREE.Group();
      travelPivot.position.set(hubX, TYRE_RADIUS - TYRE_SQUASH_STATIC, c.z);
      const steerPivot = new THREE.Group();
      const spinGroup = new THREE.Group();
      travelPivot.add(steerPivot);
      steerPivot.add(spinGroup);
      this.group.add(travelPivot);

      // --- tyre ----------------------------------------------------------
      const tyreMat = this._makeTyreMaterial(maps, hw);
      this.tyreMaterials.push(tyreMat);
      const tyre = new THREE.Mesh(c.side > 0 ? tyreGeo[c.front ? 'front' : 'rear'] : tyreGeo[c.front ? 'frontM' : 'rearM'], tyreMat);
      tyre.scale.x = c.side;      // v = 1 (the lettered bead) always faces out
      tyre.castShadow = true;
      tyre.receiveShadow = true;
      spinGroup.add(tyre);

      const bandMat = this._bandMaterial();
      const band = new THREE.Mesh(assets.geometry(geoKey(`band/${hw}`), () => buildBandGeometry(hw)), bandMat);
      band.scale.x = c.side;
      spinGroup.add(band);

      // SHADOW BUDGET. Everything from here to the brake duct lives INSIDE the
      // tyre or immediately behind it, so its shadow is entirely contained in the
      // tyre's own. With four cascades and twenty cars each of these cost four
      // extra draw calls per frame for a silhouette nobody can see: the wheels
      // alone were ~1900 of the ~3600 calls in the `front` frame. The tyre casts,
      // the rest do not.
      // --- rim -----------------------------------------------------------
      if (high) {
        const barrel = new THREE.Mesh(assets.geometry(geoKey(`barrel/${hw}`), () => buildRimBarrelGeometry(hw)), materials.darkMetal);
        barrel.scale.x = c.side;
        spinGroup.add(barrel);

        const cover = new THREE.Mesh(assets.geometry(geoKey(`cover/${hw}`), () => buildWheelCoverGeometry(hw)), this._coverMaterial());
        cover.scale.x = c.side;
        spinGroup.add(cover);

        const flange = new THREE.Mesh(assets.geometry(geoKey(`flange/${hw}`), () => buildRimFlangeGeometry(hw)), this._flangeMaterial());
        flange.scale.x = c.side;
        spinGroup.add(flange);

        const nut = new THREE.Mesh(assets.geometry(geoKey(`nut/${hw}`), () => buildWheelNutGeometry(hw)), this._nutMaterial());
        nut.scale.x = c.side;
        spinGroup.add(nut);
      } else {
        // One mesh for the whole wheel at distance. The barrel and the nut live
        // inside the tyre, so the COVER material is the one that has to be
        // right: a dark-metal disc at 70 m loses the team colour that reads at 3 m.
        const rim = new THREE.Mesh(assets.geometry(geoKey(`rimLow/${hw}`), () => mergeGeometries([
          buildRimBarrelGeometry(hw), buildWheelCoverGeometry(hw), buildWheelNutGeometry(hw),
          buildRimFlangeGeometry(hw),
        ])), this._coverMaterial());
        rim.scale.x = c.side;
        spinGroup.add(rim);
      }

      // --- brakes --------------------------------------------------------
      const discMat = this._discMaterial();
      this.discMaterials.push(discMat);
      const disc = new THREE.Mesh(assets.geometry(geoKey(`disc/${high ? 'hi' : 'lo'}`), () => buildBrakeDiscGeometry(high)), discMat);
      disc.scale.x = c.side;
      spinGroup.add(disc);

      // --- upright / caliper / duct (steer but do not spin) --------------
      const upright = new THREE.Mesh(
        assets.geometry(geoKey(`upright/${c.front}`), () => buildUprightGeometry(c.front)),
        materials.titanium
      );
      upright.position.x = -c.side * 0.055;
      steerPivot.add(upright);

      const caliper = new THREE.Mesh(
        assets.geometry(geoKey(`caliper/${c.side}`), () => buildCaliperGeometry(c.side)),
        materials.caliper
      );
      steerPivot.add(caliper);

      const ductMat = this._ductMaterial(c.side);
      this.ductMaterials.push(ductMat);
      const duct = new THREE.Mesh(
        assets.geometry(geoKey(`duct/${c.side}/${c.front}/${high}`), () => buildBrakeDuctGeometry(c.side, c.front, high, hw)),
        ductMat
      );
      steerPivot.add(duct);

      // --- marbles + rotation blur (player detail only) -------------------
      let marbles = null, blurPlane = null;
      if (high) {
        const MARBLES = 34;
        marbles = new THREE.InstancedMesh(marbleGeo, this._marbleMaterial(), MARBLES);
        marbles.frustumCulled = false;
        const rng = makeRng(hashSeed(`marbles/${c.front}/${c.side}`));
        marbles.userData.slots = [];
        for (let i = 0; i < MARBLES; i++) {
          const a = rng() * Math.PI * 2;
          const v = rng() > 0.5 ? V_TREAD_OUT + 0.015 + rng() * 0.085 : V_TREAD_IN - 0.015 - rng() * 0.085;
          const [r, aF] = profileAtV(v);
          marbles.userData.slots.push({
            x: aF * hw * 1.02, y: Math.cos(a) * (r + 0.004), z: Math.sin(a) * (r + 0.004),
            s: 0.008 + rng() * 0.014,
          });
        }
        spinGroup.add(marbles);

        blurPlane = new THREE.Mesh(
          assets.geometry(geoKey('blurPlane'), () => new THREE.PlaneGeometry(RIM_RADIUS * 2, RIM_RADIUS * 2)),
          this._blurMaterial()
        );
        blurPlane.rotation.y = Math.PI / 2;
        blurPlane.position.x = c.side * (coverPlaneX(hw) + 0.026);
        blurPlane.visible = false;
        steerPivot.add(blurPlane);
      }

      // --- suspension linkage --------------------------------------------
      const links = this._cornerLinks(c, hubX);
      let linkMeshes = null;
      if (high) {
        const linkGeo = (chord, thick) => assets.geometry(geoKey(`link/${chord}/${thick}`), () => buildAeroLinkGeometry(chord, thick));
        linkMeshes = links.map((l) => {
          // SUSPENSION LINKS ARE LACQUERED BLACK CARBON, NOT BARE METAL and not
          // the pale floor weave either — see `_linkMaterial()`. `l.bare` is
          // left as the hook for anything that genuinely is exposed metal.
          const m = new THREE.Mesh(linkGeo(l.chord, l.thick), l.bare ? materials.titanium : this._linkMaterial());
          m.castShadow = true;
          this.group.add(m);
          return m;
        });
      }

      this.wheels.push({
        front: c.front, side: c.side, hubX, z: c.z, halfWidth: hw,
        restY: TYRE_RADIUS - TYRE_SQUASH_STATIC,
        travelPivot, steerPivot, spinGroup, links, linkMeshes,
        tyreMat, discMat, marbles, blurPlane,
        spin: 0, prevSpin: 0, travel: 0, squash: TYRE_SQUASH_STATIC,
      });
    }

    if (!high) this._buildStaticLinkage();

    this.setRubberPickup(this.pickup);
    this.setTyreTemp([85, 85, 85, 85]);
    this.setBrakeGlow(0);
    this._updateLinks();

    // The sim drives brake heat through the shared material bundle
    // (ai/opponents.js -> model.materials.setBrakeHeat). Forward it to the
    // per-corner discs so every corner can glow independently.
    const sharedSetBrakeHeat = materials.setBrakeHeat.bind(materials);
    this._restoreBrakeHeat = () => { materials.setBrakeHeat = sharedSetBrakeHeat; };
    materials.setBrakeHeat = (t) => { sharedSetBrakeHeat(t); this.setBrakeGlow(t); };
  }

  // -- material factories ---------------------------------------------------

  /**
   * Add a shader patch to a material WITHOUT throwing away the one it arrived
   * with. This is the reason the aero cover had no environment response at all.
   *
   * `materials.js` gives every car material a patched `onBeforeCompile` that
   * installs the per-material env gain and the grounded probe, and its `clone()`
   * is overridden to re-install it. Every factory below then did
   *
   *     const m = this.materials.paintSecondary.clone();
   *     m.onBeforeCompile = (shader) => { ...my patch... };
   *
   * which is a plain assignment over that own property. The cover, the disc, the
   * duct and the links therefore compiled with the STOCK envmap chunk: no gain
   * uniform, no horizon, and — because three overwrites `envMapIntensity` with
   * `scene.environmentIntensity` whenever a material has no `envMap` of its own
   * — the carefully measured `m.envMapIntensity = 0.38` on the cover was
   * silently replaced with 1.0 before every draw. Four materials, four
   * hand-tuned numbers, none of them reaching the GPU.
   *
   * Compose instead. Cache keys compose too, or two materials that differ only
   * in their own patch would share a program.
   */
  static _chainCompile(m, key, extra) {
    const prev = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') ? m.onBeforeCompile : null;
    const prevKey = m.customProgramCacheKey ? m.customProgramCacheKey() : '';
    m.onBeforeCompile = function chained(shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      extra.call(this, shader, renderer);
    };
    m.customProgramCacheKey = () => `${prevKey}|${key}`;
    return m;
  }

  /**
   * One corner's tyre.
   *
   * DERIVED FROM `materials.tyre`, NOT BUILT FROM SCRATCH, and that is a fix
   * rather than a tidy-up. A bare `MeshPhysicalMaterial` compiles with the stock
   * envmap chunk, and three overwrites `envMapIntensity` with
   * `scene.environmentIntensity` for any material that has no `envMap` of its
   * own — so the `0.85` that used to be set here was silently replaced by 2.15
   * before every draw, and the tyre (the largest object in most car frames) was
   * mirroring the sky at more than twice physical, with no horizon in the probe
   * and no way for `setTyreTemp` to change it. Cloning the bundle's patched
   * material inherits the gain uniform and the grounded probe; `_chainCompile`
   * then composes the squash/spin deformation ON TOP of that patch instead of
   * replacing it.
   */
  _makeTyreMaterial(maps, halfWidth) {
    const m = this.materials.tyre.clone();
    m.map = maps.map;
    m.normalMap = maps.normalMap;
    // 1.42 -> 0.72, against a Sobel run at 1.9 instead of 5.0 over grain laid on
    // at 0.38 instead of 0.66: about a seventh of round 5's slope, end to end.
    // The normal map is the millimetre grain and NOTHING ELSE; the
    // crown/shoulder/sidewall split is the roughness map's job.
    m.normalScale = new THREE.Vector2(0.72, 0.72);
    m.aoMap = m.roughnessMap = m.metalnessMap = maps.ormMap;
    m.roughness = 1.0;
    m.metalness = 0.0;
    m.color = new THREE.Color(0xffffff);
    // SHEEN IS A VELVET LOBE. It is retroreflective, it is applied uniformly over
    // the whole material, and it is INDEPENDENT of `roughnessMap` — so at 0.42 it
    // laid the same fuzzy grazing-angle glow over the crown, the shoulder and the
    // sidewall alike and cancelled most of the difference between them. Together
    // with round 5's normal noise that is the "coral / astroturf" reading: felt,
    // not rubber. Kept only as the faint dusty rim response real rubber has.
    m.sheen = 0.15;
    m.sheenRoughness = 0.80;
    m.sheenColor = new THREE.Color(0x33353d);
    setEnvGain(m, 0.85, 1.30);
    m.userData.uniforms = null;
    WheelSet._chainCompile(m, 'apex-tyre', (shader) => {
      shader.uniforms.uSpin = { value: 0 };
      shader.uniforms.uSquash = { value: TYRE_SQUASH_STATIC };
      shader.uniforms.uBulge = { value: 0.055 };
      shader.uniforms.uHalfWidth = { value: halfWidth };
      shader.vertexShader = `
        uniform float uSpin; uniform float uSquash; uniform float uBulge; uniform float uHalfWidth;
      ` + shader.vertexShader.replace('#include <begin_vertex>', `
        vec3 transformed = position;
        {
          float cs = cos(uSpin), sn = sin(uSpin);
          // spin group rotates about local X -> take the vertex to hub space
          float py = transformed.y * cs - transformed.z * sn;
          float pz = transformed.y * sn + transformed.z * cs;
          float R = ${TYRE_RADIUS.toFixed(4)};
          float floorY = -(R - uSquash);
          float contact = 1.0 - smoothstep(-R, -R * 0.62, py);
          if (py < floorY) py = floorY - (floorY - py) * 0.10;
          float sw = smoothstep(0.30, 1.0, abs(transformed.x) / uHalfWidth);
          transformed.x *= 1.0 + uBulge * contact * sw;
          transformed.y = py * cs + pz * sn;
          transformed.z = -py * sn + pz * cs;
        }
      `);
      m.userData.uniforms = shader.uniforms;
    });
    return m;
  }

  /**
   * The turned rim flange. Bare 7000-series aluminium, cut on a lathe: very
   * smooth, fully metallic, and anisotropic ALONG THE CUT — which on a lathed
   * ring is circumferential.
   *
   * The direction comes for free. `materials.metal` carries `brushDirectionMap`,
   * a constant (1, 0) tangent-space direction, and both primitives in
   * `buildRimFlangeGeometry` are surfaces of revolution whose `u` runs around the
   * circumference, so the anisotropic lobe smears the way a real turned surface
   * does without a bespoke map.
   */
  _flangeMaterial() {
    if (!this._flangeMat) {
      const m = this.materials.metal.clone();
      m.color = new THREE.Color(0xb6bac0);
      // `metal` is authored at 0.95 for cast suspension furniture; a machined
      // flange is a mirror by comparison, and it has to be, or the streak this
      // part exists for spreads into a flat grey band.
      m.roughness = 0.22;
      m.metalness = 1.0;
      m.anisotropy = 0.72;
      m.side = THREE.DoubleSide;      // see buildRimFlangeGeometry
      // A metal has no diffuse term at all, so the reflection IS the material.
      setEnvGain(m, 1.0, 1.35);
      this._flangeMat = m;
    }
    return this._flangeMat;
  }

  /** Anodised titanium centre-lock nut, clip and cover bolts. */
  _nutMaterial() {
    if (!this._nutMat) {
      const m = this.materials.titanium.clone();
      m.color = new THREE.Color(0x8d7f6e);
      m.roughness = 0.30;
      m.metalness = 1.0;
      m.anisotropy = 0.55;
      setEnvGain(m, 1.0, 1.30);
      this._nutMat = m;
    }
    return this._nutMat;
  }

  _bandMaterial() {
    if (!this._bandMat) {
      this._bandMat = new THREE.MeshPhysicalMaterial({
        color: bandColour(this.compound),
        roughness: 0.62, metalness: 0.0,
        clearcoat: 0.25, clearcoatRoughness: 0.5,
        envMapIntensity: 0.55,
      });
    }
    return this._bandMat;
  }

  _coverMaterial() {
    if (!this._coverMat) {
      // An aero cover is PAINTED BODYWORK in the team's base coat, not a carbon
      // part: it is a fairing bolted over the wheel and it is sprayed with the
      // rest of the car. Base off `paintSecondary` (which is `paint` minus the
      // livery canvas, so it keeps the flake clearcoat) and re-tint.
      const m = this.materials.paintSecondary.clone();
      // Recessed inside the wheel well, so it lives in the tyre's own shadow —
      // at full body-panel value it reads as a flat fluorescent plastic lid.
      //
      // The neutral blend is not decoration. A livery hex like #c8102e is linear
      // (0.575, 0.008, 0.028): the green and blue channels are essentially ZERO,
      // so under sun irradiance the red channel clips while the other two stay at
      // 0 and the part renders as pure #ff0000 plastic. Real automotive red has a
      // few per cent of broadband reflectance from the pigment binder, and it is
      // what stops the highlight going neon.
      //
      // MEASURED, and the previous 0.58 / 14 % pass was nowhere near enough: the
      // cover face came out rgb(221, 12, 27) mean over its whole area, saturation
      // 0.945, with 5.3 % of it clipped at 255 red. That is not a red object, it
      // is the red channel of the framebuffer. The reason is that the look grade
      // pushes saturation ABOUT LUMINANCE, and the luminance of a Rec.709 red is
      // almost all in G — so a pigment with G ~= 0 has `G - luma` strongly
      // negative and the grade drives it through zero and clamps. The albedo has
      // to carry enough broadband reflectance to survive that.
      //
      // So: scale the base coat down (it is recessed in a wheel well and it was
      // out-radiating the bodywork), then add a WHITE binder floor proportional to
      // the coat's own strongest channel. Proportional, not absolute, or a dark
      // livery gets washed to grey while a bright one stays neon.
      const base = liveryBaseColour(this.materials.paint);
      const mx = Math.max(base.r, base.g, base.b, 1e-4);
      //
      // Calibrated against the CAR, which is the only reference that matters:
      // at `wheel` the sidepod flank measures rgb(193, 77, 94), saturation 0.60.
      // At 0.30/0.30 the cover came out rgb(205, 37, 48) — same value, saturation
      // 0.82 — so it still out-radiated the bodywork in red and read as a
      // different, hotter material bolted to the same car. 0.25/0.54 lands it at
      // roughly 0.70, a shade deeper and a shade richer than the flank, which is
      // what a recessed part in the same paint should do.
      // Cross-checked at `beauty` too (golden hour, sun square on the cover):
      // 0.25/0.54 put the face at rgb(246, 122, 81), a salmon lid next to a red
      // car. The bodywork itself clips 86 % red in that frame, so matching it
      // exactly is not the goal — staying a shade under it, in hue, is.
      // RE-MEASURED AT INTEGRATION. 0.19 / 0.40 still photographed as a flat
      // salmon lid: rgb(205, 110, 118) across the cover face at `wheel`, lighter
      // in value than the tarmac it sits on and lighter than the sidepod above
      // it, so the whole wheel read as moulded plastic rather than a painted
      // part in a shadowed well. A wheel cover is 40 mm inside a barrel with a
      // tyre wall on both sides — it sees maybe a quarter of the hemisphere and
      // is the DARKEST painted surface on the car, not the brightest. Halving
      // the coat and trimming the binder puts it a stop and a half under the
      // flank, which is where a recessed part belongs; the team hue survives
      // because the binder floor is still proportional to the coat.
      //
      // ROUND 4. 0.095 is three stops under the flank, not one and a half, and
      // it is the number that produced "350 px of flat maroon with not one
      // highlight on it". Every previous pass here chased the same symptom —
      // "the cover is too bright / too saturated / too salmon" — by cutting the
      // ALBEDO, because the specular was never reaching the GPU to be cut
      // instead (see `_chainCompile`): the cover was compiling with the stock
      // envmap chunk at `scene.environmentIntensity` = 1.0 while this file
      // believed it was running at 0.38, and the only lever that appeared to do
      // anything was `K`. Six iterations of that leaves a black disc.
      //
      // With the gain actually bound, the split goes back where it belongs: a
      // real base coat (0.30, close to the bodywork, exactly as the review asked)
      // and the recess paid for by the specular and by COVER_SHADE_GLSL's well
      // gradient, which is what a recessed part physically is — same paint, less
      // sky.
      const K = 0.20;                 // base coat, referenced to the flank
      const BINDER = 0.32;            // broadband reflectance, fraction of `mx`
      m.color = base.multiplyScalar(K).addScalar(mx * K * BINDER);
      // A LACQUERED FAIRING, not a moulding. roughness 0.44 with a 0.30 coat is
      // a satin plastic lid; the cover is sprayed and polished with the rest of
      // the car and it is the one large surface on the corner whose normal
      // sweeps the WHOLE hemisphere between hub and flange, so a sharp coat over
      // a grounded probe draws a horizon arc straight across it and the arc
      // travels as the wheel moves. That is the highlight the critic could not
      // find anywhere on 350 px of it.
      m.roughness = 0.28;
      m.metalness = 0.0;
      m.clearcoat = 1.0;
      m.clearcoatRoughness = 0.085;
      // Now that this actually reaches the shader: a wheel well sees roughly a
      // quarter of the hemisphere, so the ambient term is cut hard while the
      // REFLECTION runs at the bodywork's own value — the well should darken the
      // fill, not delete the sky off a lacquered surface.
      setEnvGain(m, 0.55, 0.78);
      m.vertexColors = false;
      // The turning marks are carried in ROUGHNESS rather than by an
      // anisotropic lobe. three's anisotropy is driven by `anisotropyVector` in
      // TANGENT space plus an optional map, and this part is an `ExtrudeGeometry`
      // whose UVs are Cartesian — there is no tangent frame here in which 'along
      // the cut' is a constant direction, so a map would need a bespoke polar
      // unwrap for a 45 mm annulus. A per-fragment roughness corduroy at the
      // real tool pitch buys the same read for one sine.
      WheelSet._chainCompile(m, 'apex-wheelcover', (shader) => {
        shader.vertexShader = 'varying float vCoverR;\nvarying float vCoverA;\n' + shader.vertexShader.replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vCoverR = length(position.yz) * ${(1 / COVER_OUTER).toFixed(5)};
           vCoverA = atan(position.z, position.y);`
        );
        shader.fragmentShader = 'varying float vCoverR;\nvarying float vCoverA;\n' + shader.fragmentShader
          .replace('#include <color_fragment>', `#include <color_fragment>\n${COVER_SHADE_GLSL}`)
          .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${COVER_ROUGH_GLSL}`);
      });
      this._coverMat = m;
    }
    return this._coverMat;
  }

  /**
   * Suspension links. `carbonMatte` is authored for the FLOOR — albedo 0xdad8d6
   * over a pale weave, tiled 3.4x for bodywork-scale UVs — and on a 60 mm
   * aerofoil catching the sun square-on it integrates to near-white: the
   * critics' "bare silver slats". A wishbone fairing is lacquered black carbon,
   * so pull the albedo to a real carbon value and retile the weave for a part
   * whose UVs run 0..1 across a 130 mm perimeter and 0..1 along ~0.45 m.
   */
  _linkMaterial() {
    if (!this._linkMat) {
      const m = this.materials.carbonMatte.clone();
      // The ORM is one texture in three slots — clone it ONCE or the part costs
      // three samplers for one image.
      const seen = new Map();
      for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'clearcoatNormalMap']) {
        const t = m[k];
        if (!t) continue;
        let c = seen.get(t);
        if (!c) {
          c = t.clone();
          c.repeat.set(0.55, 1.85);
          c.needsUpdate = true;
          seen.set(t, c);
        }
        m[k] = c;
      }
      m.color = new THREE.Color(0x3a3b3f);
      m.roughness = 1.0;
      m.metalness = 0.10;
      m.normalScale = new THREE.Vector2(0.55, 0.55);
      m.clearcoat = 0.65;
      m.clearcoatRoughness = 0.24;
      setEnvGain(m, 0.90, 0.72);
      this._linkMat = m;
    }
    return this._linkMat;
  }

  /**
   * One brake disc. The incandescence is a RADIAL RAMP evaluated in the shader
   * from the vertex's own disc radius, not a flat emissive on the whole part.
   *
   * A flat emissive is what produced "two small blown-out white blobs": the bell,
   * the drive pegs and the vent walls all glowed as hard as the friction band, so
   * the only shape the eye could find was the outline of the cover slot. With a
   * ramp the bell stays black carbon and the pad sweep is a distinct ring, which
   * is exactly what you see through the slots on a real car under braking.
   *
   * The radius comes from object-space `position.yz`, so it survives the spin
   * group's rotation about X and the per-side `scale.x = ±1` for free.
   */
  _discMaterial() {
    const m = this.materials.brakeDisc.clone();
    // Carbon-carbon is a warm mid grey once bedded in — a near-black disc simply
    // disappears behind the wheel cover.
    m.color = new THREE.Color(0x585450);
    m.roughness = 0.72;
    m.metalness = 0.22;
    setEnvGain(m, 0.85, 1.30);
    // The ramp owns emissive outright; leave the built-in term at zero.
    m.emissive = new THREE.Color(0x000000);
    m.emissiveIntensity = 1.0;
    m.userData.heat = 0;
    m.userData.heatUniforms = null;
    WheelSet._chainCompile(m, 'apex-brakedisc', (shader) => {
      shader.uniforms.uGlowHot = { value: new THREE.Color(0, 0, 0) };
      shader.uniforms.uGlowCool = { value: new THREE.Color(0, 0, 0) };
      shader.vertexShader = 'varying float vDiscR;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vDiscR = length(position.yz) * ${(1 / DISC_RADIUS).toFixed(5)};`
      );
      shader.fragmentShader = `
        uniform vec3 uGlowHot; uniform vec3 uGlowCool; varying float vDiscR;
      ` + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // Near-black at the bell, full heat across the pad sweep, and the
           // last 7 % of the radius dumps into the airstream.
           float g = smoothstep(${DISC_BAND_IN.toFixed(3)}, 0.790, vDiscR);
           g *= 1.0 - 0.34 * smoothstep(0.930, 1.005, vDiscR);
           totalEmissiveRadiance += mix(uGlowCool, uGlowHot, smoothstep(0.12, 0.96, g)) * g;
         }`
      );
      m.userData.heatUniforms = shader.uniforms;
      applyHeat(m, m.userData.heat);
    });
    return m;
  }

  /**
   * The brake drum, with the disc's own glow bleeding onto it.
   *
   * This is the other half of "the glow does not fill the wheel". A cover slot is
   * a 6 mm gap 120 mm in front of the disc, so at any oblique angle most slots
   * do not have line of sight to the friction band at all — three of twelve did,
   * and the other nine read as black holes. On a real car the whole aperture
   * glows, because a 1000 K disc radiates onto the drum liner and backplate it is
   * sitting inside. That is a one-bounce GI term; here it is a cheap analytic
   * one, banded to the same radii as the disc and at 0.20 of its radiance so the
   * disc still reads as the source.
   */
  _ductMaterial(side) {
    const m = this.materials.brakeDuct.clone();
    m.emissive = new THREE.Color(0x000000);
    m.emissiveIntensity = 1.0;
    m.userData.heat = 0;
    m.userData.heatUniforms = null;
    WheelSet._chainCompile(m, 'apex-brakeduct', (shader) => {
      shader.uniforms.uGlowHot = { value: new THREE.Color(0, 0, 0) };
      shader.uniforms.uGlowCool = { value: new THREE.Color(0, 0, 0) };
      shader.uniforms.uOut = { value: side };
      // `vDuctA` is object-space axial distance measured OUTBOARD. The geometry
      // bakes the side in, so the sign has to come back out through a uniform.
      shader.vertexShader = 'varying float vDuctR;\nvarying float vDuctA;\nuniform float uOut;\n' + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vDuctR = length(position.yz) * ${(1 / DISC_RADIUS).toFixed(5)};
         vDuctA = position.x * uOut;`
      );
      shader.fragmentShader = `
        uniform vec3 uGlowHot; uniform vec3 uGlowCool; varying float vDuctR; varying float vDuctA;
      ` + shader.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           // Banded to sit UNDER the cover's vent ring (r 0.146..0.192, i.e.
           // 0.89..1.17 of DISC_RADIUS) — with the shroud closing the aperture
           // this is the glow you actually see through the slots, so the band
           // has to be where the slots are rather than where the disc is.
           float g = smoothstep(0.44, 0.86, vDuctR) * (1.0 - smoothstep(1.20, 1.58, vDuctR));
           totalEmissiveRadiance += mix(uGlowCool, uGlowHot, 0.46) * g * 0.78;

           // Cold-brake aperture fill. With the brakes off there is no glow, and
           // the shroud 40 mm behind the vent ring gets no direct sun and no
           // bounce, so every slot rendered as a punched black hole — "reads as a
           // hole, not as machined depth", which is the finding. A real wheel is
           // open on its inboard side and through the duct mouth, so skylight
           // does reach the drum: this is that one bounce, weighted by how far
           // OUTBOARD the surface is (only the shroud sees the aperture) and by
           // how much sky its normal faces. Small — it lifts black to charcoal
           // and lets the cone and its ribs shade, nothing more.
           vec3 wN = inverseTransformDirection(normal, viewMatrix);
           float sky = 0.34 + 0.66 * clamp(wN.y * 0.5 + 0.5, 0.0, 1.0);
           // ROUND 5. 0.030 is a twentieth of a stop above black, so the twelve
           // slots still measured as dead holes. A wheel is open on its inboard
           // face, through the duct mouth and around the disc, and the drum
           // interior is a bright-ish carbon shroud a few centimetres from a
           // sunlit road — the bounce into it is real light, not a rounding
           // error. Ramped across the radius as well, because the shroud cone
           // nearest the vent ring is the part that actually sees out.
           //
           // ROUND 6, measured rather than guessed. Painting this term pure green
           // and re-shooting the wheel shot shows exactly which pixels in the
           // apertures belong to the shroud: a little over half of each slot, the
           // rest being the cover's own slot wall. At 0.086 the shroud half
           // measured p50 luma 8-40 on a 0-255 frame, i.e. still black, so the
           // slots read as punched holes rather than as a vent ring with a floor.
           // 2.4x puts the shroud into charcoal, where the cone, its twelve ribs
           // and the dark slot wall in front of them separate into three tones —
           // which is what makes an aperture read as DEPTH.
           float aperture = smoothstep(0.010, 0.070, vDuctA)
             * mix(0.55, 1.0, smoothstep(0.30, 1.10, vDuctR));
           totalEmissiveRadiance += vec3(0.207, 0.216, 0.242) * sky * aperture;
           // A warm floor from the road bounce, so a slot never reads as a
           // blue-grey card either.
           totalEmissiveRadiance += vec3(0.168, 0.117, 0.079) * aperture;
         }`
      );
      m.userData.heatUniforms = shader.uniforms;
      applyHeat(m, m.userData.heat, false);
    });
    return m;
  }

  _marbleMaterial() {
    if (!this._marbleMat) {
      this._marbleMat = new THREE.MeshStandardMaterial({
        color: 0x1a1a1c, roughness: 0.72, metalness: 0.0, envMapIntensity: 0.7,
      });
    }
    return this._marbleMat;
  }

  _blurMaterial() {
    if (!this._blurMat) {
      // THE ROTATION-BLUR OVERLAY HAS TO LOOK LIKE THE WHEEL IT IS BLURRING.
      //
      // `blurTexture()` is a neutral grey ring stack, and on an UNLIT
      // MeshBasicMaterial at 0.80 opacity it simply replaced the wheel face with
      // a flat mid-grey plate: measured off `tv`, the front wheel came out
      // rgb(68, 46, 70) — a lavender disc on a red car — where the cover under
      // it is rgb(42, 6, 21). Two errors compounding: the plate carried no team
      // colour, and being unlit it did not darken with the sun, so it also
      // glowed out of a shadowed wheel arch.
      //
      // It stays a MeshBasic (a blur overlay must not take a lighting pass of
      // its own, and the wheel spins ~0.8 of a revolution per frame, which no
      // 24-tap reconstruction filter can resolve), but it is tinted with the
      // cover's own base colour lifted toward neutral — an angular average of a
      // coloured wheel IS that colour, desaturated by the specular sweep — and
      // the peak opacity comes down so the cover reads through it.
      const cover = this._coverMaterial().color;
      const lift = 0.55;   // fraction of the average that is specular sweep
      const tint = cover.clone().multiplyScalar(1 - lift)
        .addScalar(Math.max(cover.r, cover.g, cover.b) * lift + 0.02);
      this._blurMat = new THREE.MeshBasicMaterial({
        map: blurTexture(), color: tint, transparent: true, opacity: 0,
        depthWrite: false, side: THREE.DoubleSide, toneMapped: true,
      });
    }
    return this._blurMat;
  }

  // -- linkage --------------------------------------------------------------

  /**
   * Pickup points for one corner.
   *   `a` chassis-side, car-local. `b` upright-side, relative to the hub.
   * Fronts are pushrod-actuated, rears pullrod-actuated (as on a modern car),
   * which is why the rear rocker pickup sits low and the front one high.
   */
  _cornerLinks(c, hubX) {
    const zi = c.z;
    const inX = c.side * (c.front ? 0.215 : 0.245);
    const outX = c.side * (c.track / 2 - 0.075) - hubX;
    const fore = c.front ? -1 : 1;
    return [
      // upper wishbone
      { a: new THREE.Vector3(inX * 0.80, 0.352, zi - 0.335), b: new THREE.Vector3(outX, 0.128, -0.020), chord: 0.062, thick: 0.020 },
      { a: new THREE.Vector3(inX * 0.80, 0.340, zi + 0.355), b: new THREE.Vector3(outX, 0.128, 0.020), chord: 0.062, thick: 0.020 },
      // lower wishbone
      { a: new THREE.Vector3(inX, 0.118, zi - 0.360), b: new THREE.Vector3(outX, -0.140, -0.022), chord: 0.072, thick: 0.024 },
      { a: new THREE.Vector3(inX, 0.112, zi + 0.385), b: new THREE.Vector3(outX, -0.140, 0.022), chord: 0.072, thick: 0.024 },
      // track rod / toe link
      { a: new THREE.Vector3(inX * 0.86, 0.205, zi + fore * 0.245), b: new THREE.Vector3(outX - c.side * 0.010, -0.030, fore * 0.092), chord: 0.048, thick: 0.015, steers: true },
      // pushrod (front) / pullrod (rear)
      c.front
        ? { a: new THREE.Vector3(inX * 0.62, 0.430, zi + 0.235), b: new THREE.Vector3(outX - c.side * 0.010, -0.128, 0.005), chord: 0.052, thick: 0.017, dark: true }
        : { a: new THREE.Vector3(inX * 0.62, 0.130, zi - 0.290), b: new THREE.Vector3(outX - c.side * 0.010, 0.120, 0.005), chord: 0.052, thick: 0.017, dark: true },
    ];
  }

  /** Distant cars get one merged, static linkage mesh instead of 24 movers. */
  _buildStaticLinkage() {
    const geo = assets.geometry('wheels/linkage/static', () => {
      const parts = [];
      const scratch = new THREE.Mesh(new THREE.BufferGeometry());
      for (const w of this.wheels) {
        for (const l of w.links) {
          const g = buildAeroLinkGeometry(l.chord, l.thick);
          _a.copy(l.a);
          _b.copy(l.b).add(w.travelPivot.position);
          orientLink(scratch, _a, _b);
          scratch.updateMatrix();
          g.applyMatrix4(scratch.matrix);
          parts.push(g);
        }
      }
      return mergeGeometries(parts);
    });
    // Same material as the per-corner links above, or the LOD swap changes the
    // colour of the suspension as a car crosses 70 m.
    const m = new THREE.Mesh(geo, this._linkMaterial());
    m.castShadow = true;
    this.group.add(m);
  }

  _updateLinks() {
    for (const w of this.wheels) {
      if (!w.linkMeshes) continue;
      const hub = w.travelPivot.position;
      for (let i = 0; i < w.links.length; i++) {
        const l = w.links[i];
        _a.copy(l.a);
        _b.copy(l.b);
        if (l.steers) _b.applyAxisAngle(_up, w.steerPivot.rotation.y);
        _b.add(hub);
        orientLink(w.linkMeshes[i], _a, _b);
      }
    }
  }

  // -- public API -----------------------------------------------------------

  setSteer(rad) {
    this.steerAngle = rad;
    for (const w of this.wheels) {
      if (!w.front) continue;
      // Ackermann: the inside wheel turns more.
      const ack = 1 + (w.side === Math.sign(rad) ? 0.14 : -0.10) * Math.min(1, Math.abs(rad) * 4);
      w.steerPivot.rotation.y = -rad * ack;
    }
    this._updateLinks();
  }

  /**
   * Absolute wheel angle per corner. The frame-to-frame delta also drives the
   * rotation blur, so no extra plumbing is needed to make wheels smear.
   */
  setSpin(angles) {
    let fastest = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      const d = Math.abs(angles[i] - w.spin);
      w.prevSpin = w.spin;
      w.spin = angles[i];
      w.spinGroup.rotation.x = angles[i];
      const u = w.tyreMat.userData.uniforms;
      if (u) u.uSpin.value = angles[i];
      // The physics wraps nothing, so guard against reset jumps.
      if (d < 3) fastest = Math.max(fastest, d);
    }
    // ~1/60 s per call; 0.9 rad/frame ~= 54 rad/s ~= 70 km/h.
    this._autoBlur = clamp((fastest - 0.55) / 1.5, 0, 1);
    if (this._blurOverride === undefined) this._applyBlur(this._autoBlur);
  }

  /** Travel in metres, positive = suspension compressed (wheel moves up). */
  setSuspension(travel) {
    for (let i = 0; i < 4; i++) {
      const w = this.wheels[i];
      w.travel = travel[i];
      // More load -> deeper contact patch and a fatter sidewall bulge.
      w.squash = clamp(TYRE_SQUASH_STATIC + travel[i] * 0.22, 0.0025, 0.020);
      w.travelPivot.position.y = TYRE_RADIUS - w.squash + travel[i];
      const u = w.tyreMat.userData.uniforms;
      if (u) {
        u.uSquash.value = w.squash;
        u.uBulge.value = 0.030 + (w.squash / 0.020) * 0.055;
      }
    }
    this._updateLinks();
  }

  setCompound(compound) {
    if (compound === this.compound || !COMPOUNDS.includes(compound)) return;
    const wasWet = WET_COMPOUNDS.has(this.compound);
    this.compound = compound;
    const maps = tyreMaps(compound);
    for (const m of this.tyreMaterials) {
      m.map = maps.map;
      m.normalMap = maps.normalMap;
      m.aoMap = m.roughnessMap = m.metalnessMap = maps.ormMap;
      m.needsUpdate = true;
    }
    this._bandMaterial().color.copy(bandColour(compound));

    // Wet compounds carry real tread blocks, so the carcass geometry changes.
    const isWet = WET_COMPOUNDS.has(compound);
    if (isWet !== wasWet) {
      const kind = isWet ? 'wet' : 'slick';
      for (const w of this.wheels) {
        const hw = w.halfWidth;
        const base = assets.geometry(`wheels/tyre/${hw}/${kind}`, () => buildTyreGeometry(hw, isWet));
        const geo = w.side > 0 ? base : assets.geometry(`wheels/tyre/${hw}/${kind}/m`, () => mirrorU(base));
        w.spinGroup.children.find((o) => o.material === w.tyreMat).geometry = geo;
      }
    }
  }

  /** 0..1 of peak disc temperature; scalar or per-corner. */
  setBrakeGlow(vals) {
    const arr = Array.isArray(vals) ? vals : [vals, vals, vals, vals];
    for (let i = 0; i < 4; i++) {
      // Fronts do ~65 % of the braking, so they run visibly hotter.
      // DISC_SOAK, and this is why there was no brake glow in any of the five
      // captures: a staged shot resets the cars, so `telemetry.brakeTemp` starts
      // at ambient and the discs render stone cold. A carbon-carbon disc in a
      // grand prix is NEVER cold — it is held between 400 and 900 C by its own
      // thermal mass for the whole lap, and it is dull cherry down the straights
      // as well as under braking. The soak is the floor of that band; the sim
      // still drives everything above it.
      const t = Math.max(clamp(arr[i], 0, 1), BRAKE_FLOOR, DISC_SOAK) * (i < 2 ? 1.0 : 0.82);
      applyHeat(this.discMaterials[i], t);
      if (this.ductMaterials[i]) applyHeat(this.ductMaterials[i], t, false);
    }
  }

  /**
   * Tyre carcass temperature in deg C. Hot rubber goes greasy and picks up a
   * wet-looking sheen; cold rubber is flat and matte.
   */
  setTyreTemp(temps) {
    for (let i = 0; i < 4; i++) {
      const t = clamp((temps[i] - 70) / 65, 0, 1);
      const m = this.tyreMaterials[i];
      // The MAP now owns the crown/shoulder/sidewall split (see `tyreMaps`), so
      // this is only the greasy film a hot carcass puts over all of it. At the
      // old 0.34 it multiplied the whole profile and flattened the very split
      // the map exists to draw.
      m.roughness = 1.0 - t * 0.15;
      m.sheen = 0.13 + t * 0.16;
      m.sheenRoughness = 0.84 - t * 0.22;
      // `envMapIntensity` is dead on this car — the IBL arrives via
      // `scene.environment`, so the renderer overwrites it every draw. The live
      // handle is the patched gain.
      setEnvGain(m, 0.85, 1.15 + t * 0.75);
    }
  }

  /** 0..1 marbles and rubber pickup on the tyre shoulders. */
  setRubberPickup(t) {
    this.pickup = clamp(t, 0, 1);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (const w of this.wheels) {
      if (!w.marbles) continue;
      const slots = w.marbles.userData.slots;
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i];
        const k = clamp(this.pickup * 1.4 - i / slots.length * 0.5, 0, 1);
        p.set(sl.x, sl.y, sl.z);
        s.setScalar(sl.s * k);
        m.compose(p, q, s);
        w.marbles.setMatrixAt(i, m);
      }
      w.marbles.instanceMatrix.needsUpdate = true;
      w.marbles.visible = this.pickup > 0.02;
    }
  }

  /** Manual override for the rotation blur; pass `null` to go back to auto. */
  setWheelBlur(t) {
    this._blurOverride = t === null || t === undefined ? undefined : clamp(t, 0, 1);
    this._applyBlur(this._blurOverride ?? this._autoBlur ?? 0);
  }

  _applyBlur(t) {
    if (this.blur === t) return;
    this.blur = t;
    if (!this._blurMat) return;
    // 0.80 buried the cover entirely; post's own velocity blur is already
    // smearing the wheel, so this only has to carry the part of the spin the
    // reconstruction filter cannot reach.
    this._blurMat.opacity = t * 0.55;
    const on = t > 0.02;
    for (const w of this.wheels) if (w.blurPlane) w.blurPlane.visible = on;
  }

  update() { /* the setters do all the work; nothing is time-integrated here */ }

  dispose() {
    this._restoreBrakeHeat?.();
    for (const m of this.tyreMaterials) m.dispose();
    for (const m of this.discMaterials) m.dispose();
    for (const m of this.ductMaterials) m.dispose();
    this._bandMat?.dispose();
    this._coverMat?.dispose();
    this._flangeMat?.dispose();
    this._nutMat?.dispose();
    for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap', 'clearcoatNormalMap']) {
      const t = this._linkMat?.[k];
      if (t && t !== this.materials.carbonMatte[k]) t.dispose();
    }
    this._linkMat?.dispose();
    this._marbleMat?.dispose();
    this._blurMat?.dispose();
  }
}

export function buildWheelSet(materials, opts) {
  const set = new WheelSet(materials, opts);
  (opts.chassis ?? new THREE.Group()).add(set.group);
  return set;
}
