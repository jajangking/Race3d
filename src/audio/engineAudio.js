/**
 * Engine audio for the whole field, synthesised with the Web Audio API (no
 * audio assets to load). Every car gets a small engine model:
 *
 *   osc(f) sawtooth      - the firing frequency (4 cyl 4-stroke: rpm/30)
 *   osc(2f) sawtooth     - second harmonic, detuned + vibrato (organic growl)
 *   osc(f/2) square      - low sub rumble
 *        \
 *         -> lowpass (cutoff opens with throttle + rpm) -> gain -> panner
 *   noise -> bandpass -> gain (player car only: exhaust hiss)
 *
 * The panner is an exponential-distance PannerNode fed with each car's real
 * position AND velocity, so nearby cars duck when you pass them (Doppler)
 * and the field fades with distance. Pitch follows telemetry.rpm directly,
 * so gear shifts produce the real rev-drop, the launch produces a clutch-slip
 * scream, and downshifts blip.
 *
 * Audio can only start after a user gesture (autoplay policy); call start()
 * from the start-button handler. Everything before that is a no-op.
 */

// ---- Web Audio spatial-compat helpers ------------------------------------
// Newer browsers (Chrome 55+/Safari 14.1+) expose position/velocity/forward/
// up as AudioParams (.positionX.value ...). Older WebKit only has the
// setPosition/setForwardVector/setUpVector methods. Write through whichever
// exists so phones on slightly older Safari still get spatialised engines.
function setPos(node, x, y, z) {
  if (node.positionX) {
    node.positionX.value = x;
    node.positionY.value = y;
    node.positionZ.value = z;
  } else if (node.setPosition) {
    node.setPosition(x, y, z);
  }
}
function setVel(node, x, y, z) {
  // velocity only exists on the newer spec; nothing to do on legacy
  if (node.velocityX) {
    node.velocityX.value = x;
    node.velocityY.value = y;
    node.velocityZ.value = z;
  }
}
function setForward(node, x, y, z) {
  if (node.forwardX) {
    node.forwardX.value = x;
    node.forwardY.value = y;
    node.forwardZ.value = z;
  } else if (node.setForwardVector) {
    node.setForwardVector(x, y, z);
  }
}
function setUp(node, x, y, z) {
  if (node.upX) {
    node.upX.value = x;
    node.upY.value = y;
    node.upZ.value = z;
  } else if (node.setUpVector) {
    node.setUpVector(x, y, z);
  }
}

