/**
 * City autonomous-driving test: 10 CityDriver cars on the 5x5 grid.
 *
 *   node scripts/city-sim-test.mjs [seconds]   (default 180)
 *
 * Checks:
 *   - no NaN anywhere
 *   - every car covers real distance (actually driving, not stuck)
 *     (>= 900 m in 180 s ≈ 18 km/h - a healthy city pace with red lights)
 *   - red-light runs: the car must not cross a red stop line at speed
 *   - contacts between cars: few and short
 *   - no car stuck (near standstill) for > 20 s
 *   - cross-track: cars stay on their lane path
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { Vehicle } from '../src/vehicle/vehicle.js';
import { CityDriver } from '../src/city/cityDriver.js';
import {
  CITY,
  createCityLights,
  nodeIndex,
  nodePos,
  nodeName,
} from '../src/city/cityLayout.js';

await RAPIER.init();
// deterministic scenario: same seed -> same sim (needed to trace failures)
let seed = Number(process.env.SEED ?? 20260729);
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
Math.random = rand;
const DT = 1 / 120;
const SECONDS = Number(process.argv[2] ?? 180);
const N = 10;

const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(
  RAPIER.ColliderDesc.cuboid(2500, 0.5, 2500).setTranslation(0, -0.5, 0).setFriction(0.9),
);

const lights = createCityLights();
let cityTime = 0;

// ---- spawn: one car per different segment, mid-segment on the right lane
function spawnSpots(count) {
  const spots = [];
  const used = new Set();
  let guard = 0;
  while (spots.length < count && guard++ < 600) {
    const horiz = Math.random() < 0.5;
    const line = Math.floor(Math.random() * CITY.n);
    const gap = Math.floor(Math.random() * (CITY.n - 1));
    const key = (horiz ? 'h' : 'v') + line + '-' + gap;
    if (used.has(key)) continue;
    used.add(key);
    const d = Math.random() < 0.5 ? 1 : -1;
    const a0 = d > 0 ? gap : gap + 1;
    const a1 = d > 0 ? gap + 1 : gap;
    const nextNode = horiz ? nodeIndex(a1, line) : nodeIndex(line, a1);
    const c0 = (a0 - (CITY.n - 1) / 2) * CITY.pitch;
    const c1 = (a1 - (CITY.n - 1) / 2) * CITY.pitch;
    const linePos = (line - (CITY.n - 1) / 2) * CITY.pitch;
    const segPos = c0 + (c1 - c0) * (0.3 + Math.random() * 0.4);
    const x = horiz ? segPos : linePos;
    const z = horiz ? linePos : segPos;
    const fx = horiz ? d : 0;
    const fz = horiz ? 0 : d;
    const r = { x: fz, z: -fx };
    const pos = new THREE.Vector3(x + r.x * CITY.lane, 0.48, z + r.z * CITY.lane);
    const q = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(fx, 0, fz),
    );
    spots.push({ pos, q, yaw: Math.atan2(fx, fz), nextNode });
  }
  return spots;
}

const cars = [];
const drivers = [];
const spots = spawnSpots(N);
for (let i = 0; i < N; i++) {
  const s = spots[i];
  const car = new Vehicle({ RAPIER, world, position: s.pos, quaternion: s.q });
  const driver = new CityDriver(car, world, lights, () => cityTime);
  driver.reset(s.pos.x, s.pos.z, s.yaw, s.nextNode);
  cars.push(car);
  drivers.push(driver);
}
world.step();

// fleet snapshot for semantic traffic reasoning (left-turn yield uses real
// car positions, not rays - rays "see" buildings and cars yield to walls)
const fleet = { list: Array.from({ length: N }, (_, i) => ({ x: 0, z: 0, dx: 0, dz: 1, car: cars[i] })) };
for (const d of drivers) d.setFleet(() => fleet.list);

// ---- stats
const dist = new Array(N).fill(0);
const prevS = new Array(N).fill(0);
const redRuns = new Array(N).fill(0);
const prevLine = new Array(N).fill(null);
const redStopSeen = new Array(N).fill(0);
const stuck = new Array(N).fill(0);
const maxStuck = new Array(N).fill(0);
const maxCross = new Array(N).fill(0);
const offLane = new Array(N).fill(0);
const stopsRespected = new Array(N).fill(0);
const replans = new Array(N).fill(0);
const prevReplans = drivers.map((d) => d.replans);
const contactPairs = new Map();
const contactFirst = new Map();

let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL: ' + msg); };

const t0 = performance.now();
for (let step = 0; step <= 120 * SECONDS; step++) {
  cityTime += DT;
  if (step % 2 === 0) {
    for (let i = 0; i < N; i++) {
      const t = cars[i].body.translation();
      const q = cars[i].body.rotation();
      fleet.list[i].x = t.x;
      fleet.list[i].z = t.z;
      fleet.list[i].dx = 2 * (q.x * q.z + q.y * q.w);
      fleet.list[i].dz = 1 - 2 * (q.x * q.x + q.y * q.y);
    }
    for (let i = 0; i < N; i++) {
      const st = drivers[i].update(DT * 2);
      cars[i].update(DT * 2, st);
    }
  }
  world.step();

  for (let i = 0; i < N; i++) {
    const car = cars[i];
    const d = drivers[i];
    const v = Math.abs(car.telemetry.speed);
    dist[i] += v * DT;
    if (!Number.isFinite(car.body.translation().x) || !Number.isFinite(car.telemetry.speedKmh)) {
      fail(`car ${i} NaN at t=${(step * DT).toFixed(1)}`);
    }

    // red-light tracking: a violation is the car CROSSING the stop line
    // while red, at v > 5 m/s (creeping through <=5 m/s is lenient).
    // A car braking for a red and stopping before the line is NOT a run.
    const r = d.route;
    if (r) {
      const stop = r.stops[d.stopIdx];
      if (stop) {
        const ds = stop.s - d.s;
        const state = lights.lightFor(stop.node, stop.axis, cityTime);
        if (state === 'red' && ds < 14 && ds > -3) redStopSeen[i]++;
        if (prevLine[i] === null || ds > prevLine[i] + 2) {
          // stopIdx advanced to the next stop: re-anchor
          prevLine[i] = ds;
        } else {
          if (state === 'red' && prevLine[i] > -3 && ds <= -3 && v > 5) {
            redRuns[i]++;
          }
          prevLine[i] = ds;
        }
      } else {
        prevLine[i] = null;
      }
      // stuck: near standstill for a long time
      if (car.telemetry.speedKmh < 2) {
        stuck[i] += DT;
        maxStuck[i] = Math.max(maxStuck[i], stuck[i]);
      } else {
        stuck[i] = 0;
      }
      const c = Math.abs(d.crossTrack || 0);
      maxCross[i] = Math.max(maxCross[i], c);
      if (c > 3) offLane[i] += DT;
    }
    replans[i] += d.replans - prevReplans[i];
    prevReplans[i] = d.replans;
    void prevS[i];
    prevS[i] = d.s;
  }

  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      let touching = false;
      world.contactPair(cars[i].collider, cars[j].collider, (manifold) => {
        if (manifold.numContacts() > 0) touching = true;
      });
      if (touching) {
        const key = `${i}-${j}`;
        contactPairs.set(key, (contactPairs.get(key) ?? 0) + 1);
        if (!contactFirst.has(key)) contactFirst.set(key, step * DT);
      }
    }
  }
}
const wall = (performance.now() - t0) / 1000;

console.log(`\nsimulated ${SECONDS}s with ${N} autonomous city cars in ${wall.toFixed(1)}s wall time ` +
  `(${(SECONDS / wall).toFixed(2)}x real time)\n`);
console.log('car   dist(m)  avg km/h  maxCross  offlane   redRuns  maxStuck  replans  route');
for (let i = 0; i < N; i++) {
  const d = drivers[i];
  const dest = d.route?.dest ? nodeName(d.route.dest.node) : '—';
  console.log(
    `${String(i).padStart(2)}    ` +
    `${dist[i].toFixed(0).padStart(6)}   ` +
    `${((dist[i] / SECONDS) * 3.6).toFixed(0).padStart(8)}   ` +
    `${maxCross[i].toFixed(2).padStart(9)}  ` +
    `${offLane[i].toFixed(1).padStart(8)}  ` +
    `${String(redRuns[i]).padStart(8)}  ` +
    `${maxStuck[i].toFixed(1).padStart(9)}  ` +
    `${String(replans[i]).padStart(8)}   ` +
    dest,
  );
}

const pairCount = contactPairs.size;
const contactSeconds = [...contactPairs.values()].reduce((a, b) => a + b, 0) * DT;
console.log(`\ntotal distance  : ${dist.reduce((a, b) => a + b, 0).toFixed(0)} m`);
console.log(`red-light runs  : ${dist.length ? redRuns.reduce((a, b) => a + b, 0) : 0} (expect < 5)`);
console.log(`max stuck time  : ${Math.max(...maxStuck).toFixed(1)} s (expect < 20)`);
console.log(`max cross-track : ${Math.max(...maxCross).toFixed(2)} m (expect < ~2.5)`);
console.log(`off-lane total  : ${offLane.reduce((a, b) => a + b, 0).toFixed(1)} s`);
console.log(`replans total   : ${replans.reduce((a, b) => a + b, 0)}`);
console.log(`car contacts    : ${pairCount} pair(s), ${contactSeconds.toFixed(2)} s total`);
if (pairCount > 0) {
  console.log('contact detail  : ' + [...contactPairs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}=${(v * DT).toFixed(2)}s@${contactFirst.get(k).toFixed(1)}s`)
    .join('  '));
}

// ---- assertions
const anyNaN = cars.some(
  (c) => !Number.isFinite(c.body.translation().x) || !Number.isFinite(c.body.translation().z) || !Number.isFinite(c.telemetry.speedKmh),
);
if (anyNaN) fail('NaN state detected');
const short = dist.filter((x) => x < 900).length;
if (short > 0) fail(`${short} car(s) drove less than 900 m in ${SECONDS}s`);
const redTotal = redRuns.reduce((a, b) => a + b, 0);
if (redTotal >= 5) fail(`${redTotal} red-light runs (>= 5)`);
if (Math.max(...maxStuck) >= 20) fail(`a car was stuck for ${Math.max(...maxStuck).toFixed(1)} s (>= 20)`);
if (Math.max(...maxCross) > 3.5) fail(`cross-track reached ${Math.max(...maxCross).toFixed(2)} m`);
if (contactSeconds > 8) fail(`contacts lasted ${contactSeconds.toFixed(1)} s (> 8)`);

console.log(failures === 0 ? '\nPASS: city autonomous simulation healthy' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
