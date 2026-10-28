/**
 * End-to-end: feed the REAL Input class (slider / keyboard) into a REAL
 * Vehicle and measure which way the heading actually rotates.
 * This is the ground truth for "is steering reversed".
 */
// ---- DOM shims (needed by input.js) ----
const listeners = new Map();
function makeEl(id) {
  const el = {
    id, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    _attrs: {},
    addEventListener(type, fn) {
      if (!listeners.has(el)) listeners.set(el, {});
      (listeners.get(el)[type] ??= []).push(fn);
    },
    removeEventListener() {}, setPointerCapture() {},
    setAttribute(k, v) { this._attrs[k] = v; }, getAttribute(k) { return this._attrs[k]; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 48 }; },
    querySelector() { return makeEl(id + '-knob'); }, querySelectorAll() { return []; },
    textContent: '',
  };
  return el;
}
const els = {};
for (const id of ['touchSteer', 'touchGas', 'touchBrake']) els[id] = makeEl(id);
globalThis.document = {
  getElementById: (id) => els[id] ?? null,
  querySelector: (sel) => (sel.includes('data-action') ? [] : null),
  querySelectorAll: () => [],
  body: { classList: { add() {}, remove() {} } },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(globalThis)) listeners.set(globalThis, {});
  (listeners.get(globalThis)[type] ??= []).push(fn);
};
globalThis.removeEventListener = () => {};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

// ---- physics + vehicle ----
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
await RAPIER.init();
const DT = 1 / 120;
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.timestep = DT;
world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(0.9));
const { Vehicle } = await import('../src/vehicle/vehicle.js');
const { Input } = await import('../src/input.js');
const fire = (t, ty, ev) => (listeners.get(t)?.[ty] ?? []).forEach((fn) => fn(ev));

function newCar() {
  const car = new Vehicle({ RAPIER, world, position: new THREE.Vector3(0, 0.46, 0), quaternion: new THREE.Quaternion() });
  world.step();
  return car;
}
function step(car, input, secs) {
  const steps = Math.round(secs / DT);
  for (let k = 0; k < steps; k++) { car.update(DT, input.state); world.step(); input.update(DT); }
}
function headingY(q) {
  const v = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
  return Math.atan2(v.x, v.z); // yaw; +X = right of forward
}

async function trial(label, applyInput, input) {
  const car = newCar();
  // accelerate straight
  step(car, input, 0.0001); // baseline
  let b = { throttle: 1, brake: 0, steer: 0, handbrake: false };
  for (let k = 0; k < Math.round(3 / DT); k++) { car.update(DT, b); world.step(); }
  const y0 = headingY(car.body.rotation());
  applyInput();
  for (let k = 0; k < Math.round(1.2 / DT); k++) { car.update(DT, input.state); world.step(); input.update(DT); }
  const y1 = headingY(car.body.rotation());
  const dYaw = ((y1 - y0 + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
  // release
  fire(globalThis, 'keyup', { code: 'KeyA' }); fire(globalThis, 'keyup', { code: 'KeyD' });
  fire(els.touchSteer, 'pointerup', { pointerId: 7, clientX: 100 });
  return dYaw;
}

const input = new Input();
// slider to far LEFT
fire(els.touchSteer, 'pointerdown', { pointerId: 7, clientX: 0, preventDefault() {} });
fire(els.touchSteer, 'pointermove', { pointerId: 7, clientX: 0 });
const yawL = await trial('slider LEFT ', () => {}, input);
// slider to far RIGHT
fire(els.touchSteer, 'pointerdown', { pointerId: 8, clientX: 200, preventDefault() {} });
fire(els.touchSteer, 'pointermove', { pointerId: 8, clientX: 200 });
const yawR = await trial('slider RIGHT', () => {}, input);
fire(els.touchSteer, 'pointerup', { pointerId: 8, clientX: 100 });
// keyboard A
fire(globalThis, 'keydown', { code: 'KeyA', preventDefault() {} });
const yawA = await trial('keyboard A  ', () => {}, input);
fire(globalThis, 'keyup', { code: 'KeyA' });
// keyboard D
fire(globalThis, 'keydown', { code: 'KeyD', preventDefault() {} });
const yawD = await trial('keyboard D  ', () => {}, input);
fire(globalThis, 'keyup', { code: 'KeyD' });

const deg = (r) => (r * 180) / Math.PI;
console.log('heading yaw after input (+ = car turns toward world +X = RIGHT of its forward):');
console.log(`  slider LEFT : ${deg(yawL).toFixed(1)} deg  -> ${yawL < 0 ? 'car turned LEFT  (correct)' : 'car turned RIGHT (REVERSED)'}`);
console.log(`  slider RIGHT: ${deg(yawR).toFixed(1)} deg  -> ${yawR > 0 ? 'car turned RIGHT (correct)' : 'car turned LEFT  (REVERSED)'}`);
console.log(`  keyboard A  : ${deg(yawA).toFixed(1)} deg  -> ${yawA < 0 ? 'car turned LEFT  (correct)' : 'car turned RIGHT (REVERSED)'}`);
console.log(`  keyboard D  : ${deg(yawD).toFixed(1)} deg  -> ${yawD > 0 ? 'car turned RIGHT (correct)' : 'car turned LEFT  (REVERSED)'}`);
