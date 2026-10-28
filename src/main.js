import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';

import { Vehicle } from './vehicle/vehicle.js';
import { CAR } from './vehicle/config.js';
import { createTrack } from './render/track.js';
import { createScenery } from './render/scenery.js';
import { createCarMesh } from './render/carMesh.js';
import { createSkidMarks } from './render/skidMarks.js';
import { createTireSmoke } from './render/tireSmoke.js';
import { ChaseCamera } from './render/chaseCamera.js';
import { SpectatorCamera } from './render/spectatorCamera.js';
import { Input } from './input.js';
import { Hud } from './hud.js';
import { AIDriver } from './ai/aiDriver.js';

// ------------------------------------------------------------------ physics
const FIXED_DT = 1 / 120;
let aiTick = 0;

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
// long atmospheric fade: the world has hills on the horizon now
scene.fog = new THREE.Fog(0xc2d4e2, 350, 2600);

// near/far kept tight (hills end ~2.6 km): tight planes give ~1.7x better
// depth precision than 0.3/6000, which stops road markings z-fighting.
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.5, 3000);

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
  const skyGeo = new THREE.SphereGeometry(2900, 32, 16);
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

// the field's livery, also used to paint the pit boxes and building facade
const OPPONENT_COLORS = [
  0xe23b2f, 0xf08a24, 0xf2c230, 0x2fae58, 0x18b6a6,
  0x7a4fd0, 0xd84a9f, 0xe8eef4, 0x6b7480, 0x8c1b1b,
];

// --------------------------------------------------------------------- track
const track = createTrack(scene);
createScenery(scene, track, [0x1f6bff, ...OPPONENT_COLORS]);

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

// number 1 = player; a white centre stripe marks it as "your car"
const carMesh = createCarMesh({ ...CAR, number: '1', stripe: true });
scene.add(carMesh.root);
carMesh.root.visible = true;

// ---------------------------------------------------------------- opponents
// A small field of AI cars on a staggered grid. Each one has a slightly
// different speed target so the pack spreads out and they actually overtake.
const OPPONENT_COUNT = 10;
const GRID_ROW_GAP = 12;   // m between rows
const GRID_COL_OFFSET = 3; // m left/right of the centreline

// Deterministic driver setups. Pace scales the shared grip-limited profile,
// lineScale is how much of the racing line a car uses, and laneBias gives the
// pack a natural spread instead of ten identical trajectories.
// Tight pace spread (~0.8%): the follow governor only re-syncs cars within
// ~30 m, so any car running free (the leader, or a gap ahead of it) escapes
// at its own pace. A wide spread let fast cars peel away and stretch the
// field into 200-350 m gaps between clusters. Kept tight so the pack holds.
const OPPONENT_PACE = [1.002, 1.004, 0.998, 1.005, 1.001, 1.003, 0.997, 1.004, 1.0, 1.002];
const OPPONENT_LINE = [0.96, 1.0, 0.92, 0.99, 0.94, 0.97, 0.9, 0.98, 0.95, 0.93];
const OPPONENT_BIAS = [0.2, -0.25, -0.4, 0.4, 0.0, -0.1, 0.35, -0.35, 0.1, -0.2];

function gridPose(baseU, distance, lateral) {
  const u = (baseU + distance / track.length + 1) % 1;
  const p = track.curve.getPointAt(u, new THREE.Vector3());
  const t = track.curve.getTangentAt(u, new THREE.Vector3()).setY(0).normalize();
  const right = new THREE.Vector3(t.z, 0, -t.x);
  const pos = p.clone().addScaledVector(right, lateral).setY(0.48);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), t);
  return { pos, q, u };
}

const opponents = [];
for (let i = 0; i < OPPONENT_COUNT; i++) {
  const row = Math.floor(i / 2);
  const col = i % 2;
  const slot = gridPose(0, GRID_ROW_GAP * (row + 1), col === 0 ? -GRID_COL_OFFSET : GRID_COL_OFFSET);
  const opponentCar = new Vehicle({
    RAPIER,
    world,
    position: slot.pos,
    quaternion: slot.q,
  });
  const paint = OPPONENT_COLORS[i];
  const paintDark = new THREE.Color(paint).multiplyScalar(0.62).getHex();
  const mesh = createCarMesh({ ...CAR, paint, paintDark, simple: true, number: String(i + 2) });
  scene.add(mesh.root);
  // laneOffset is only used during the launch phase: it holds the grid
  // column until the field is rolling, then the racing line takes over.
  const laneOffset = (col === 0 ? -GRID_COL_OFFSET : GRID_COL_OFFSET) + (((i * 5) % 7) - 3) * 0.18;
  const driver = new AIDriver(opponentCar, track, {
    enabled: true,
    pace: OPPONENT_PACE[i],
    lineScale: OPPONENT_LINE[i],
    laneBias: OPPONENT_BIAS[i],
    laneOffset,
    parity: i % 2,
  }, world);
  driver.u = slot.u;
  opponents.push({ car: opponentCar, mesh, driver, laneOffset });
}
world.step();

