import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';

import { Vehicle } from './vehicle/vehicle.js';
import { CAR } from './vehicle/config.js';
import { createTrack } from './render/track.js';
import { createCarMesh } from './render/carMesh.js';
import { createSkidMarks } from './render/skidMarks.js';
import { ChaseCamera } from './render/chaseCamera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { AIDriver } from './ai/aiDriver.js';

// ------------------------------------------------------------------ physics
const FIXED_DT = 1 / 120;

await RAPIER.init();

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = FIXED_DT;
// One enormous static box is the whole collision world: the track is drawn on
// top of it. Cheaper and more stable than tiling the surface.
world.createCollider(
  RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500)
    .setTranslation(0, -0.5, 0)
    .setFriction(0.9),
);

// ------------------------------------------------------------------ renderer
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xb9cfe0, 260, 1500);

const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.3, 6000);

// studio-ish reflections so the paint and rims don't look flat outdoors
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.05);
  scene.environment = env.texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
}

// ---------------------------------------------------------------------- sky
{
  const skyGeo = new THREE.SphereGeometry(4200, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x1f548f) },
      mid: { value: new THREE.Color(0x8dbde4) },
      bottom: { value: new THREE.Color(0xd8e7f0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 top;
      uniform vec3 mid;
      uniform vec3 bottom;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        vec3 c = mix(bottom, mid, smoothstep(-0.02, 0.16, h));
        c = mix(c, top, smoothstep(0.12, 0.65, h));
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeo, skyMat);
  sky.frustumCulled = false;
  scene.add(sky);
  scene.userData.sky = sky;
}

// -------------------------------------------------------------------- lights
const hemi = new THREE.HemisphereLight(0xcfe4ff, 0x3d4a2e, 0.85);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff1d6, 2.6);
sun.position.set(55, 80, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -42;
sun.shadow.camera.right = 42;
sun.shadow.camera.top = 42;
sun.shadow.camera.bottom = -42;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 260;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.025;
scene.add(sun);
scene.add(sun.target);

// --------------------------------------------------------------------- track
const track = createTrack(scene);

// ----------------------------------------------------------------------- car
const spawn = new THREE.Vector3(track.start.x, 0.46, track.start.z);
const car = new Vehicle({
  RAPIER,
  world,
  position: spawn,
  quaternion: track.startQuat,
});
// scene queries need one step before the raycasts work
world.step();

const carMesh = createCarMesh(CAR);
scene.add(carMesh.root);
carMesh.root.visible = true;

// opponent AI
const opponentSpawn = spawn.clone();
const tanSpawn = track.startTangent.clone().setY(0).normalize();
opponentSpawn.copy(spawn).add(tanSpawn.clone().multiplyScalar(5));
const opponent = new Vehicle({
  RAPIER,
  world,
  position: opponentSpawn,
  quaternion: track.startQuat,
});
world.step();
const opponentMesh = createCarMesh({ ...CAR });
scene.add(opponentMesh.root);
opponentMesh.root.visible = true;
const ai = new AIDriver(opponent, track, { enabled: true }, world);

const skidMarks = createSkidMarks(scene);

const chase = new ChaseCamera(camera, track);
chase.snap(car);

// --------------------------------------------------------------------- input
const input = new Input();
const hud = new Hud();
hud.setAssist('tc', car.assists.tc);
hud.setAssist('esc', car.assists.esc);
hud.el.abs.textContent = 'LOCK';

input.on('respawn', () => respawn());
input.on('camera', () => chase.cycle());
input.on('tc', () => {
  car.assists.tc = !car.assists.tc;
  hud.setAssist('tc', car.assists.tc);
});
input.on('esc', () => {
  car.assists.esc = !car.assists.esc;
  hud.setAssist('esc', car.assists.esc);
});

// --------------------------------------------------------------- start gate
let started = false;
let sessionTime = 0;
let running = true;

const intro = document.getElementById('intro');
const startBtn = document.getElementById('start');

function begin() {
  if (started) return;
  started = true;
  if (intro) intro.classList.add('is-hidden');
  hud.show();
  document.body.classList.add('is-playing');
  sessionTime = 0;
  respawn();
  clock.last = performance.now();
}

if (startBtn) {
  startBtn.addEventListener('click', begin, { passive: true });
  startBtn.addEventListener('touchend', (e) => {
    e.preventDefault();
    begin();
  }, { passive: false });
}
input.on('start', begin);

// handy for headless screenshots / automated checks
const params = new URLSearchParams(location.search);
const autoThrottle = params.get('throttle');
const autoSteer = Number(params.get('steer') ?? 0);
if (params.has('auto')) setTimeout(begin, 30);
if (params.has('cam')) chase.mode = Number(params.get('cam'));

document.getElementById('respawn').addEventListener('click', () => respawn());

// -------------------------------------------------------------- 0-100 timing
let launchState = 'armed';
let launchTime = 0;
let best100 = null;

function trackLaunch(dt, tm) {
  const stopped = Math.abs(tm.speed) < 0.7;
  if (launchState === 'armed') {
    if (tm.throttle > 0.15) {
      launchState = 'running';
      launchTime = 0;
    }
  } else if (launchState === 'running') {
    launchTime += dt;
    if (tm.speedKmh >= 100) {
      if (!best100 || launchTime < best100) {
        best100 = launchTime;
        hud.setBest(best100);
      }
      launchState = 'done';
    } else if (tm.speedKmh < 0.6 || launchTime > 30) {
      launchState = 'armed';
    }
  } else if (stopped && tm.throttle < 0.05) {
    launchState = 'armed';
  }
}

// ------------------------------------------------------------------ respawn
const _nearest = new THREE.Vector3();
const _tan = new THREE.Vector3();

function nearestOnTrack(pos) {
  // coarse arc-length search; the track is ~1.3 km so 600 samples is plenty
  let best = Infinity;
  let bestU = 0;
  for (let i = 0; i < 600; i++) {
    const u = i / 600;
    track.curve.getPointAt(u, _nearest);
    const d = _nearest.distanceToSquared(pos);
    if (d < best) {
      best = d;
      bestU = u;
    }
  }
  return bestU;
}

function respawn() {
  const t = car.body.translation();
  const u = nearestOnTrack(new THREE.Vector3(t.x, 0, t.z));
  track.curve.getPointAt(u, _nearest);
  track.curve.getTangentAt(u, _tan);
  const q = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    _tan.clone().setY(0).normalize(),
  );
  car.reset(new THREE.Vector3(_nearest.x, 0.48, _nearest.z), q);
  car.drivetrain.gear = 1;
  // respawn opponent - spawn in front on track
  const ou = (u + 0.02) % 1;
  track.curve.getPointAt(ou, _nearest);
  track.curve.getTangentAt(ou, _tan);
  const oq = new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 0, 1),
    _tan.clone().setY(0).normalize(),
  );
  opponent.reset(new THREE.Vector3(_nearest.x, 0.48, _nearest.z), oq);
  if (opponent.drivetrain) { opponent.drivetrain.gear = 1; opponent.drivetrain.shiftTimer = 0; opponent.drivetrain.shiftCooldown = 0; }
  ai.mode = 'race';
  ai.stuckTime = 0;
  ai.recoverTime = 0;
  ai.spawnGrace = 0;
  skidMarks.reset();
  world.step();
  chase.snap(car);
  launchState = 'armed';
}

