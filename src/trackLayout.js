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
 *  RALLYCROSS - a short (~1.4 km) twisty circuit with TWO gravel sections
 *    (low grip) mixed into the tarmac, the way real rallycross tracks are
 *    built: right sweeper onto gravel, gravel chicane, tarmac island,
 *    gravel hairpin, tight left, sweeping right, home straight.
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
  new THREE.Vector3(-190, 0, 150), // 0 A: start of the main straight (u = 0)
  new THREE.Vector3(  30, 0, 152), // 1 B: start/finish line
  new THREE.Vector3( 200, 0, 148), // 2 C: end of the straight
  // ------------------------------------------------ T1 (right sweeper, onto gravel)
  new THREE.Vector3( 272, 0, 108), // 3 D: T1 entry
  new THREE.Vector3( 292, 0,  18), // 4 E: T1 apex (gravel)
  new THREE.Vector3( 240, 0, -56), // 5 F: T1 exit (gravel)
  // ------------------------------------------------ gravel chicane (left-right)
  new THREE.Vector3( 150, 0,  -40), // 6 G: chicane left apex (gravel)
  new THREE.Vector3(  66, 0,  -92), // 7 H: chicane right apex (gravel)
  // ------------------------------------------------ tarmac island + T4 gravel hairpin
  new THREE.Vector3( -58, 0, -122), // 8 I: hairpin entry
  new THREE.Vector3(-148, 0,  -70), // 9 J: hairpin apex (gravel)
  new THREE.Vector3(-142, 0,   16), // 10 K: hairpin exit
  // ------------------------------------------------ T5 (tight left) + T6/T7 home
  new THREE.Vector3(-208, 0,  74), // 11 L: T5 apex
  new THREE.Vector3(-232, 0, 112), // 12 M: sweeper flowing back to the straight
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
    // zone 1: T1 sweeper + chicane (mid T1 entry -> mid chicane exit)
    // zone 2: the hairpin (approach -> exit)
    [
      [3.55, 7.45],
      [8.05, 10.55],
    ],
  ),
};

// The rallycross is a technical mixed-surface circuit: the AI's steady-state
// 0.9 g corner target is a lower bound there (steering rate + load transfer
// into the gravel burn extra margin), so it runs 18% inside the limit.
// The all-tarmac circuit keeps its aggressive line.
TRACKS.rally.cornerGripMargin = 0.82;
