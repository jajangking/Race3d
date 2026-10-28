import * as THREE from 'three';

/**
 * Real-circuit layout for the closed track.
 *
 * Instead of a blob, this is a proper racing circuit (counter-clockwise):
 *   - a long start/finish main straight
 *   - T1: a heavy right-hander up the right side
 *   - T2: a left into the back straight
 *   - an S-chicane (I/J/K) in the back straight
 *   - T5: a left hairpin down the left side
 *   - T6: a right, then T7/T8: a fast left flowing back into the straight
 *
 * Footprint ~700 x 370 m, lap length ~2.1 km. The control points are also
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
    // ------------------------------------------------ T6 (right)
    new THREE.Vector3(-266, 0, 102), // N
    // ------------------------------------------------ T8 (fast left into the straight)
    new THREE.Vector3(-238, 0, 138), // O: flowing back to the main straight
  ];
  return new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.5);
}