// rotate a local axis (vx,vy,vz) by a three.js quaternion (x,y,z,w)
function rotAxis(qx, qy, qz, qw, vx, vy, vz) {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

const ZERO = { x: 0, y: 0, z: 0 };

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.engines = new Map(); // car -> chain
    this._master = null;
    this._noiseBuffer = null;
    // voice budget (see updateCar): phones choke on 40+ spatial chains
    this.maxVoices = 11; // the player + the 10 nearest AI cars
    this.listenRadius = 45; // metres; beyond this the rolloff is inaudible
    // listener (camera) state
    this._lPos = { x: 0, y: 0, z: 0 };
    this._lVel = { x: 0, y: 0, z: 0 };
    this._hasPos = false;
  }

  /** Create the context inside a user gesture. Safe to call again. */
  start() {
    if (this.ready) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    let ctx;
    try {
      ctx = new AC({ latencyHint: 'interactive' });
    } catch {
      return;
    }
    this.ctx = ctx;
    if (ctx.state === 'suspended') ctx.resume();

    // master bus with a compressor so 11 overlapping engines never clip
    const master = ctx.createGain();
    master.gain.value = 0.8;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    master.connect(comp);
    comp.connect(ctx.destination);
    this._master = master;

    // shared 1.5 s noise buffer (one-time cost)
    const n = Math.floor(ctx.sampleRate * 1.5);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      // pink-ish noise: leak the previous sample through a one-pole lowpass
      const w = Math.random() * 2 - 1;
      last = 0.985 * last + 0.015 * w;
      d[i] = (w * 0.18 + last * 2.2) * 0.5;
    }
    this._noiseBuffer = buf;
    this.ready = true;
  }

  /** Re-engage after a tab switch / browser suspension. */
  resume() {
    if (this.ready && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _makeNoiseBufferSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    src.loop = true;
    src.start();
    return src;
  }

  /**
   * Register a car's engine (no-op if already registered) and push this
   * frame's state into it. Call once per car per frame after the physics
   * step. `main` is the player's car - it gets the extra exhaust-noise layer
   * and a slightly louder gain.
   *
   * VOICE CULLING: a phone's audio thread cannot sustain 45+ spatial synth
   * chains (46 chains = hum + choppiness). Only the nearest `maxVoices`
   * cars keep live engines; beyond `listenRadius` a car is inaudible anyway
   * (exponential rolloff), so its voice is faded out and released.
   */
  updateCar(car, main, pos, vel) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    if (!main) {
      // inaudible? release the voice (or never build it)
      if (this._hasPos) {
        const dx = pos.x - this._lPos.x;
        const dz = pos.z - this._lPos.z;
        if (dx * dx + dz * dz > this.listenRadius * this.listenRadius) {
          this._releaseEngine(car);
          return;
        }
        // at capacity: the farthest voice loses its slot. If that is us
        // (or someone closer is the farthest, i.e. we are), we go quiet.
        if (this.engines.size >= this.maxVoices) {
          const far = this._farthestEngine();
          const ourDistSq = dx * dx + dz * dz;
          if (!far || far.car === car || far.distSq < ourDistSq) {
            this._releaseEngine(car);
            return;
          }
          this._releaseEngine(far.car);
        }
      }
    }

    let e = this.engines.get(car);
    if (!e) e = this._buildEngine(car, main);

    const tm = car.telemetry;
    const rpm = Number.isFinite(tm.rpm) ? tm.rpm : 0;
    const throttle = Number.isFinite(tm.throttle) ? tm.throttle : 0;
    const brake = Number.isFinite(tm.brake) ? tm.brake : 0;

    // firing frequency of a 4-cylinder 4-stroke: rpm/30
    // (idle 950 -> 31.7 Hz, redline 7600 -> 253 Hz)
    const f = Math.max(18, rpm / 30);
    const rpmNorm = Math.min(1, Math.max(0, (rpm - 900) / 6900));

    e.o1.frequency.setTargetAtTime(f, t, 0.028);
    e.o2.frequency.setTargetAtTime(f * 2, t, 0.028);
    e.o3.frequency.setTargetAtTime(f * 0.5, t, 0.028);
    // growl rate follows the engine (pulse gets faster as it revs)
    e.lfo1.frequency.setTargetAtTime(4 + rpm / 150, t, 0.05);
    e.lfo2.frequency.setTargetAtTime(6 + rpm / 100, t, 0.05);

    // filter opens as the throttle opens and revs rise - flat at idle
    const cutoff = 380 + throttle * 2600 + rpmNorm * 2200 + brake * 500;
    e.filter.frequency.setTargetAtTime(cutoff, t, 0.06);

    // engine load: idle tick, full-throttle howl
    const target = (main ? 0.16 : 0.12) + throttle * (main ? 0.55 : 0.4) + rpmNorm * 0.1;
    e.gain.gain.setTargetAtTime(target, t, 0.05);
    if (e.noiseGain) {
      e.noiseGain.gain.setTargetAtTime(0.05 + throttle * 0.22, t, 0.08);
      e.noiseFilter.frequency.setTargetAtTime(700 + rpm * 0.35, t, 0.08);
    }

    // spatial: car centre, half a metre up (exhaust height)
    setPos(e.panner, pos.x, pos.y + 0.6, pos.z);
    // a respawn/teleport would read as infinite velocity -> doppler scream;
    // zero the velocity whenever the car jumped further than 40 m in one frame
    if (e.hasPos) {
      const dx = pos.x - e.lastX;
      const dy = pos.y - e.lastY;
      const dz = pos.z - e.lastZ;
      const jumped = dx * dx + dy * dy + dz * dz > 1600;
      setVel(e.panner, jumped ? 0 : vel.x, jumped ? 0 : vel.y, jumped ? 0 : vel.z);
    } else {
      e.hasPos = true;
      setVel(e.panner, vel.x, vel.y, vel.z);
    }
    e.lastX = pos.x; e.lastY = pos.y; e.lastZ = pos.z;
  }

  /** The active voice farthest from the listener (excludes `car`). */
  _farthestEngine(car) {
    let far = null;
    for (const [c, e] of this.engines) {
      if (c === car || e.isMain) continue;
      const dx = e.lastX - this._lPos.x;
      const dz = e.lastZ - this._lPos.z;
      const d2 = dx * dx + dz * dz;
      if (!far || d2 > far.distSq) far = { car: c, distSq: d2 };
    }
    return far;
  }

  /** Fade a voice out and tear its nodes down (frees the audio thread). */
  _releaseEngine(car) {
    const e = this.engines.get(car);
    if (!e) return;
    this.engines.delete(car);
    const t = this.ctx.currentTime;
    try {
      e.gain.gain.cancelScheduledValues(t);
      e.gain.gain.setTargetAtTime(0, t, 0.03);
      const stopAt = t + 0.12;
      e.o1.stop(stopAt); e.o2.stop(stopAt); e.o3.stop(stopAt);
      e.lfo1.stop(stopAt); e.lfo2.stop(stopAt);
      if (e.noiseSrc) e.noiseSrc.stop(stopAt);
    } catch { /* already stopped */ }
    // let the fade finish, then disconnect so the nodes are GC-able
    setTimeout(() => {
      try {
        e.panner.disconnect(); e.filter.disconnect(); e.gain.disconnect();
        e.o1g.disconnect(); e.o2g.disconnect(); e.o3g.disconnect();
      } catch { /* already disconnected */ }
    }, 200);
  }

  _buildEngine(car, main) {
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.detune.value = 9; // cents - keeps the two harmonics from phasing flat
    const o3 = ctx.createOscillator();
    o3.type = 'square';

    const o1g = ctx.createGain(); o1g.gain.value = 0.5;
    const o2g = ctx.createGain(); o2g.gain.value = 0.34;
    const o3g = ctx.createGain(); o3g.gain.value = 0.3;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.1;
    filter.frequency.value = 400;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const panner = ctx.createPanner();
    panner.panningModel = 'equalpower'; // HRTF is overkill for 11 sources
    panner.distanceModel = 'exponential';
    panner.refDistance = 3.5;
    panner.rolloffFactor = 1.5;
    panner.dopplerFactor = 0.85;
    setPos(panner, 0, 0, 0);

    // vibrato: two incommensurate low-rate LFOs wobble the second harmonic's
    // detune, so the engine growls organically instead of sounding like a
    // flat synth patch. The rate is scaled with rpm in updateCar (a revving
    // engine's pulse genuinely gets faster).
    const lfo1 = ctx.createOscillator();
    lfo1.type = 'sine';
    lfo1.frequency.value = 10;
    const lfo1g = ctx.createGain();
    lfo1g.gain.value = 14; // cents
    const lfo2 = ctx.createOscillator();
    lfo2.type = 'sine';
    lfo2.frequency.value = 15;
    const lfo2g = ctx.createGain();
    lfo2g.gain.value = 8;
    lfo1.connect(lfo1g).connect(o2.detune);
    lfo2.connect(lfo2g).connect(o2.detune);

    o1.connect(o1g).connect(filter);
    o2.connect(o2g).connect(filter);
    o3.connect(o3g).connect(filter);
    filter.connect(gain).connect(panner).connect(this._master);

    // exhaust hiss: player car only (the ears are IN this engine)
    let noiseGain = null;
    let noiseFilter = null;
    let noiseSrc = null;
    if (main) {
      noiseGain = ctx.createGain();
      noiseGain.gain.value = 0;
      noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'bandpass';
      noiseFilter.Q.value = 0.6;
      noiseFilter.frequency.value = 900;
      noiseSrc = this._makeNoiseBufferSource();
      noiseSrc.connect(noiseFilter).connect(noiseGain).connect(panner);
    }

    o1.start(t);
    o2.start(t);
    o3.start(t);
    lfo1.start(t);
    lfo2.start(t);

    const e = {
      o1, o2, o3, lfo1, lfo2, filter, gain, panner,
      o1g, o2g, o3g,
      noiseGain, noiseFilter, noiseSrc,
      isMain: main,
      hasPos: false, lastX: 0, lastY: 0, lastZ: 0,
    };
    this.engines.set(car, e);
    return e;
  }

  /**
   * Move the listener (the camera) - position + smoothed velocity, plus the
   * camera orientation so front/back matters.
   */
  updateListener(dt, pos, quat) {
    if (!this.ready) return;
    const L = this.ctx.listener;
    // camera velocity from the position delta, lowpassed to keep the doppler
    // shift smooth
    if (this._hasPos && dt > 0) {
      const k = Math.min(1, dt * 6);
      const vx = (pos.x - this._lPos.x) / dt;
      const vy = (pos.y - this._lPos.y) / dt;
      const vz = (pos.z - this._lPos.z) / dt;
      this._lVel.x += (vx - this._lVel.x) * k;
      this._lVel.y += (vy - this._lVel.y) * k;
      this._lVel.z += (vz - this._lVel.z) * k;
    } else {
      this._lVel.x = 0; this._lVel.y = 0; this._lVel.z = 0;
    }
    this._lPos.x = pos.x; this._lPos.y = pos.y; this._lPos.z = pos.z;
    this._hasPos = true;

    setPos(L, pos.x, pos.y, pos.z);
    if (L.velocityX) {
      L.velocityX.value = this._lVel.x;
      L.velocityY.value = this._lVel.y;
      L.velocityZ.value = this._lVel.z;
    }
    // camera looks down local -Z, up is +Y
    const f = rotAxis(quat.x, quat.y, quat.z, quat.w, 0, 0, -1);
    const u = rotAxis(quat.x, quat.y, quat.z, quat.w, 0, 1, 0);
    setForward(L, f[0], f[1], f[2]);
    setUp(L, u[0], u[1], u[2]);
  }

  dispose() {
    if (!this.ready) return;
    for (const e of this.engines.values()) {
      try { e.o1.stop(); e.o2.stop(); e.o3.stop(); e.lfo1.stop(); e.lfo2.stop(); if (e.noiseSrc) e.noiseSrc.stop(); } catch { /* already stopped */ }
    }
    this.engines.clear();
    this.ctx.close().catch(() => {});
    this.ready = false;
    this.ctx = null;
  }
}
