import * as THREE from 'three';

function smokeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(230, 230, 230, 0.22)');
  grad.addColorStop(0.35, 'rgba(190, 190, 190, 0.12)');
  grad.addColorStop(0.7, 'rgba(150, 150, 150, 0.06)');
  grad.addColorStop(1, 'rgba(120, 120, 120, 0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createTireSmoke(scene) {
  const MAX = 700;
  const geometry = new THREE.BufferGeometry();

  const position = new Float32Array(MAX * 3);
  const velocity = new Float32Array(MAX * 3);
  const life = new Float32Array(MAX);
  const maxLife = new Float32Array(MAX);
  const size = new Float32Array(MAX);

  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));

  const material = new THREE.PointsMaterial({
    map: smokeTexture(),
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    size: 0.9,
    sizeAttenuation: true,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 3;
  scene.add(points);

  let head = 0;
  const v = new THREE.Vector3();

  // PointsMaterial has no per-point alpha, so every point in the buffer is
  // drawn every frame. A dead particle must be parked far below the world
  // (y = -9999) instead of being left at its last position - otherwise it
  // lingers as a faint grey dot on the road until the ring wraps around,
  // and reset() used to collapse all 700 of them to the world origin.
  const HIDDEN_Y = -9999;
  const hideAll = () => {
    for (let i = 0; i < MAX; i++) position[i * 3 + 1] = HIDDEN_Y;
  };
  hideAll();

  function emit(x, y, z, vx, vz, power) {
    const i = head;
    head = (head + 1) % MAX;
    const base = i * 3;

    position[base + 0] = x + (Math.random() - 0.5) * 0.12;
    position[base + 1] = y + 0.02 + Math.random() * 0.04;
    position[base + 2] = z + (Math.random() - 0.5) * 0.12;

    velocity[base + 0] = (vx + (Math.random() - 0.5) * 0.6) * 0.25 + (Math.random() - 0.5) * power * 0.4;
    velocity[base + 1] = (Math.random() * 0.5 + 0.25) * power * 0.6;
    velocity[base + 2] = (vz + (Math.random() - 0.5) * 0.6) * 0.25 + (Math.random() - 0.5) * power * 0.4;

    life[i] = 0;
    maxLife[i] = 0.6 + Math.random() * 0.7;
    size[i] = 0.4 + Math.random() * 0.6 + power * 0.4;
  }

  function reset() {
    life.fill(0);
    maxLife.fill(0);
    velocity.fill(0);
    size.fill(0);
    hideAll();
    head = 0;
    geometry.attributes.position.needsUpdate = true;
  }

  function update(dt, car) {
    const speed = Math.abs(car.telemetry.speed);
    const vel = car.body.linvel();
    v.set(vel.x, 0, vel.z);

    for (let w = 0; w < car.wheels.length; w++) {
      const wheel = car.wheels[w];
      if (!wheel.grounded) continue;
      if (wheel.load < 250) continue;

      const slipRatio = Math.abs(wheel.slipRatio || 0);
      const slipAngle = Math.abs(wheel.slipAngle || 0);

      // Burnout / wheelspin
      let burn = false;
      let power = 0;
      if (wheel.driven && speed < 40 && slipRatio > 0.28) {
        burn = true;
        power = Math.min(1.0, slipRatio * 1.4);
      }
      // Drift / heavy lateral slip
      if (!burn && slipAngle > 0.22 && speed > 6) {
        burn = true;
        power = Math.min(1.0, slipAngle * 1.2);
      }
      // Combined big slip
      if (!burn && (slipRatio > 0.18 && slipAngle > 0.18) && speed > 8) {
        burn = true;
        power = Math.min(1.0, (slipRatio + slipAngle) * 0.8);
      }

      if (burn && power > 0.16) {
        const rate = power * 0.5;
        if (Math.random() < rate) {
          const c = wheel.contact;
          emit(c.x, c.y, c.z, v.x, v.z, power);
        }
      }
    }

    for (let i = 0; i < MAX; i++) {
      if (life[i] >= maxLife[i]) continue;
      life[i] += dt;
      if (life[i] >= maxLife[i]) {
        position[i * 3 + 1] = HIDDEN_Y;
        continue;
      }
      const base = i * 3;
      position[base + 0] += velocity[base + 0] * dt;
      position[base + 1] += velocity[base + 1] * dt;
      position[base + 2] += velocity[base + 2] * dt;
      velocity[base + 0] *= 0.9;
      velocity[base + 1] *= 0.88;
      velocity[base + 2] *= 0.9;
    }

    geometry.attributes.position.needsUpdate = true;
  }

  return { update, reset, mesh: points };
}
