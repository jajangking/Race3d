/**
 * Unified input. Keyboard, on-screen touch buttons and gamepad all end up in
 * the same four analogue channels, so the vehicle never knows the difference.
 */

const KEY_MAP = {
  KeyW: 'throttle',
  ArrowUp: 'throttle',
  KeyS: 'brake',
  ArrowDown: 'brake',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'handbrake',
};

export class Input {
  constructor() {
    this.state = { throttle: 0, brake: 0, steer: 0, handbrake: false, reverse: false };
    this.keys = new Set();
    this.touch = { throttle: 0, brake: 0, left: 0, right: 0, handbrake: 0 };
    this.touchRamp = { throttle: 0, brake: 0 };
    this.touchRampTime = { throttle: 0, brake: 0 };
    this.reverseToggle = false;
    this.listeners = new Map();
    this.gamepad = null;
    this.hasTouch = false;

    this._bindKeyboard();
    this._bindTouch();
    this._bindGamepad();
  }

  on(action, fn) {
    this.listeners.set(action, fn);
  }

  _emit(action) {
    this.listeners.get(action)?.();
  }

  _bindKeyboard() {
    addEventListener('keydown', (e) => {
      if (e.repeat) {
        if (KEY_MAP[e.code]) e.preventDefault();
        return;
      }
      if (KEY_MAP[e.code]) {
        this.keys.add(e.code);
        e.preventDefault();
      }
      switch (e.code) {
        case 'KeyR':
          this._emit('respawn');
          break;
        case 'KeyC':
          this._emit('camera');
          break;
        case 'KeyT':
          this._emit('tc');
          break;
        case 'KeyY':
          this._emit('esc');
          break;
        case 'KeyH':
          this._emit('help');
          break;
        case 'KeyX':
        case 'KeyO':
          this._emit('focus');
          break;
        case 'Enter':
          this._emit('start');
          break;
      }
    });

    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
    });

    addEventListener('blur', () => this.keys.clear());
  }

  _bindTouch() {
    const buttons = document.querySelectorAll('[data-action]');
    const steer = document.getElementById('touchSteer');
    const gas = document.getElementById('touchGas');
    const brake = document.getElementById('touchBrake');
    const reverseBtn = document.getElementById('touchReverse');

    this.hasTouch =
      matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (this.hasTouch || steer) document.body.classList.add('is-touch');

    const active = new Map(); // pointerId -> action

    const press = (action) => {
      this.touch[action] = 1;
      if (action === 'throttle') this.touchRampTime.throttle = performance.now();
      if (action === 'brake') this.touchRampTime.brake = performance.now();
      document
        .querySelectorAll(`[data-action="${action}"]`)
        .forEach((el) => el.classList.add('is-pressed'));
    };
    const release = (action) => {
      this.touch[action] = 0;
      if (action === 'throttle') this.touchRampTime.throttle = 0;
      if (action === 'brake') this.touchRampTime.brake = 0;
      document
        .querySelectorAll(`[data-action="${action}"]`)
        .forEach((el) => el.classList.remove('is-pressed'));
    };

    for (const el of buttons) {
      const action = el.dataset.action;
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture?.(e.pointerId);
        active.set(e.pointerId, action);
        press(action);
      });
      const up = (e) => {
        const a = active.get(e.pointerId);
        if (!a) return;
        active.delete(e.pointerId);
        // another finger may still be holding the same action
        if (![...active.values()].includes(a)) release(a);
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    }

    const bindVert = (el, key) => {
      if (!el) return;
      const knob = el.querySelector('.touch__slider-vert-knob');
      let activeId = null;
      const set = (v) => {
        v = Math.max(0, Math.min(1, v));
        if (key === 'brake') v = Math.pow(v, 1.6);
        if (knob) knob.style.bottom = v * 100 + '%';
        el.setAttribute('aria-valuenow', v.toFixed(2));
        this.touch[key] = v;
      };
      const update = (e) => {
        if (activeId !== e.pointerId) return;
        const rect = el.getBoundingClientRect();
        const y = rect.bottom - e.clientY;
        const t = y / rect.height;
        set(t);
      };
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        activeId = e.pointerId;
        el.setPointerCapture?.(e.pointerId);
        update(e);
      });
      el.addEventListener('pointermove', update);
      const end = (e) => {
        if (activeId !== e.pointerId) return;
        activeId = null;
        set(0);
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('lostpointercapture', end);
      set(0);
    };

    bindVert(gas, 'throttle');
    bindVert(brake, 'brake');

    if (reverseBtn) {
      reverseBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.reverseToggle = !this.reverseToggle;
        reverseBtn.classList.toggle('is-pressed', this.reverseToggle);
      });
    }

    if (steer) {
      const knob = steer.querySelector('.touch__slider-knob');
      let activeId = null;

      const setValue = (val) => {
        const v = Math.max(-1, Math.min(1, val));
        const pct = (v + 1) / 2 * 100;
        if (knob) knob.style.left = pct + '%';
        steer.setAttribute('aria-valuenow', v.toFixed(2));
        this.touch.left = v < -0.01 ? -v : 0;
        this.touch.right = v > 0.01 ? v : 0;
      };

      const update = (e) => {
        if (activeId !== e.pointerId) return;
        const rect = steer.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const t = Math.max(0, Math.min(1, x / rect.width));
        setValue(t * 2 - 1);
      };

      steer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        activeId = e.pointerId;
        steer.setPointerCapture?.(e.pointerId);
        update(e);
      });
      steer.addEventListener('pointermove', update);
      const end = (e) => {
        if (activeId !== e.pointerId) return;
        activeId = null;
        setValue(0);
      };
      steer.addEventListener('pointerup', end);
      steer.addEventListener('pointercancel', end);
      steer.addEventListener('lostpointercapture', end);
      setValue(0);
    }

    // treat an actual touch as a reason to show the buttons even on hybrids
    addEventListener(
      'touchstart',
      () => {
        if (!document.body.classList.contains('is-touch')) {
          document.body.classList.add('is-touch');
        }
      },
      { passive: true },
    );
  }

  _bindGamepad() {
    addEventListener('gamepadconnected', (e) => {
      this.gamepad = e.gamepad.index;
    });
    addEventListener('gamepaddisconnected', () => {
      this.gamepad = null;
    });
  }

  _readGamepad() {
    if (this.gamepad === null || !navigator.getGamepads) return null;
    const gp = navigator.getGamepads()[this.gamepad];
    if (!gp) return null;

    const dead = (v) => (Math.abs(v) < 0.12 ? 0 : v);
    const throttle = Math.max(dead(gp.buttons[7]?.value ?? 0), gp.buttons[0]?.pressed ? 1 : 0);
    const brake = Math.max(dead(gp.buttons[6]?.value ?? 0), gp.buttons[2]?.pressed ? 1 : 0);
    return {
      steer: dead(gp.axes[0] ?? 0),
      throttle,
      brake,
      handbrake: !!gp.buttons[1]?.pressed || !!gp.buttons[3]?.pressed,
    };
  }

  /** Call once per render frame. */
  update(dt = 1 / 60) {
    const s = this.state;
    let steer = 0;
    let throttle = 0;
    let brake = 0;
    let handbrake = false;

    // Steering sign convention: POSITIVE steer input turns the car RIGHT
    // (vehicle.js applies wheel.steer as _fwd = (sin, 0, cos) in body space,
    // +X = right). The AI and the gamepad already follow this; the keyboard
    // and touch slider used to be inverted (A turned the car right).
    const tLeft = this.touch.left || 0;
    const tRight = this.touch.right || 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft') || tLeft > 0) steer -= tLeft || 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight') || tRight > 0) steer += tRight || 1;

    const now = performance.now();
    if (this.touch.throttle) {
      const hold = this.touchRampTime.throttle ? (now - this.touchRampTime.throttle) / 1000 : 0;
      this.touchRamp.throttle = Math.min(1, Math.max(this.touchRamp.throttle, 0.25 + Math.min(0.75, hold / 0.45)));
    } else {
      this.touchRamp.throttle = Math.max(0, this.touchRamp.throttle - dt * 4);
    }
    if (this.touch.brake) {
      const hold = this.touchRampTime.brake ? (now - this.touchRampTime.brake) / 1000 : 0;
      this.touchRamp.brake = Math.min(1, Math.max(this.touchRamp.brake, 0.2 + Math.min(0.8, hold / 0.4)));
    } else {
      this.touchRamp.brake = Math.max(0, this.touchRamp.brake - dt * 5);
    }

    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) {
      throttle = 1;
    } else if (this.touch.throttle > 0 || this.touch.brake > 0) {
      throttle = this.touch.throttle || 0;
      brake = this.touch.brake || 0;
    } else {
      if (this.hasTouch) {
        const now = performance.now();
        if (this.touch.throttle) {
          const hold = this.touchRampTime.throttle ? (now - this.touchRampTime.throttle) / 1000 : 0;
          this.touchRamp.throttle = Math.min(1, Math.max(this.touchRamp.throttle, 0.25 + Math.min(0.75, hold / 0.45)));
        } else {
          this.touchRamp.throttle = Math.max(0, this.touchRamp.throttle - dt * 4);
        }
        throttle = this.touchRamp.throttle;
      } else {
        throttle = this.touch.throttle ? 1 : 0;
      }
    }

    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) {
      brake = Math.max(brake, 1);
    } else if (!(this.touch.throttle > 0 || this.touch.brake > 0)) {
      if (this.hasTouch) {
        const now = performance.now();
        if (this.touch.brake) {
          const hold = this.touchRampTime.brake ? (now - this.touchRampTime.brake) / 1000 : 0;
          this.touchRamp.brake = Math.min(1, Math.max(this.touchRamp.brake, 0.2 + Math.min(0.8, hold / 0.4)));
        } else {
          this.touchRamp.brake = Math.max(0, this.touchRamp.brake - dt * 5);
        }
        brake = this.touchRamp.brake;
      } else {
        brake = Math.max(brake, this.touch.brake ? 1 : 0);
      }
    }

    if (this.keys.has('Space') || this.touch.handbrake) handbrake = true;

    const gp = this._readGamepad();
    if (gp) {
      if (Math.abs(gp.steer) > Math.abs(steer)) steer = gp.steer;
      throttle = Math.max(throttle, gp.throttle);
      brake = Math.max(brake, gp.brake);
      handbrake = handbrake || gp.handbrake;
    }

    // PLAYER steering is flipped at the very end. In actual play (reported by
    // the player, tested in the real game) the slider/keys felt left-right
    // inverted, so the final player steer is negated. The AI does not use this
    // class, so the field is unaffected.
    s.steer = -Math.max(-1, Math.min(1, steer));
    s.throttle = throttle;
    s.brake = brake;
    s.handbrake = handbrake;
    s.reverse = this.reverseToggle;
    return s;
  }
}
