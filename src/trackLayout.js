import * as THREE from 'three';

/**
 * Track layouts.
 *
 * Two closed circuits, both counter-clockwise:
 *
 *  CIRCUIT - the original racing circuit (~1.75 km, all tarmac):
 *    long main straight, heavy right T1, left T2, S-chicane, left hairpin,
 *    long flowing right back into the straight.
 *
 *  RALLYCROSS - a short (~1.5 km) EXTREME corner-gauntlet circuit with TWO
 *    gravel sections (low grip) mixed into the tarmac, the way real
 *    rallycross tracks are built: 90-degree sweeper, full 180-degree gravel
 *    hairpin, a three-hit gravel chicane (right-left-left), two more sharp
 *    90-degree hits, and a long flowing left back to the home straight.
 *    Control points are placed every ~30 m (including dense arc points in
 *    the corners) so the Catmull-Rom spline cannot kink; effective corner
 *    radii come out 14-25 m.
 *
 * The control points are also consumed by the headless AI scripts, so the
 * sim tests always run the exact same layout as the game.
 */

const CIRCUIT_PTS = [
  // ------------------------------------------------ start/finish straight
  new THREE.Vector3(-196, 0, 168), // A: start of the main straight (u = 0)
  new THREE.Vector3(  10, 0, 170), // B: start/finish line
  new THREE.Vector3( 260, 0, 170), // C: end of the straight
  // ------------------------------------------------ T1 (right, heavy)
  new THREE.Vector3( 332, 0, 128), // D: T1 entry
  new THREE.Vector3( 350, 0,  30), // E: T1 exit
  // ------------------------------------------------ T2 (left)
  new THREE.Vector3( 300, 0, -55), // F: T2 entry
  new THREE.Vector3( 195, 0, -95), // G: T2 exit
  // ------------------------------------------------ back straight + chicane
  new THREE.Vector3(  55, 0, -100), // H: back straight
  new THREE.Vector3( -14, 0, -139), // I: chicane right apex
  new THREE.Vector3( -90, 0,  -76), // J: chicane left apex
  new THREE.Vector3(-172, 0, -139), // K: chicane right apex
  // ------------------------------------------------ T5 (left hairpin)
  new THREE.Vector3(-292, 0,  -82), // L: hairpin apex zone
  new THREE.Vector3(-316, 0,  18), // M: hairpin exit
  // ------------------------------------------------ T6/T8 (long flowing right
  // into the straight). N and O are placed so the corner ends ~100 m before
  // the start line and the exit is a long straight - the old layout packed
  // the same turn into 60 m, which produced a hard kink ("broken" corner).
  new THREE.Vector3(-284, 0, 127), // N: T6 corner apex zone
  new THREE.Vector3(-255, 0, 158), // O: sweeper flowing back to the main straight
];

