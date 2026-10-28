import * as THREE from 'three';

/**
 * Real-circuit layout for the closed track.
 *
 * Instead of a blob, this is a proper racing circuit (counter-clockwise):
 *   - a long start/finish main straight
 *   - T1: a heavy right-hander up the right side
 *   - T2: a left into the back straight
 *   - an S-chicane (I/J/K) in the back straight
 *   - T5: a hairpin down the left side
 *   - T6/T8: one long flowing right corner back into the main straight
 *
 * Footprint ~700 x 370 m, lap length ~1.75 km. The control points are also
 * consumed by the headless AI scripts, so the sim tests always run the exact
 * same layout as the game.
 */
export function buildTrackCurve() {
  const pts = [
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
  return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
}
