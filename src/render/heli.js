// --------------------------------------------------------------------- heli
// The two broadcast helicopters flying over the field. They are physical
// objects in the scene (visible from the chase cam, the corner cams, the
// 1v1 cam and from each other), and the TV feed's HELI / CRASH shots are
// read from their own smoothed poses - the camera IS the helicopter, so
// the heli footage glides instead of zigzagging like a virtual camera.
import * as THREE from 'three';

const _euler = new THREE.Euler();
const _to = new THREE.Vector3();

/**
 * Build one low-poly helicopter. The nose faces +Z (the car convention).
 * Returns { root, update(dt) } - update spins the rotors.
 */
export function createHeliMesh({ body = 0xf4f6f8, stripe = 0xe23b2e } = {}) {
  const root = new THREE.Group();
  root.scale.setScalar(1.25);
  const mBody = new THREE.MeshStandardMaterial({ color: body, roughness: 0.5, metalness: 0.15 });
  const mDark = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.6, metalness: 0.3 });
  const mGlass = new THREE.MeshStandardMaterial({
    color: 0x9fd4e8,
    roughness: 0.15,
    metalness: 0.4,
    transparent: true,
    opacity: 0.75,
  });
  const mStripe = new THREE.MeshStandardMaterial({ color: stripe, roughness: 0.5, metalness: 0.1 });
  const mNav = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff3b30, emissiveIntensity: 2 });

  const add = (geo, mat, x, y, z, rx = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    if (rx) m.rotation.x = rx;
    root.add(m);
    return m;
  };

  // fuselage: capsule on its side, nose to +Z
  add(new THREE.CapsuleGeometry(0.85, 1.5, 4, 12), mBody, 0, 0, 0.2, Math.PI / 2).castShadow = true;
  // cockpit glass
  const glass = add(new THREE.SphereGeometry(0.66, 12, 10), mGlass, 0, 0.22, 1.28);
  glass.scale.set(1, 0.8, 1.05);
  // tail boom + fin
  add(new THREE.BoxGeometry(0.34, 0.34, 2.8), mBody, 0, 0.18, -2.35).castShadow = true;
  add(new THREE.BoxGeometry(0.08, 0.9, 0.55), mStripe, 0, 0.66, -3.62);
  // red nav light on the tail
  add(new THREE.SphereGeometry(0.07, 6, 6), mNav, 0.2, 0.82, -3.62);
  // livery stripe along the fuselage sides
  add(new THREE.BoxGeometry(1.74, 0.24, 2.0), mStripe, 0, 0.05, 0.45);
  // rotor mast + hub
  add(new THREE.CylinderGeometry(0.1, 0.16, 0.55, 8), mDark, 0, 1.12, 0.2);
  // skids + struts
  for (const sx of [-0.78, 0.78]) {
    add(new THREE.BoxGeometry(0.09, 0.09, 2.9), mDark, sx, -1.08, 0.15).castShadow = true;
    add(new THREE.BoxGeometry(0.07, 0.6, 0.07), mDark, sx, -0.7, 0.85);
    add(new THREE.BoxGeometry(0.07, 0.6, 0.07), mDark, sx, -0.7, -0.55);
  }

  // main rotor: 4 blades spinning around the vertical mast
  const mainRotor = new THREE.Group();
  mainRotor.position.set(0, 1.42, 0.2);
  const bladeGeo = new THREE.BoxGeometry(0.14, 0.035, 2.1);
  for (let i = 0; i < 4; i++) {
    const arm = new THREE.Group();
    const b = new THREE.Mesh(bladeGeo, mDark);
    b.position.z = 1.05;
    arm.add(b);
    arm.rotation.y = (i * Math.PI) / 2;
    mainRotor.add(arm);
  }
  root.add(mainRotor);

  // tail rotor: 2 blades spinning around the boom axis
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.24, 0.66, -3.62);
  const tBladeGeo = new THREE.BoxGeometry(0.03, 0.95, 0.05);
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Mesh(tBladeGeo, mDark);
    b.rotation.z = (i * Math.PI) / 2;
    tailRotor.add(b);
  }
  root.add(tailRotor);

  let a = 0;
  let ta = 0;
  return {
    root,
    update(dt) {
      a += dt * 15;
      ta += dt * 32;
      mainRotor.rotation.y = a;
      tailRotor.rotation.z = ta;
    },
  };
}

