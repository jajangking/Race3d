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
 *  RALLYCROSS - a ~1.75 km EXTREME corner-gauntlet circuit with TWO gravel
 *    sections (low grip) mixed into the tarmac: 13 real corners with
 *    effective radii of only 10.6-16.9 m — a sharp 90 T1, a full 180-degree
 *    GRAVEL hairpin, a four-hit GRAVEL chicane, a sharp 90, an S-bend GRAVEL
 *    bump on the west leg, and a T5/T6/T7 left-foot flow back to the home
 *    straight. Control points are placed every ~15-46 m (arc points inside
 *    the corners, short lead-in/lead-out segments at every corner junction)
 *    so the Catmull-Rom spline cannot kink.
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
  // ------------------------------------------------ home straight (flows gently so the grid + corner exit feed in)
new THREE.Vector3( -241.00, 0,  268.0), //  0 A: u = 0 (start line)
new THREE.Vector3( -218.00, 0,  265.7), //  1
new THREE.Vector3( -173.00, 0,  261.7), //  2
new THREE.Vector3( -128.00, 0,  258.4), //  3
new THREE.Vector3(  -83.00, 0,  255.9), //  4
new THREE.Vector3(  -38.00, 0,  255.0), //  5
new THREE.Vector3(    7.00, 0,  255.0), //  6
new THREE.Vector3(   47.00, 0,  255.0), //  7
new THREE.Vector3(   87.00, 0,  255.0), //  8
new THREE.Vector3(  122.00, 0,  255.0), //  9
new THREE.Vector3(  147.00, 0,  255.0), // 10
new THREE.Vector3(  165.00, 0,  255.0), // 11 T1 entry
  // ------------------------------------------------ T1 (sharp 90 left, R24) off the home straight
new THREE.Vector3(  181.97, 0,  248.0), // 12 T1 arc (R24, 90 left)
new THREE.Vector3(  189.00, 0,  231.0), // 13 T1 exit, heading north
  // ------------------------------------------------ right straight (north)
new THREE.Vector3(  189.00, 0,  206.0), // 14
new THREE.Vector3(  189.00, 0,  166.0), // 15
new THREE.Vector3(  189.00, 0,  126.0), // 16
new THREE.Vector3(  189.00, 0,   86.0), // 17
new THREE.Vector3(  189.00, 0,   70.0), // 18
new THREE.Vector3(  189.00, 0,   45.0), // 19
  // ------------------------------------------------ T2: the 180-DEGREE GRAVEL HAIRPIN (R30)
new THREE.Vector3(  180.21, 0,   23.8), // 20 T2 hairpin arc start (R30, 180 left)
new THREE.Vector3(  159.00, 0,   15.0), // 21
new THREE.Vector3(  137.79, 0,   23.8), // 22
new THREE.Vector3(  129.00, 0,   45.0), // 23 T2 exit, heading south
  // ------------------------------------------------ right leg (south)
new THREE.Vector3(  129.00, 0,   68.0), // 24
new THREE.Vector3(  129.00, 0,   90.0), // 25
new THREE.Vector3(  129.00, 0,  112.0), // 26
  // ------------------------------------------------ T3 (sharp 90 right, R24)
new THREE.Vector3(  121.97, 0,  129.0), // 27 T3 arc (R24, 90 right)
new THREE.Vector3(  105.00, 0,  136.0), // 28 T3 exit -> chicane
  // ------------------------------------------------ the FOUR-HIT GRAVEL CHICANE: T4a - T4b - T4c - T4d (all R24)