const RALLY_PTS = [
  // ------------------------------------------------ start/finish straight
  // (u = 0). The straight flows gently east so the 60 m grid and the
  // corner-exit ramp feed into it without a kink.
  new THREE.Vector3(-140, 0, 145), //  0 A: u = 0 (start line)
  new THREE.Vector3(-110, 0, 152), //  1
  new THREE.Vector3( -75, 0, 157), //  2
  new THREE.Vector3( -35, 0, 160), //  3
  new THREE.Vector3(   5, 0, 161), //  4
  new THREE.Vector3(  45, 0, 162), //  5
  new THREE.Vector3(  85, 0, 162), //  6
  new THREE.Vector3( 125, 0, 162), //  7
  new THREE.Vector3( 165, 0, 162), //  8 C: end of the straight
  // ------------------------------------------------ T1 (sharp 90, R 35)
  new THREE.Vector3( 189.7, 0, 151.8), //  9 T1 arc (R35, centre 165/127)
  new THREE.Vector3( 200, 0, 127), // 10 T1 exit, now heading north
  // ------------------------------------------------ right straight (north)
  new THREE.Vector3( 200, 0, 90), // 11
  new THREE.Vector3( 200, 0, 55), // 12
  new THREE.Vector3( 200, 0, 20), // 13
  new THREE.Vector3( 200, 0, -15), // 14
  new THREE.Vector3( 200, 0, -50), // 15
  new THREE.Vector3( 200, 0, -85), // 16
  new THREE.Vector3( 200, 0, -115), // 17
  // ------------------------------------------------ T2 (full 180 hairpin, R 32,
  // GRAVEL): north in, loop the top, south out
  new THREE.Vector3( 200, 0, -140), // 18 T2 entry
  new THREE.Vector3( 190.6, 0, -162.6), // 19 T2 arc 45deg
  new THREE.Vector3( 168, 0, -172), // 20 T2 apex
  new THREE.Vector3( 145.4, 0, -162.6), // 21 T2 arc 135deg
  new THREE.Vector3( 136, 0, -140), // 22 T2 exit, heading south
  // ------------------------------------------------ south straight + T3 (sharp
  // 90 right, R 30, GRAVEL)
  new THREE.Vector3( 136, 0, -105), // 23
  new THREE.Vector3( 136, 0, -70), // 24 T3 entry
  new THREE.Vector3( 127.2, 0, -48.8), // 25 T3 arc (R30, centre 106/-70)
  new THREE.Vector3( 106, 0, -40), // 26 T3 exit, heading west
  // ------------------------------------------------ short tarmac island, then
  // the GRAVEL CHICANE: T3b (90 right) - T3c (90 left), hit hard
  new THREE.Vector3( 80, 0, -40), // 27
  new THREE.Vector3( 55, 0, -40), // 28
  new THREE.Vector3( 30, 0, -40), // 29 T3b entry
  new THREE.Vector3( 8.8, 0, -48.8), // 30 T3b arc (R30, centre 30/-70)
  new THREE.Vector3( 0, 0, -70), // 31 T3b exit, heading north
  new THREE.Vector3( 0, 0, -87), // 32
  new THREE.Vector3( 0, 0, -105), // 33 T3c entry
  new THREE.Vector3(-8.8, 0, -126.2), // 34 T3c arc (R30, centre -30/-105)
  new THREE.Vector3(-30, 0, -135), // 35 T3c exit, heading west
  // ------------------------------------------------ west leg + T4 (sharp 90
  // left, R 30) onto the long left straight
  new THREE.Vector3(-63, 0, -135), // 36
  new THREE.Vector3(-96, 0, -135), // 37
  new THREE.Vector3(-129, 0, -135), // 38
  new THREE.Vector3(-155, 0, -135), // 39 T4 entry
  new THREE.Vector3(-176.2, 0, -126.2), // 40 T4 arc (R30, centre -155/-105)
  new THREE.Vector3(-185, 0, -105), // 41 T4 exit, heading south
  // ------------------------------------------------ long left straight (south)
  new THREE.Vector3(-186, 0, -70), // 42
  new THREE.Vector3(-188, 0, -35), // 43
  new THREE.Vector3(-190, 0, 0), // 44
  new THREE.Vector3(-192, 0, 35), // 45
  new THREE.Vector3(-194, 0, 70), // 46
  new THREE.Vector3(-196, 0, 105), // 47 T5 entry
  // ------------------------------------------------ T5 (sharp 90 left, R 30)
  // flowing back into the home straight
  new THREE.Vector3(-187.2, 0, 126.2), // 48 T5 arc (R30, centre -166/105)
  new THREE.Vector3(-166, 0, 135), // 49 T5 exit, heading east -> A
];

export function buildTrackCurve() {
  return new THREE.CatmullRomCurve3(CIRCUIT_PTS, true, 'catmullrom', 0.5);
}

export function buildRallyCurve() {
  return new THREE.CatmullRomCurve3(RALLY_PTS, true, 'catmullrom', 0.5);
}

