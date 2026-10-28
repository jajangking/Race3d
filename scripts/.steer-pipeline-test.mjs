/**
 * Headless steering pipeline test: simulates touch-slider drags and
 * keyboard presses against the real Input class and prints the resulting
 * steer value (vehicle convention: positive = RIGHT).
 */
const listeners = new Map(); // target -> {type: [fn]}
function makeEl(id) {
  const el = {
    id,
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    _attrs: {},
    addEventListener(type, fn) {
      if (!listeners.has(el)) listeners.set(el, {});
      (listeners.get(el)[type] ??= []).push(fn);
    },
    removeEventListener() {},
    setPointerCapture() {},
    setAttribute(k, v) { this._attrs[k] = v; },
    getAttribute(k) { return this._attrs[k]; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 200, height: 48 }; },
    querySelector() { return makeEl(id + '-knob'); },
    querySelectorAll() { return []; },
    textContent: '',
  };
  return el;
}
const els = {};
for (const id of ['touchSteer', 'touchGas', 'touchBrake']) els[id] = makeEl(id);
const byAction = [];
globalThis.document = {
  getElementById: (id) => els[id] ?? null,
  querySelector: (sel) => (sel.includes('data-action') ? byAction : null),
  querySelectorAll: (sel) => (sel === '[data-action]' ? byAction : []),
  body: { classList: { add() {}, remove() {} } },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.addEventListener = (type, fn) => {
  if (!listeners.has(globalThis)) listeners.set(globalThis, {});
  (listeners.get(globalThis)[type] ??= []).push(fn);
};
globalThis.removeEventListener = () => {};
globalThis.performance ??= { now: () => Date.now() };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { Input } = await import('../src/input.js');
const input = new Input();

const fire = (target, type, ev) => (listeners.get(target)?.[type] ?? []).forEach((fn) => fn(ev));

let pid = 0;
async function tryCase(label, expected) {
  input.update(1 / 60);
  const steer = input.state.steer;
  const ok = Math.sign(steer) === expected ? 'OK ' : 'FLIPPED';
  console.log(`${ok} ${label}: steer=${steer.toFixed(2)} (expect ${expected > 0 ? '+' : '-'}=right/left)`);
  // release everything
  fire(globalThis, 'keyup', { code: 'KeyA' });
  fire(globalThis, 'keyup', { code: 'KeyD' });
  const id = pid;
  fire(els.touchSteer, 'pointerup', { pointerId: id, clientX: 100 });
  input.update(1 / 60);
}

// slider: drag to far left (x=0)
pid = 1;
fire(els.touchSteer, 'pointerdown', { pointerId: pid, clientX: 0, preventDefault() {} });
fire(els.touchSteer, 'pointermove', { pointerId: pid, clientX: 0 });
await tryCase('slider far LEFT ', -1);

// slider: drag to far right (x=200)
pid = 2;
fire(els.touchSteer, 'pointerdown', { pointerId: pid, clientX: 200, preventDefault() {} });
fire(els.touchSteer, 'pointermove', { pointerId: pid, clientX: 200 });
await tryCase('slider far RIGHT', 1);

// keyboard A / D
pid = 3;
fire(els.touchSteer, 'pointerup', { pointerId: pid, clientX: 100 });
fire(globalThis, 'keydown', { code: 'KeyA', preventDefault() {} });
await tryCase('keyboard A (left) ', -1);
fire(globalThis, 'keyup', { code: 'KeyA' });
fire(globalThis, 'keydown', { code: 'KeyD', preventDefault() {} });
await tryCase('keyboard D (right)', 1);
fire(globalThis, 'keyup', { code: 'KeyD' });
console.log('done');
