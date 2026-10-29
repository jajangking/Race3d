import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CAR } from '../vehicle/config.js';

/**
 * Procedural low-poly sports car. Built in "ground space" (y = 0 is the road)
 * and then dropped so the group origin sits on the CoG, because that is where
 * the rigid body's transform lives.
 *
 * The wheels are driven straight from the simulation: suspension travel,
 * Ackermann steering and wheel spin all come from the physics state.
 */

const RIDE_HEIGHT = 0.423; // CoG height at rest, matches the settled sim

const PAINT = 0x1f6bff;
const PAINT_DARK = 0x1545b3;
const CARBON = 0x14171b;
const TRIM = 0x0b0d10;
const GLASS = 0x0e1720;
const RIM = 0xb9c1c9;
const TYRE = 0x121417;

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, ...opts });
}

function box(w, h, d, material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  return mesh;
}

/**
 * Bake a group's static meshes down to one mesh per material. A car is made
 * of ~85 little meshes; with ten opponents plus the player that is ~935 draw
 * calls per frame, which murders a phone GPU. Merging keeps the same look but
 * cuts the car to a few dozen calls.
 *
 * Moving sub-groups (wheels, steering wheel) are merged independently, so
 * their animation still works. Transparent parts are left alone for correct
 * sorting.
 */
function mergeByMaterial(group, skip = null) {
  group.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const buckets = new Map();

  group.traverse((obj) => {
    if (!obj.isMesh || obj.material?.transparent) return;
    if (skip) {
      let p = obj;
      while (p && p !== group) {
        if (skip.has(p)) return;
        p = p.parent;
      }
    }
    const key = obj.material.uuid;
    if (!buckets.has(key)) buckets.set(key, { material: obj.material, meshes: [] });
    buckets.get(key).meshes.push(obj);
  });

  const matrix = new THREE.Matrix4();
  for (const { material, meshes } of buckets.values()) {
    if (meshes.length < 2) continue;
    const geoms = [];
    let castShadow = false;
    let receiveShadow = false;
    for (const mesh of meshes) {
      matrix.multiplyMatrices(inv, mesh.matrixWorld);
      let geo = mesh.geometry.clone();
      if (geo.index) geo = geo.toNonIndexed();
      geo.applyMatrix4(matrix);
      geoms.push(geo);
      castShadow = castShadow || mesh.castShadow;
      receiveShadow = receiveShadow || mesh.receiveShadow;
    }
    const merged = mergeGeometries(geoms, false);
    for (const geo of geoms) geo.dispose();
    if (!merged) continue;

    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    group.add(mesh);
    for (const old of meshes) {
      // A merged mesh can itself have mesh children (the steering-wheel hub
      // carries its centre cap). Keep those alive by moving them up to the
      // group before the parent disappears.
      if (old.children.length > 0) {
        for (const child of [...old.children]) group.attach(child);
      }
      old.parent.remove(old);
      old.geometry.dispose();
    }
  }
}

/** Side-profile extrusion: x = length (nose at +x), y = height. */
function lowerBodyGeometry() {
  const s = new THREE.Shape();
  // start at the rear bottom and go clockwise around the silhouette
  s.moveTo(-2.0, 0.16);
  s.lineTo(-2.16, 0.28);
  s.lineTo(-2.18, 0.62);
  s.lineTo(-2.08, 0.82);
  s.lineTo(-1.4, 0.9);
  s.lineTo(-0.6, 0.92);
  s.lineTo(0.6, 0.92);
  s.lineTo(1.2, 0.84);
  s.lineTo(1.98, 0.76);
  s.lineTo(2.26, 0.6);
  s.lineTo(2.28, 0.34);
  s.lineTo(2.1, 0.16);
  s.lineTo(-2.0, 0.16);
  s.closePath();

  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 1.68,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 4,
    curveSegments: 8,
  });
  geo.translate(0, 0, -0.84);
  geo.rotateY(-Math.PI / 2); // extrusion axis -> car width, profile x -> +Z
  geo.computeVertexNormals();
  return geo;
}