/**
 * Arc-length u of every control point: nearest of 2400 evenly spaced curve
 * samples. Used to convert the index-space surface zones to u-ranges.
 */
function controlPointUs(curve, pts) {
  const samples = curve.getSpacedPoints(2400);
  const us = [];
  for (const c of pts) {
    let best = Infinity;
    let bestU = 0;
    for (let s = 0; s < samples.length; s++) {
      const q = samples[s];
      const dx = q.x - c.x;
      const dz = q.z - c.z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bestU = s / (samples.length - 1);
      }
    }
    us.push(bestU);
  }
  return us;
}

// ---------------------------------------------------------------- surfaces

/** Grip of the gravel sections relative to tarmac (mu 1.45 -> ~1.04). */
export const GRIP_GRAVEL = 0.72;
/** Metres of grip blend across a surface boundary (no instant mu step). */
const SURFACE_BLEND_M = 3.5;

/**
 * Signed depth (m) of u inside gravel zone [a, b): positive inside the zone
 * (distance to the nearest boundary), negative outside.
 */
function gravelDepth(u, a, b, length) {
  const len = (b - a + 1) % 1;
  const x = (u - a + 1) % 1; // distance along the lap from a
  if (x <= len) return Math.min(x, len - x) * length;
  return -Math.min(x - len, 1 - x) * length;
}

/**
 * Convert a raw layout (curve + control points + index-space gravel zones)
 * into the track descriptor the game, the renderer and the AI all consume:
 *
 *   { name, label, curve, length, gravel: [[u0,u1]...],
 *     surfaceAt(u) -> grip 0.72..1.0, isGravel(u) -> bool }
 */
function layoutTrack(name, label, curve, pts, gravelIdx = []) {
  const length = curve.getLength();
  const us = controlPointUs(curve, pts);
  const n = pts.length;
  const gravel = gravelIdx.map(([i0, i1]) => {
    const toU = (i) => {
      const k = Math.floor(i) % n;
      const k1 = (k + 1) % n;
      const f = i - Math.floor(i);
      let a = us[k];
      let b = us[k1];
      if (b <= a) b += 1; // wrap
      return (a + (b - a) * f) % 1;
    };
    return [toU(i0), toU(i1)];
  });
  const bl = SURFACE_BLEND_M;

  const surfaceAt = (u) => {
    let g = 1;
    for (const [a, b] of gravel) {
      const d = gravelDepth(u, a, b, length);
      // d = +deep inside gravel -> GRIP_GRAVEL; d = -far outside -> 1
      const ramp = Math.max(0, Math.min(1, (bl - d) / (2 * bl)));
      g = Math.min(g, GRIP_GRAVEL + (1 - GRIP_GRAVEL) * ramp);
    }
    return g;
  };
  const isGravel = (u) => gravel.some(([a, b]) => gravelDepth(u, a, b, length) > 0);

  return { name, label, curve, length, gravel, surfaceAt, isGravel };
}

export const TRACKS = {
  circuit: layoutTrack('circuit', 'CIRCUIT', buildTrackCurve(), CIRCUIT_PTS, []),
  rally: layoutTrack(
    'rally',
    'RALLYCROSS',
    buildRallyCurve(),
    RALLY_PTS,
    // zone 1: the gravel hairpin + T3 (mid right straight -> mid T3 exit)
    // zone 2: the gravel chicane T3b + T3c (mid island -> mid west leg)
    [
      [17.5, 26.5],
      [28.5, 35.5],
    ],
  ),
};

// The rallycross is an extreme technical mixed-surface circuit: the AI's
// steady-state 1.25 g corner target is a lower bound there (steering rate +
// load transfer into the gravel burn extra margin), so it runs 18% inside
// the limit. The all-tarmac circuit keeps its aggressive line.
TRACKS.rally.cornerGripMargin = 0.82;