new THREE.Vector3(   88.03, 0,  143.0), // 29 T4a arc (R24, 90 left)
new THREE.Vector3(   81.00, 0,  160.0), // 30
new THREE.Vector3(   81.00, 0,  178.0), // 31 chicane leg
new THREE.Vector3(   81.00, 0,  196.0), // 32
new THREE.Vector3(   73.97, 0,  213.0), // 33 T4b arc (R24, 90 right)
new THREE.Vector3(   57.00, 0,  220.0), // 34
new THREE.Vector3(   40.00, 0,  220.0), // 35 chicane leg
new THREE.Vector3(   21.00, 0,  220.0), // 36
new THREE.Vector3(    4.03, 0,  213.0), // 37 T4c arc (R24, 90 right)
new THREE.Vector3(   -3.00, 0,  196.0), // 38
new THREE.Vector3(   -3.00, 0,  178.0), // 39 chicane leg
new THREE.Vector3(   -3.00, 0,  160.0), // 40
new THREE.Vector3(  -10.03, 0,  143.0), // 41 T4d arc (R24, 90 left)
new THREE.Vector3(  -27.00, 0,  136.0), // 42 chicane exit, west leg
  // ------------------------------------------------ west leg
new THREE.Vector3(  -50.00, 0,  136.0), // 43
new THREE.Vector3(  -95.00, 0,  136.0), // 44
new THREE.Vector3( -140.00, 0,  136.0), // 45
new THREE.Vector3( -183.00, 0,  136.0), // 46
new THREE.Vector3( -207.00, 0,  136.0), // 47
  // ------------------------------------------------ the S-BEND BUMP (GRAVEL): S1 + S2 (R24)
new THREE.Vector3( -223.97, 0,  143.0), // 48 S1 arc (R24, 90 left)
new THREE.Vector3( -231.00, 0,  160.0), // 49
new THREE.Vector3( -231.00, 0,  178.0), // 50 S-bend leg
new THREE.Vector3( -231.00, 0,  196.0), // 51
new THREE.Vector3( -238.03, 0,  213.0), // 52 S2 arc (R24, 90 right)
new THREE.Vector3( -255.00, 0,  220.0), // 53 S-bend exit, west leg 2
  // ------------------------------------------------ west leg 2
new THREE.Vector3( -285.00, 0,  220.0), // 54
new THREE.Vector3( -315.00, 0,  220.0), // 55
new THREE.Vector3( -335.00, 0,  220.0), // 56
new THREE.Vector3( -351.00, 0,  220.0), // 57
  // ------------------------------------------------ T5 (sharp 90 left, R24)
new THREE.Vector3( -367.97, 0,  227.0), // 58 T5 arc (R24, 90 left)
new THREE.Vector3( -375.00, 0,  244.0), // 59 T5 exit, left leg
  // ------------------------------------------------ left leg (south)
new THREE.Vector3( -375.00, 0,  268.0), // 60
new THREE.Vector3( -375.00, 0,  288.0), // 61
new THREE.Vector3( -375.00, 0,  308.0), // 62
  // ------------------------------------------------ T6 (sharp 90 left, R24)
new THREE.Vector3( -367.97, 0,  325.0), // 63 T6 arc (R24, 90 left)
new THREE.Vector3( -351.00, 0,  332.0), // 64 T6 exit, east leg
  // ------------------------------------------------ east leg
new THREE.Vector3( -328.00, 0,  332.0), // 65
new THREE.Vector3( -305.00, 0,  332.0), // 66
  // ------------------------------------------------ T7 (sharp 90 left, R24)
new THREE.Vector3( -288.03, 0,  325.0), // 67 T7 arc (R24, 90 left)
new THREE.Vector3( -281.00, 0,  308.0), // 68 T7 exit
  // ------------------------------------------------ F1: flowing right (R40) back onto the home straight
new THREE.Vector3( -269.28, 0,  279.7), // 69 F1 flow arc (R40, 90 right) -> closes at A
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
    // zone 1: the GRAVEL HAIRPIN + right leg + T3 + four-hit chicane
    //         (T2 entry idx19 -> T4d exit idx42)
    // zone 2: the S-BEND GRAVEL BUMP on the west leg (S1 + S2, idx48-53)
    [
      [19, 42],
      [48, 53],
    ],
  ),
};

// The rallycross is an extreme technical mixed-surface circuit: the AI's
// steady-state 1.25 g corner target is a lower bound there (steering rate +
// load transfer into the gravel burn extra margin), so it runs 18% inside
// the limit. The all-tarmac circuit keeps its aggressive line.
TRACKS.rally.cornerGripMargin = 0.82;