/** Cabin greenhouse: tapered box, 8 corners. */
function cabinGeometry() {
  const yb = 0.86;
  const yt = 1.26;
  const zb = 1.02; // front of the cabin at the beltline
  const zt = 0.3; // windscreen rake
  const rb = -1.36;
  const rt = -1.02;
  const xb = 0.72;
  const xt = 0.56;

  const v = [
    // bottom
    [-xb, yb, zb], [xb, yb, zb], [xb, yb, rb], [-xb, yb, rb],
    // top
    [-xt, yt, zt], [xt, yt, zt], [xt, yt, rt], [-xt, yt, rt],
  ];
  const faces = [
    [0, 1, 2], [0, 2, 3], // floor (hidden)
    [4, 6, 5], [4, 7, 6], // roof
    [0, 4, 5], [0, 5, 1], // windscreen
    [3, 2, 6], [3, 6, 7], // rear window
    [0, 3, 7], [0, 7, 4], // left
    [1, 5, 6], [1, 6, 2], // right
  ];
  const pos = [];
  for (const f of faces) for (const i of f) pos.push(...v[i]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

/** Roof number decal: bold white digit with a dark outline. */
function numberTexture(num) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  g.font = '900 92px Inter, system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 12;
  g.strokeStyle = 'rgba(10, 12, 16, 0.85)';
  g.strokeText(num, 64, 70);
  g.fillStyle = '#f4f7fa';
  g.fillText(num, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildSteeringWheel() {
  const mount = new THREE.Group();
  mount.name = 'steeringWheel';

  const wheel = new THREE.Group();
  wheel.rotation.x = Math.PI / 2;
  mount.add(wheel);

  const rimMat = mat(0x16191d, { roughness: 0.38, metalness: 0.7 });
  const hubMat = mat(0x202429, { roughness: 0.46, metalness: 0.72 });
  const trimMat = mat(RIM, { roughness: 0.26, metalness: 0.95 });

  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.165, 0.012, 18, 40), rimMat);
  wheel.add(ring);

  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.138, 0.008, 14, 32), rimMat);
  wheel.add(innerRing);

  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.016, 0.118), hubMat);
    const pivot = new THREE.Group();
    pivot.rotation.z = (i / 3) * Math.PI * 2;
    spoke.position.y = 0.059;
    pivot.add(spoke);
    wheel.add(pivot);
  }

  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.036, 0.016, 18), hubMat);
  wheel.add(hub);

  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.02, 16), trimMat);
  cap.rotation.x = Math.PI / 2;
  hub.add(cap);

  return { mount, wheel };
}

function buildWheel(cfg, simple = false, discMat = null) {
  const R = cfg.wheel.radius;
  const W = cfg.wheel.width;

  const steer = new THREE.Group();
  const spin = new THREE.Group();
  steer.add(spin);

  const tyreMat = mat(TYRE, { roughness: 0.92, metalness: 0.05 });
  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(R, R, W, 26, 1), tyreMat);
  tyre.rotation.z = Math.PI / 2;
  tyre.castShadow = true;
  spin.add(tyre);

  // sidewall shoulders, slightly proud of the tread
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Mesh(
      new THREE.CylinderGeometry(R * 0.995, R * 0.94, W * 0.12, 26, 1),
      tyreMat,
    );
    shoulder.rotation.z = Math.PI / 2;
    shoulder.position.x = side * (W / 2 - W * 0.06);
    spin.add(shoulder);
  }

  const rimMat = mat(RIM, { roughness: 0.28, metalness: 0.95 });
  const face = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.7, R * 0.7, W * 1.02, 22), rimMat);
  face.rotation.z = Math.PI / 2;
  face.castShadow = true;
  spin.add(face);

  // brake disc (always present: it glows orange when the car brakes, which
  // reads well even on the simplified AI cars). One material per car so the
  // glow can be driven from a single emissiveIntensity write.
  if (discMat) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.62, 0.03, 20), discMat);
    disc.rotation.z = Math.PI / 2;
    disc.position.x = W * 0.16;
    spin.add(disc);
  }

  // AI cars only need the silhouette and the rim at racing distance; the
  // spokes and caliper are extra draw calls for pixels nobody can resolve.
  if (simple) return { steer, spin };

  const hubMat = mat(0x2a2e33, { roughness: 0.5, metalness: 0.7 });
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.2, R * 0.2, W * 1.12, 14), hubMat);
  hub.rotation.z = Math.PI / 2;
  spin.add(hub);

  // five spokes, radiating in the YZ plane
  for (let i = 0; i < 5; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(W * 1.04, R * 0.56, 0.045), hubMat);
    spoke.position.y = R * 0.37;
    const pivot = new THREE.Group();
    pivot.rotation.x = (i / 5) * Math.PI * 2;
    pivot.add(spoke);
    spin.add(pivot);
  }

  const caliper = new THREE.Mesh(
    new THREE.BoxGeometry(0.07, R * 0.42, R * 0.26),
    mat(0xd8a21a, { roughness: 0.4, metalness: 0.6 }),
  );
  caliper.position.set(W * 0.16, R * 0.42, 0);
  steer.add(caliper); // does not spin with the wheel

  return { steer, spin };
}