const skidMarks = createSkidMarks(scene);
const tireSmoke = createTireSmoke(scene);

const chase = new ChaseCamera(camera, track);
chase.snap(car);

// Spectator (AI vs AI) mode: the player's car joins the field as the 11th AI
// car and the player watches with TV / orbit / cinematic / drone cameras.
const spectator = new SpectatorCamera(camera, canvas, track);
let spectate = false;
let focusIdx = 0;
let lastLeaderIdx = 0;
const race = { laps: [], prevU: [], progress: [] };

// --------------------------------------------------------------------- input
const input = new Input();
const hud = new Hud();
hud.setAssist('tc', car.assists.tc);
hud.setAssist('esc', car.assists.esc);
hud.el.abs.textContent = 'LOCK';

input.on('respawn', () => respawn());

const cammodeEl = document.getElementById('cammode');
function cycleCamera() {
  if (spectate) {
    const mode = spectator.cycle();
    hud.setCamMode(spectator.label);
    document.body.classList.toggle('is-cinematic', mode === 'cinematic');
  } else {
    chase.cycle();
  }
}
function cycleFocus() {
  if (!spectate || opponents.length === 0) return;
  focusIdx = (focusIdx + 1) % opponents.length;
  spectator.refocus(opponents[focusIdx].car);
}
input.on('camera', cycleCamera);
input.on('focus', cycleFocus);
// touch port of the C / T / Y keys (this game is primarily played on phones)
document.getElementById('btn-cam')?.addEventListener('click', cycleCamera);
document.getElementById('btn-car')?.addEventListener('click', cycleFocus);
document.getElementById('btn-cam-hud')?.addEventListener('click', cycleCamera);
const toggleTC = () => {
  car.assists.tc = !car.assists.tc;
  hud.setAssist('tc', car.assists.tc);
};
const toggleESC = () => {
  car.assists.esc = !car.assists.esc;
  hud.setAssist('esc', car.assists.esc);
};
input.on('tc', toggleTC);
input.on('esc', toggleESC);
document.getElementById('pill-tc')?.addEventListener('click', toggleTC);
document.getElementById('pill-esc')?.addEventListener('click', toggleESC);

// --------------------------------------------------------------- start gate
let started = false;
let sessionTime = 0;
let running = true;

const intro = document.getElementById('intro');
const startBtn = document.getElementById('start');
const startWatchBtn = document.getElementById('start-watch');

function begin(mode = 'drive') {
  if (started) return;
  started = true;
  spectate = mode === 'spectate';
  if (intro) intro.classList.add('is-hidden');
  hud.show();
  document.body.classList.add('is-playing');
  if (spectate) {
    // the player's car becomes the 11th AI car: same Vehicle, same driver
    // class, just a different paint. The field races itself.
    const driver = new AIDriver(car, track, {
      enabled: true,
      pace: 1.0,
      lineScale: 0.97,
      laneBias: 0,
      laneOffset: 0,
      parity: 0,
    }, world);
    driver.u = 0;
    opponents.push({ car, mesh: carMesh, driver, laneOffset: 0, isPlayer: true });
    race.laps = opponents.map(() => 0);
    race.prevU = opponents.map(() => 0);
    race.progress = opponents.map(() => 0);
    document.body.classList.add('is-spectate');
    spectator.enabled = true;
    hud.setCamMode(spectator.label);
    hud.buildStandings(opponents.map((o, i) => ({
      name: o.isPlayer ? 'YOU' : String(i).padStart(2, '0'),
      color: o.isPlayer ? 0x1f6bff : OPPONENT_COLORS[i],
    })));
  }
  sessionTime = 0;
  respawn();
  clock.last = performance.now();
}

function bindStart(el, mode) {
  if (!el) return;
  el.addEventListener('click', () => begin(mode), { passive: true });
  el.addEventListener('touchend', (e) => {
    e.preventDefault();
    begin(mode);
  }, { passive: false });
}
bindStart(startBtn, 'drive');
bindStart(startWatchBtn, 'spectate');
input.on('start', () => begin('drive'));

// handy for headless screenshots / automated checks
const params = new URLSearchParams(location.search);
const autoThrottle = params.get('throttle');
const autoSteer = Number(params.get('steer') ?? 0);
if (params.has('auto')) {
  setTimeout(() => begin(params.get('mode') === 'spectate' ? 'spectate' : 'drive'), 30);
}
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
  // put the whole field back on a grid ahead of the player
  for (let i = 0; i < opponents.length; i++) {
    const row = Math.floor(i / 2);
    const col = i % 2;
    const slot = gridPose(u, GRID_ROW_GAP * (row + 1), col === 0 ? -GRID_COL_OFFSET : GRID_COL_OFFSET);
    const o = opponents[i];
    o.car.reset(slot.pos, slot.q);
    o.car.drivetrain.gear = 1;
    o.car.drivetrain.shiftTimer = 0;
    o.car.drivetrain.shiftCooldown = 0;
    o.driver.mode = 'race';
    o.driver.u = (u + (GRID_ROW_GAP * (row + 1)) / track.length) % 1;
    o.driver.spawnGrace = 0;
    o.driver.stuckTime = 0;
    o.driver.blockedTime = 0;
    o.driver.idleTime = 0;
    o.driver.recoverTime = 0;
    o.driver.flippedTime = 0;
    o.driver.avoidSide = 0;
    o.driver.avoidHold = 0;
    o.driver.prevError = 0;
    o.driver.lastSpeed = 0;
    o.driver._lastBlocking = o.driver.sensors.maxDist;
    o.driver._closing = 0;
    o.driver.sensors._cooldown = 0;
    o.driver.sensors._empty();
    if (spectate) {
      race.laps[i] = 0;
      race.prevU[i] = o.driver.u;
      race.progress[i] = o.driver.u;
    }
  }
  skidMarks.reset();
  tireSmoke.reset();
  aiTick = 0;
  world.step();
  if (spectate) {
    // snap the spectator camera onto the field (focus car on the next frame)
    spectator.initialised = false;
  } else {
    chase.snap(car);
  }
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