// -------------------------------------------------------------------- resize
const onResize = () => {
  const w = innerWidth;
  const h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(w, h);
};
onResize();

document.addEventListener('visibilitychange', () => {
  running = !document.hidden;
  clock.last = performance.now();
});

// --------------------------------------------------------------- main loop
const clock = { last: performance.now() };
let accumulator = 0;

const idle = { throttle: 0, brake: 0, steer: 0, handbrake: false };

function frame(now) {
  requestAnimationFrame(frame);
  if (!running) {
    clock.last = now;
    return;
  }

  const dt = Math.min((now - clock.last) / 1000, 0.1);
  clock.last = now;

  let state = idle;
  if (started) {
    state = input.update(dt);
    if (autoThrottle !== null) {
      state.throttle = Number(autoThrottle) || 1;
      state.steer = autoSteer;
    }
    sessionTime += dt;

    // fixed-step physics with a spiral-of-death guard
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 8) {
      car.update(FIXED_DT, state);
      const aiState = ai.update(FIXED_DT);
      opponent.update(FIXED_DT, aiState);
      world.step();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 8) accumulator = 0;

    trackLaunch(dt, car.telemetry);
    hud.update(car, sessionTime);
  }

  const pVis = car.body.translation();
  const qVis = car.body.rotation();
  carMesh.root.position.set(pVis.x, pVis.y, pVis.z);
  carMesh.root.quaternion.set(qVis.x, qVis.y, qVis.z, qVis.w);

  const op = opponent.body.translation();
  const oq = opponent.body.rotation();
  opponentMesh.root.position.set(op.x, op.y, op.z);
  opponentMesh.root.quaternion.set(oq.x, oq.y, oq.z, oq.w);

  carMesh.update(car);
  opponentMesh.update(opponent);
  skidMarks.update(car);
  chase.update(dt, car);

  // shadow frustum follows the car
  const p = car.body.translation();
  sun.position.set(p.x + 55, p.y + 80, p.z + 35);
  sun.target.position.set(p.x, p.y, p.z);
  sun.target.updateMatrixWorld();

  scene.userData.sky.position.set(camera.position.x, 0, camera.position.z);

  // fell off the world somehow? put it back on the circuit
  if (p.y < -8) respawn();

  renderer.render(scene, camera);
}

carMesh.update(car);
requestAnimationFrame(frame);

// exposed for debugging from the console
window.race3d = { car, world, scene, camera, chase, input, respawn, begin, track };
