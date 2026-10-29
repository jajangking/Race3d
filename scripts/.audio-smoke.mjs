/**
 * Scratch smoke test: drives src/audio/engineAudio.js through a stubbed
 * AudioContext to catch code-path bugs (null refs, bad param writes) since
 * real sound cannot be heard headless.
 */
import { EngineAudio } from '../src/audio/engineAudio.js';

function makeParam(v = 0) {
  return { value: v, setTargetAtTime(x, _t, _tau) { this.value = x; } };
}
function makeNode(extra = {}) {
  return {
    connect(dst) { this._dst = dst; return dst; },
    ...extra,
  };
}
class FakeCtx {
  constructor(legacy = false) {
    this.legacy = legacy;
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = makeNode();
    this.listener = legacy
      ? { setPosition(x, y, z) { this.p = [x, y, z]; }, setForwardVector(x, y, z) { this.f = [x, y, z]; }, setUpVector(x, y, z) { this.u = [x, y, z]; } }
      : { positionX: makeParam(), positionY: makeParam(), positionZ: makeParam(), velocityX: makeParam(), velocityY: makeParam(), velocityZ: makeParam(), forwardX: makeParam(), forwardY: makeParam(), forwardZ: makeParam(), upX: makeParam(), upY: makeParam(), upZ: makeParam() };
  }
  resume() {}
  close() { return Promise.resolve(); }
  createOscillator() { return makeNode({ type: 'sine', detune: makeParam(), frequency: makeParam(), start() {}, stop() {} }); }
  createGain() { return makeNode({ gain: makeParam() }); }
  createBiquadFilter() { return makeNode({ type: 'lowpass', Q: makeParam(), frequency: makeParam() }); }
  createPanner() {
    const p = makeNode({
      panningModel: 'equalpower', distanceModel: 'exponential',
      refDistance: 1, rolloffFactor: 1, dopplerFactor: 1,
    });
    if (!this.legacy) {
      p.positionX = makeParam(); p.positionY = makeParam(); p.positionZ = makeParam();
      p.velocityX = makeParam(); p.velocityY = makeParam(); p.velocityZ = makeParam();
    } else {
      p.setPosition = (x, y, z) => { p.p = [x, y, z]; };
    }
    return p;
  }
  createDynamicsCompressor() { return makeNode({ threshold: makeParam(), knee: makeParam(), ratio: makeParam(), attack: makeParam(), release: makeParam() }); }
  createBuffer(ch, n) { return { getChannelData: () => new Float32Array(n) }; }
  createBufferSource() { return makeNode({ buffer: null, loop: false, start() {}, stop() {} }); }
}

const cars = [];
for (let i = 0; i < 11; i++) {
  cars.push({
    telemetry: { rpm: 950, throttle: 0, brake: 0, speedKmh: 0 },
    body: { translation: () => ({ x: i * 10, y: 0, z: 0 }), linvel: () => ({ x: 0, y: 0, z: 0 }) },
  });
}

// --- modern path
globalThis.window = {};
let failures = 0;
const modern = new FakeCtx(false);
globalThis.window.AudioContext = function () { return modern; };
{
  const ea = new EngineAudio();
  ea.start();
  if (!ea.ready) { console.log('FAIL: modern start() did not become ready'); failures++; }
  // 300 simulated frames: ramp the first car to redline, others idle
  for (let frame = 0; frame < 300; frame++) {
    modern.currentTime = frame / 60;
    const s = frame / 60;
    cars.forEach((c, i) => {
      c.telemetry.rpm = i === 0 ? 950 + 6650 * Math.min(1, s / 5) : 950 + 200 * Math.sin(s + i);
      c.telemetry.throttle = i === 0 ? 1 : 0.3;
      const v = 20 + i;
      c.body.translation = () => ({ x: i * 10 + v * s, y: 0.5, z: Math.sin(s * 0.3 + i) * 4 });
      c.body.linvel = () => ({ x: v, y: 0, z: 0 });
    });
    ea.updateListener(1 / 60, { x: cars[0].body.translation().x - 6, y: 2.2, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    ea.updateCar(cars[0], true, cars[0].body.translation(), cars[0].body.linvel());
    for (let i = 1; i < cars.length; i++) ea.updateCar(cars[i], false, cars[i].body.translation(), cars[i].body.linvel());
  }
  const main = ea.engines.get(cars[0]);
  if (!main) { console.log('FAIL: main engine not registered'); failures++; }
  else {
    // after ramp, rpm ~7600 -> f ~253
    const f = main.o1.frequency.value;
    if (Math.abs(f - 7600 / 30) > 3) { console.log(`FAIL: firing freq ${f.toFixed(1)} != ~253`); failures++; }
    const g = main.gain.gain.value;
    if (!(g > 0.3 && g < 1.2)) { console.log(`FAIL: main gain out of range: ${g}`); failures++; }
    if (!main.noiseGain) { console.log('FAIL: main car missing exhaust noise'); failures++; }
  }
  const other = ea.engines.get(cars[5]);
  if (other && other.noiseGain) { console.log('FAIL: non-main car has noise layer'); failures++; }
  // teleport: jump car 2 by 100 m and check velocity zeroing
  const c2 = cars[2];
  ea.updateCar(c2, false, { x: c2.body.translation().x + 100, y: 0, z: 0 }, { x: 50, y: 0, z: 0 });
  const p2 = ea.engines.get(c2).panner;
  const vx = p2.velocityX ? p2.velocityX.value : null;
  if (vx !== 0) { console.log(`FAIL: teleport not zeroing velocity (got ${vx})`); failures++; }
  console.log(`modern: freq=${main.o1.frequency.value.toFixed(1)} gain=${main.gain.gain.value.toFixed(2)} pannerPos=(${p2.positionX.value.toFixed(1)},${p2.positionY.value.toFixed(1)},${p2.positionZ.value.toFixed(1)})`);
  ea.dispose();
  if (ea.ready) { console.log('FAIL: dispose left ready=true'); failures++; }
}

// --- legacy path (old WebKit: setPosition, no velocityX)
{
  const legacy = new FakeCtx(true);
  globalThis.window.AudioContext = function () { return legacy; };
  const ea = new EngineAudio();
  ea.start();
  legacy.currentTime = 1;
  ea.updateListener(1 / 60, { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
  const car = cars[0];
  car.body.translation = () => ({ x: 5, y: 0, z: 3 });
  car.body.linvel = () => ({ x: 10, y: 0, z: 0 });
  ea.updateCar(car, true, car.body.translation(), car.body.linvel());
  const pan = ea.engines.get(car).panner;
  if (!pan.p || Math.abs(pan.p[0] - 5) > 0.01) { console.log(`FAIL: legacy setPosition not used: ${JSON.stringify(pan.p)}`); failures++; }
  if (!legacy.listener.p) { console.log('FAIL: legacy listener setPosition not used'); failures++; }
  if (!legacy.listener.f || Math.abs(legacy.listener.f[2] - -1) > 0.01) { console.log(`FAIL: legacy forward vector: ${JSON.stringify(legacy.listener.f)}`); failures++; }
  console.log(`legacy: pannerPos=${JSON.stringify(pan.p)} listenerPos=${JSON.stringify(legacy.listener.p)} forward=${JSON.stringify(legacy.listener.f)}`);
  ea.dispose();
}

console.log(failures === 0 ? '\nAUDIO SMOKE: ALL OK' : `\nAUDIO SMOKE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
