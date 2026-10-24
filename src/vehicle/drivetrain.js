import { CAR, sampleCurve, clamp } from './config.js';

const TAU = Math.PI * 2;

/**
 * Engine + 6 speed gearbox + final drive.
 *
 * The engine is "attached" to the driven wheels: rpm is derived from wheel
 * speed and the selected gear, then a torque curve (and engine braking) is
 * turned into axle torque. A short torque cut simulates each gear change,
 * which is what makes the car bob between shifts.
 *
 * No clutch pedal: at low speed the rpm is floored at idle and the torque is
 * allowed through (an auto-clutch that slips). Good enough to launch, and it
 * keeps the sim playable on a touchscreen.
 */
export class Drivetrain {
  constructor(cfg = CAR) {
    this.cfg = cfg;
    this.gear = 1; // -1 = reverse, 0 = neutral, 1..6
    this.auto = true;
    this.rpm = cfg.engine.idleRpm;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.throttle = 0;
    this.shifting = false;
  }

  get maxGear() {
    return this.cfg.gearbox.ratios.length;
  }

  /** Gearbox ratio * final drive. Negative in reverse. */
  get ratio() {
    const gb = this.cfg.gearbox;
    if (this.gear === 0) return 0;
    const base = this.gear > 0 ? gb.ratios[this.gear - 1] : -gb.reverse;
    return base * gb.finalDrive;
  }

  get gearLabel() {
    if (this.gear === -1) return 'R';
    if (this.gear === 0) return 'N';
    return String(this.gear);
  }

  shiftUp() {
    if (this.shiftTimer > 0 || this.shiftCooldown > 0) return;
    if (this.gear < 1 || this.gear >= this.maxGear) return;
    this.gear++;
    this._startShift();
  }

  shiftDown() {
    if (this.shiftTimer > 0 || this.shiftCooldown > 0) return;
    if (this.gear <= 1) return;
    this.gear--;
    this._startShift();
  }

  /** Only allowed at walking pace so we don't explode the gearbox. */
  toggleReverse(speed) {
    if (this.shiftTimer > 0) return;
    // allow switching to reverse even at higher speed
    this.gear = this.gear === -1 ? 1 : -1;
    this._startShift();
  }

  _startShift() {
    this.shiftTimer = this.cfg.gearbox.shiftTime;
    this.shiftCooldown = this.cfg.gearbox.shiftTime + 0.15;
  }

  /**
   * @param {number} dt seconds
   * @param {{throttle:number, brake:number}} input
   * @param {number} drivenWheelOmega average angular velocity of driven wheels (rad/s)
   * @param {number} speed signed forward speed of the car (m/s)
   */
  update(dt, input, drivenWheelOmega, speed) {
    const eng = this.cfg.engine;
    this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);
    this.shifting = this.shiftTimer > 0;

    const ratio = this.ratio;
    if (this.gear === -1) {
      // allow full throttle in reverse
      input = { ...input };
    }

    // rpm from road speed through the current gear (this is what the engine
    // really does while the clutch is locked; wheelspin is handled separately)
    const wheelRpm = Math.abs(drivenWheelOmega) * Math.abs(ratio) * (60 / TAU);
    // Slipping clutch at low speed: the driver holds a few thousand rpm while
    // the car gets moving, instead of the engine sitting at idle and bogging.
    const launchBonus =
      input.throttle * 2400 * (1 - clamp(Math.abs(speed) / 15, 0, 1));
    let rpm = Math.max(eng.idleRpm + launchBonus, wheelRpm);
    rpm = Math.min(rpm, eng.limiter + 200);
    // allow higher road rpm in reverse for maneuvering
    if (this.gear === -1) {
      rpm = Math.min(rpm, eng.limiter + 1000);
    }

    // gearbox output rpm -> what an automatic would shift on. Using road speed
    // instead of wheel speed stops the box from upshifting into 6th while the
    // rear tyres are still spinning at the lights.
    let roadRpm = (Math.abs(speed) / this.cfg.wheel.radius) * Math.abs(ratio) * (60 / TAU);
    if (this.gear === -1) {
      roadRpm = Math.min(roadRpm, eng.limiter * 5);
    }

    // automatic gearbox only drives forwards
    if (this.auto && this.gear > 0 && this.shiftTimer <= 0) {
      if (roadRpm > eng.redline - 100) this.shiftUp();
      else if (roadRpm < eng.downshiftRpm && this.gear > 1) this.shiftDown();
    }
    if (this.gear === -1) {
      this.rpm = rpm;
    }

    // auto-clutch: slip the clutch at very low speed so launches aren't a
    // binary traction-control bang
    let clutch = clamp((Math.abs(speed) + 2.5) / 4.5, 0.55, 1);
    if (this.gear === -1) clutch = Math.max(clutch, 0.8);

    const torqueAtRpm = sampleCurve(eng.torqueCurve, rpm);

    let engineTorque = 0;
    if (this.shiftTimer <= 0 && rpm < eng.limiter * 3) {
      // drive torque, minus engine braking when off the throttle
      const drive = torqueAtRpm * input.throttle;
      const coast =
        rpm > eng.idleRpm * 1.35
          ? torqueAtRpm * eng.engineBrakeFactor * (1 - input.throttle)
          : 0;
      engineTorque = drive - coast;
    }

    this.rpm = this.gear === -1 ? rpm : rpm;
    this.throttle = input.throttle;

    let axleTorque = engineTorque * clutch * ratio * eng.efficiency;
    if (this.gear === -1) {
      axleTorque *= 2.5;
    }

    // prevent creep/rollback when stationary with no throttle/brake
    if (Math.abs(speed) < 1.5 && input.throttle < 0.03 && input.brake < 0.03 && !input.handbrake && this.gear !== -1) {
      axleTorque = 0;
    }

    return {
      axleTorque,
      rpm,
      gear: this.gear,
      ratio,
      clutch,
      shifting: this.shifting,
      throttle: input.throttle,
      /** Highest wheel omega the engine can drag the driven wheels to. */
      maxWheelOmega:
        Math.abs(ratio) > 1e-3 ? (this.gear === -1 ? (eng.limiter * 3 * TAU) / 60 / Math.abs(ratio) : (eng.limiter * TAU) / 60 / Math.abs(ratio)) : 400,
    };
  }
}