export function createCarMesh(cfg = CAR) {
  const simple = cfg.simple === true;
  const root = new THREE.Group();
  root.name = 'car';

  // everything drawn in ground space gets dropped onto the CoG
  const body = new THREE.Group();
  body.position.y = -RIDE_HEIGHT;
  root.add(body);

  const paint = mat(cfg.paint ?? PAINT, { roughness: 0.26, metalness: 0.62, envMapIntensity: 1.1 });
  const paintDark = mat(cfg.paintDark ?? PAINT_DARK, { roughness: 0.32, metalness: 0.6 });
  const carbon = mat(CARBON, { roughness: 0.38, metalness: 0.5 });
  const trim = mat(TRIM, { roughness: 0.72, metalness: 0.2 });
  const glass = mat(0xbfd9ff, {
    roughness: 0.02,
    metalness: 1.0,
    transparent: true,
    opacity: 0.35,
    envMapIntensity: 2.2,
    depthWrite: false,
  });

  // --------------------------------------------------------------- bodywork
  const shell = new THREE.Mesh(lowerBodyGeometry(), paint);
  shell.castShadow = true;
  shell.receiveShadow = true;
  body.add(shell);

  const cabinGlass = new THREE.Mesh(cabinGeometry(), glass);
  cabinGlass.castShadow = false;
  cabinGlass.receiveShadow = false;
  cabinGlass.renderOrder = 12;
  cabinGlass.material.side = THREE.DoubleSide;
  body.add(cabinGlass);

  // painted roof panel over the greenhouse
  // painted roof panel over the greenhouse
  const roof = box(1.08, 0.046, 1.32, paint, 0, 1.255, -0.355);
  roof.castShadow = true;
  body.add(roof);

  let steeringWheel = null;
  if (!simple) {
    steeringWheel = buildSteeringWheel();
    steeringWheel.mount.position.set(0.36, 0.96, 0.78);
    steeringWheel.mount.rotation.set(-1.26, 0.1, 0.16);
    steeringWheel.mount.scale.set(1.16, 1.16, 1.16);
    body.add(steeringWheel.mount);
  }

  // side skirts
  for (const s of [-1, 1]) {
    body.add(box(0.1, 0.11, 2.64, carbon, s * 0.915, 0.21, -0.08));
  }

  // front splitter + rear diffuser
  body.add(box(1.88, 0.05, 0.7, carbon, 0, 0.155, 2.06));
  body.add(box(1.8, 0.22, 0.48, carbon, 0, 0.2, -2.12));

  // grille and vents
  body.add(box(1.14, 0.18, 0.07, trim, 0, 0.4, 2.3));
  for (const s of [-1, 1]) {
    body.add(box(0.28, 0.09, 0.11, trim, s * 0.58, 0.24, 2.28));
    body.add(box(0.32, 0.11, 0.38, carbon, s * 0.64, 0.86, 0.56)); // side vents
  }

  // bonnet crease / heat extractor
  body.add(box(0.68, 0.02, 0.46, carbon, 0, 0.82, 1.44));

  // mirrors
  for (const s of [-1, 1]) {
    body.add(box(0.056, 0.046, 0.18, carbon, s * 0.86, 0.98, 0.64));
    body.add(box(0.19, 0.1, 0.11, paint, s * 0.97, 1.01, 0.62));
  }

  // front wing: main plane plus endplates, poking out ahead of the splitter
  body.add(box(1.7, 0.05, 0.5, carbon, 0, 0.13, 2.32));
  for (const s of [-1, 1]) {
    body.add(box(0.05, 0.12, 0.34, carbon, s * 0.85, 0.18, 2.32));
  }

  // rear wing
  body.add(box(1.66, 0.06, 0.4, carbon, 0, 1.12, -2.08));
  for (const s of [-1, 1]) {
    body.add(box(0.056, 0.28, 0.18, carbon, s * 0.66, 0.97, -2.07));
    body.add(box(0.034, 0.16, 0.4, paintDark, s * 0.84, 1.12, -2.08));
  }

  // livery accents: the player's car gets a white centre stripe so it reads
  // as "your car" from the chase and TV cameras
  if (cfg.stripe) {
    const white = mat(0xf2f5f8, { roughness: 0.4, metalness: 0.3 });
    body.add(box(0.3, 0.012, 1.18, white, 0, 1.281, -0.355)); // roof
    body.add(box(0.5, 0.052, 0.2, white, 0, 0.157, 2.28));    // splitter centre
  }

  // roof number (all cars: 1 = player, 2..11 = the AI field)
  if (cfg.number) {
    const num = new THREE.Mesh(
      new THREE.PlaneGeometry(0.42, 0.42),
      new THREE.MeshBasicMaterial({
        map: numberTexture(cfg.number),
        transparent: true,
        depthWrite: false,
      }),
    );
    num.rotation.x = -Math.PI / 2;
    num.position.set(0, 0.8575, -0.355);
    num.renderOrder = 2;
    body.add(num);
  }

  // lights
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    emissive: 0xfff3d0,
    emissiveIntensity: 2.6,
    roughness: 0.18,
  });
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x3a0505,
    emissive: 0xff1a10,
    emissiveIntensity: 2.4,
    roughness: 0.28,
  });
  for (const s of [-1, 1]) {
    body.add(box(0.38, 0.08, 0.068, headMat, s * 0.58, 0.64, 2.28));
    body.add(box(0.44, 0.066, 0.056, tailMat, s * 0.58, 0.72, -2.24));
  }
  // full-width tail bar
  const bar = new THREE.Mesh(new THREE.BoxGeometry(1.14, 0.038, 0.044), tailMat);
  bar.position.set(0, 0.72, -2.245);
  body.add(bar);

  // amber turn signals (sein): rear + front, one material per side per car
  // so update() can blink them from car.turnSignal (-1 left, +1 right)
  const signalMatL = new THREE.MeshStandardMaterial({
    color: 0x402304,
    emissive: 0xff9d00,
    emissiveIntensity: 0,
    roughness: 0.3,
  });
  const signalMatR = new THREE.MeshStandardMaterial({
    color: 0x402304,
    emissive: 0xff9d00,
    emissiveIntensity: 0,
    roughness: 0.3,
  });
  for (const s of [-1, 1]) {
    body.add(box(0.2, 0.075, 0.06, s < 0 ? signalMatL : signalMatR, s * 0.86, 0.7, -2.245));
    body.add(box(0.18, 0.07, 0.055, s < 0 ? signalMatL : signalMatR, s * 0.86, 0.63, 2.29));
  }

  // exhausts
  const pipeMat = mat(0x8e969e, { roughness: 0.28, metalness: 0.96 });
  for (const s of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.18, 14, 1, true), pipeMat);
    pipe.rotation.x = Math.PI / 2;
    pipe.position.set(s * 0.32, 0.28, -2.3);
    body.add(pipe);
  }

  // ---------------------------------------------------------------- wheels
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x4a4f55,
    roughness: 0.45,
    metalness: 0.85,
    emissive: new THREE.Color(0xff4a1a),
    emissiveIntensity: 0.1,
  });
  const wheelMeshes = [];
  for (let i = 0; i < 4; i++) {
    const w = buildWheel(cfg, simple, discMat);
    root.add(w.steer);
    wheelMeshes.push(w);
  }

  // a soft contact shadow blob under the car (helps grounding)
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(2.3, 4.6),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = -RIDE_HEIGHT + 0.015;
  blob.renderOrder = 1;
  root.add(blob);

  // Merge after every part exists. The steering wheel has to keep its own
  // hierarchy because update() rotates it, so it is excluded from the body.
  if (steeringWheel) mergeByMaterial(steeringWheel.wheel);
  for (const w of wheelMeshes) mergeByMaterial(w.spin);
  mergeByMaterial(body, steeringWheel ? new Set([steeringWheel.mount]) : null);

  return {
    root,
    body,
    wheels: wheelMeshes,

    /** Copy physics state onto the visual model. */
    update(car) {
      for (let i = 0; i < 4; i++) {
        const wheel = car.wheels[i];
        const visual = wheelMeshes[i];
        visual.steer.position.set(
          wheel.mount.x,
          wheel.mount.y - wheel.suspLen,
          wheel.mount.z,
        );
        visual.steer.rotation.y = wheel.steer;
        visual.spin.rotation.x = wheel.spinAngle;
      }

      if (steeringWheel) {
        const steer = car.telemetry.steer !== undefined ? car.telemetry.steer : car.steerAngle;
        steeringWheel.wheel.rotation.z = steer * 2.4;
      }

      // very subtle brake-light glow
      const braking = car.telemetry.brake > 0.05 || car.telemetry.handbrake;
      tailMat.emissiveIntensity = braking ? 4.5 : 1.6;
      discMat.emissiveIntensity = braking ? 1.5 : 0.1;

      // blinking turn signals (1.5 flashes/s) driven by car.turnSignal
      const sig = car.turnSignal || 0;
      const blinkOn = Math.floor(performance.now() / 333) % 2 === 0;
      signalMatL.emissiveIntensity = sig === -1 && blinkOn ? 2.6 : 0;
      signalMatR.emissiveIntensity = sig === 1 && blinkOn ? 2.6 : 0;
    },

    setVisible(v) {
      root.visible = v;
    },
  };
}
