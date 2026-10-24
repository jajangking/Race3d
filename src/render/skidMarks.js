import * as THREE from 'three';

/**
 * Skid marks. A ring buffer of ground-projected quads. Every frame each wheel
 * that is sliding beyond the tyre's grip peak extends its own trail by one
 * quad, so lock-ups (longitudinal slip) and drifts (lateral slip) both leave a
 * mark. Old marks are simply overwritten once the buffer wraps, which keeps
 * memory and draw calls constant.
 */

const MAX_QUADS = 3000;
const VERTS_PER_QUAD = 6;
const MIN_SEGMENT = 0.3; // metres between quads
const HALF_WIDTH = 0.11;
const MARK_Y = 0.045;

export function createSkidMarks(scene) {
  const position = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * 3);
  const color = new Float32Array(MAX_QUADS * VERTS_PER_QUAD * 4);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(color, 4));

  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  scene.add(mesh);

  let head = 0;

  // per-wheel trail state
  const trails = new Map();

  const reset = () => {
    head = 0;
    position.fill(0);
    color.fill(0);
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    trails.clear();
  };

  const pushQuad = (x0, z0, x1, z1, alpha) => {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return;

    const nx = (-dz / len) * HALF_WIDTH;
    const nz = (dx / len) * HALF_WIDTH;

    const i = head * VERTS_PER_QUAD;
    const p = i * 3;
    const c = i * 4;

    // triangle 1: a b c   triangle 2: a c d
    const ax = x0 + nx, az = z0 + nz;
    const bx = x0 - nx, bz = z0 - nz;
    const cx = x1 - nx, cz = z1 - nz;
    const ox = x1 + nx, oz = z1 + nz;

    position.set([ax, MARK_Y, az, bx, MARK_Y, bz, cx, MARK_Y, cz], p);
    position.set([ax, MARK_Y, az, cx, MARK_Y, cz, ox, MARK_Y, oz], p + 9);

    // dark rubber, alpha carries how hard the tyre was sliding
    for (let v = 0; v < VERTS_PER_QUAD; v++) {
      const o = c + v * 4;
      color[o] = 0.03;
      color[o + 1] = 0.03;
      color[o + 2] = 0.035;
      color[o + 3] = alpha;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;

    head = (head + 1) % MAX_QUADS;
  };

  const update = (car) => {
    const speed = Math.abs(car.telemetry.speed);

    for (const wheel of car.wheels) {
      let trail = trails.get(wheel);
      if (!trail) {
        trail = { x: 0, z: 0, active: false };
        trails.set(wheel, trail);
      }

      const sliding =
        wheel.grounded &&
        speed > 1.2 &&
        wheel.load > 400 &&
        (Math.abs(wheel.slipRatio) > 0.18 || Math.abs(wheel.slipAngle) > 0.14);

      if (!sliding) {
        trail.active = false;
        continue;
      }

      const x = wheel.contact.x;
      const z = wheel.contact.z;

      if (!trail.active) {
        trail.x = x;
        trail.z = z;
        trail.active = true;
        continue;
      }

      const dist = Math.hypot(x - trail.x, z - trail.z);
      if (dist < MIN_SEGMENT) continue;
      // teleport / respawn guard
      if (dist > 4) {
        trail.x = x;
        trail.z = z;
        continue;
      }

      const slide = Math.max(
        Math.abs(wheel.slipRatio) - 0.16,
        (Math.abs(wheel.slipAngle) - 0.1) * 0.9,
      );
      const alpha = Math.min(0.62, 0.18 + slide * 0.65);

      pushQuad(trail.x, trail.z, x, z, alpha);
      trail.x = x;
      trail.z = z;
    }
  };

  return { update, reset, mesh };
}