/**
 * One flying helicopter: a velocity-capped glide towards its moving
 * anchor (a swoop, never a teleport), a yawed/banked attitude that
 * follows the velocity, and a slower look target so the view pans to a
 * new subject instead of snapping. The TV feed reads the stabilized
 * nose PTZ (nosePos + look) - the camera sits in front of the nose, so
 * the airframe (skids, rotors) never enters the picture.
 */
export class HeliUnit {
  constructor(heli, startPos, lookStart) {
    this.heli = heli;
    this.pos = startPos.clone();
    this.look = lookStart ? lookStart.clone() : new THREE.Vector3(startPos.x, 0, startPos.z + 20);
    this._vel = new THREE.Vector3();
    this._yaw = 0;
    this._pitch = 0;
    this._roll = 0;
    this._yawRate = 0;
    // the TV camera: a stabilized PTZ gimbal mounted at the nose - ahead
    // of the fuselage so the skids never enter the frame, and level
    // (yaw only) so the heli's pitch/roll never reaches the picture
    this.nosePos = new THREE.Vector3();
    this.noseDist = 2.8; // just past the nose tip (the model is scaled 1.25)
    this.camHeight = 0.35;
    this._updateNose();
  }

  /** The stabilized nose position: forward by yaw only, level, +camHeight. */
  _updateNose() {
    const p = this.pos;
    this.nosePos.set(
      p.x + Math.sin(this._yaw) * this.noseDist,
      p.y + this.camHeight,
      p.z + Math.cos(this._yaw) * this.noseDist,
    );
  }

  /**
   * Teleport (used when the active track changes): no glide, no velocity
   * spike.
   */
  snap(pos, look) {
    this.pos.copy(pos);
    this._vel.set(0, 0, 0);
    if (look) this.look.copy(look);
    this._updateNose();
  }

  update(dt, anchorPos, anchorLook) {
    const p = this.pos;
    // velocity model: target speed grows with the distance to the anchor
    // (capped at 45 m/s - a heli, not a teleport), and the velocity is
    // smoothed so subject switches become a swoop, not a zigzag. The
    // steady-state lag behind a moving subject is ~v/3.5 m.
    _to.copy(anchorPos).sub(p);
    const d = _to.length();
    const wantSpeed = THREE.MathUtils.clamp(d * 3.5, 0, 45);
    if (d > 1e-4) _to.multiplyScalar(wantSpeed / d);
    else _to.set(0, 0, 0);
    this._vel.lerp(_to, 1 - Math.exp(-dt / 0.35));
    p.addScaledVector(this._vel, dt);
    // the look target is a bit slower: the feed pans to a new subject
    // smoothly instead of snapping
    this.look.lerp(anchorLook, 1 - Math.exp(-dt / 0.5));

    const hSpeed = Math.hypot(this._vel.x, this._vel.z);
    // nose along the direction of travel while moving, else along the
    // direction we are looking
    const want =
      hSpeed > 0.4
        ? Math.atan2(this._vel.x, this._vel.z)
        : Math.atan2(this.look.x - p.x, this.look.z - p.z);
    let dYaw = want - this._yaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    const maxStep = 1.7 * dt;
    const step = THREE.MathUtils.clamp(dYaw, -maxStep, maxStep);
    this._yaw += step;
    this._yawRate = this._yawRate * 0.9 + (step / Math.max(dt, 1e-4)) * 0.1;
    // bank into the turn, tilt with the climb
    const wantRoll = THREE.MathUtils.clamp(-this._yawRate * 0.45, -0.3, 0.3);
    const wantPitch = THREE.MathUtils.clamp(this._vel.y * 0.05, -0.2, 0.2);
    this._roll += (wantRoll - this._roll) * (1 - Math.exp(-dt / 0.4));
    this._pitch += (wantPitch - this._pitch) * (1 - Math.exp(-dt / 0.4));

    const root = this.heli.root;
    root.position.copy(p);
    _euler.set(this._pitch, this._yaw, this._roll, 'YXZ');
    root.quaternion.setFromEuler(_euler);
    this._updateNose();
    this.heli.update(dt);
  }
}