// ------------------------------------------------------- spectator race state
let lastStandingsAt = 0;

/** Track laps/progress for every car in the field (spectator mode). */
function refreshRace() {
  let leader = 0;
  for (let i = 0; i < opponents.length; i++) {
    const u = opponents[i].driver.u;
    const p = race.prevU[i];
    if (p > 0.85 && u < 0.15) race.laps[i]++;
    else if (p < 0.15 && u > 0.85) race.laps[i] = Math.max(0, race.laps[i] - 1);
    race.prevU[i] = u;
    race.progress[i] = race.laps[i] + u;
    if (i > 0 && race.progress[i] > race.progress[leader]) leader = i;
  }
  lastLeaderIdx = leader;
}

function buildStandingsRows(focusNow) {
  const order = opponents.map((_, i) => i);
  order.sort((a, b) => race.progress[b] - race.progress[a]);
  return order.map((idx, rank) => ({
    idx,
    rank,
    lap: race.laps[idx] + 1,
    isFocus: idx === focusNow,
  }));
}

// --------------------------------------------------------------- main loop
const clock = { last: performance.now() };
let accumulator = 0;
// Opponents run their vehicle forces at 60 Hz while the Rapier world still
// steps at 120 Hz. Rapier keeps the last applied force between steps, so the
// car effectively gets the same impulse for a fraction of the CPU cost. This
// is what makes ten full raycast-vehicle opponents viable on a phone.

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
  let focusCar = car;
  let focusDriver = null;
  if (started) {
    if (!spectate) {
      state = input.update(dt);
      if (autoThrottle !== null) {
        state.throttle = Number(autoThrottle) || 1;
        state.steer = autoSteer;
      }
    }
    sessionTime += dt;

    // fixed-step physics with a spiral-of-death guard. In spectator mode the
    // player's car is in `opponents` (the 11th AI), so the single loop below
    // drives every car in the field.
    accumulator += dt;
    let steps = 0;
    while (accumulator >= FIXED_DT && steps < 8) {
      if (!spectate) car.update(FIXED_DT, state);
      if ((aiTick & 1) === 0) {
        for (let i = 0; i < opponents.length; i++) {
          const o = opponents[i];
          const aiState = o.driver.update(FIXED_DT * 2);
          o.car.update(FIXED_DT * 2, aiState);
        }
      }
      aiTick++;
      world.step();
      accumulator -= FIXED_DT;
      steps++;
    }
    if (steps === 8) accumulator = 0;

    trackLaunch(dt, car.telemetry);

    if (spectate) {
      refreshRace();
      const fi = spectator.mode === 'tv' ? lastLeaderIdx : focusIdx;
      focusCar = opponents[fi].car;
      focusDriver = opponents[fi].driver;
      hud.update(focusCar, sessionTime);
      if (performance.now() - lastStandingsAt > 250) {
        lastStandingsAt = performance.now();
        hud.updateStandings(buildStandingsRows(fi));
        // the TV/cinematic labels change shot-to-shot, not just on C
        hud.setCamMode(spectator.label);
      }
    } else {
      hud.update(car, sessionTime);
    }
  }

  const pVis = car.body.translation();
  const qVis = car.body.rotation();
  carMesh.root.position.set(pVis.x, pVis.y, pVis.z);
  carMesh.root.quaternion.set(qVis.x, qVis.y, qVis.z, qVis.w);

  for (let i = 0; i < opponents.length; i++) {
    const o = opponents[i];
    const op = o.car.body.translation();
    const oq = o.car.body.rotation();
    o.mesh.root.position.set(op.x, op.y, op.z);
    o.mesh.root.quaternion.set(oq.x, oq.y, oq.z, oq.w);
    o.mesh.update(o.car);
  }

  carMesh.update(car);
  skidMarks.update(car);
  tireSmoke.update(dt, car);
  if (started && spectate) spectator.update(dt, focusCar, focusDriver);
  else if (!spectate) chase.update(dt, car);

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
window.race3d = { car, opponents, world, scene, camera, chase, input, respawn, begin, track };
