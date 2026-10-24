import { clamp } from '../vehicle/config.js';

/**
 * Simple online learning: Q-like table for (state, action) with epsilon-greedy
 * and reward shaping. Runs in memory, adapts while driving.
 */
export class AILearner {
  constructor() {
    this.q = new Map();
    this.epsilon = 0.12;
    this.alpha = 0.08;
    this.gamma = 0.9;
    this.lastKey = null;
    this.lastAction = null;
    this.prevSpeed = 0;
    this.prevDistFromCenter = 0;
    this.totalReward = 0;
    this.updates = 0;
  }

  _key(s) {
    // discretize state
    const f = Math.floor(s.front / 0.8);
    const l = Math.floor(s.left / 0.6);
    const r = Math.floor(s.right / 0.6);
    const fl = Math.floor(s.frontLeft / 0.6);
    const fr = Math.floor(s.frontRight / 0.6);
    const sp = Math.floor(s.speed / 4);
    const la = Math.floor((s.lateral + 5) / 2); // -5 to 5
    const a = s.align > 0.8 ? 0 : s.align > 0.4 ? 1 : 2;
    return `${f},${l},${r},${fl},${fr},${sp},${la},${a}`;
  }

  _actions() {
    // (steer, throttleMod, brakeMod)
    return [
      [-0.4, 0.7, 0],
      [-0.2, 0.8, 0],
      [0, 0.9, 0],
      [0.2, 0.8, 0],
      [0.4, 0.7, 0],
      [-0.3, 0.4, 0.2],
      [0.3, 0.4, 0.2],
      [0, 0.3, 0.4],
      [-0.6, 0.2, 0.1],
      [0.6, 0.2, 0.1],
    ];
  }

  getAction(state) {
    const key = this._key(state);
    const acts = this._actions();
    // epsilon greedy
    if (Math.random() < this.epsilon) {
      const idx = Math.floor(Math.random() * acts.length);
      this.lastKey = key;
      this.lastAction = idx;
      return acts[idx];
    }
    // find best
    let bestIdx = 2;
    let bestQ = -Infinity;
    for (let i = 0; i < acts.length; i++) {
      const k2 = key + '|' + i;
      const qv = this.q.get(k2) || 0;
      if (qv > bestQ) {
        bestQ = qv;
        bestIdx = i;
      }
    }
    this.lastKey = key;
    this.lastAction = bestIdx;
    return acts[bestIdx];
  }

  learn(state, dt) {
    if (this.lastKey === null || this.lastAction === null) return;
    // reward
    let reward = 0;
    // reward for speed
    reward += (state.speed / 30) * 0.01;
    // penalty for being close
    if (state.front < 3) reward -= (3 - state.front) * 0.02;
    if (state.left < 1.5) reward -= (1.5 - state.left) * 0.01;
    if (state.right < 1.5) reward -= (1.5 - state.right) * 0.01;
    // penalty for off-center
    reward -= Math.abs(state.lateral) * 0.005;
    // penalty for low alignment
    reward -= (1 - Math.max(0, state.align)) * 0.01;
    // reward for progress
    if (state.speed > this.prevSpeed) reward += 0.005;
    // penalty for going backwards
    if (state.align < 0) reward -= 0.02;

    this.prevSpeed = state.speed;
    this.prevDistFromCenter = state.lateral;

    const key = this._key(state);
    const acts = this._actions();
    const kCur = key + '|' + this.lastAction;
    const kNext = key + '|';
    // max next
    let maxNext = -Infinity;
    for (let i = 0; i < acts.length; i++) {
      const v = this.q.get(kNext + i) || 0;
      if (v > maxNext) maxNext = v;
    }
    if (maxNext === -Infinity) maxNext = 0;
    const old = this.q.get(kCur) || 0;
    const val = old + this.alpha * (reward + this.gamma * maxNext - old);
    this.q.set(kCur, val);
    this.updates++;
    this.totalReward += reward;
    // decay epsilon slowly
    if (this.updates % 1000 === 0) {
      this.epsilon = Math.max(0.02, this.epsilon * 0.995);
    }
  }

  getStats() {
    return { epsilon: this.epsilon, updates: this.updates, totalReward: this.totalReward };
  }
}
