import { CAR, clamp } from './config.js';

const DEG = Math.PI / 180;

/**
 * Combined-slip tyre model.
 *
 * 1. Slip ratio (kappa) and slip angle (alpha) are each normalised by their
 *    peak value, giving sx and sy.
 * 2. Both are combined into a single slip magnitude s = hypot(sx, sy).
 * 3. One Magic-Formula curve maps s -> total force fraction. It rises to 1.0
 *    at s = 1 (the friction ellipse edge) and then falls to ~0.72 as slip
 *    becomes large, which is what makes a car slide progressively and lets go.
 * 4. The force direction is the normalised slip vector, so the car can trail
 *    brake / power oversteer naturally.
 *
 * Load sensitivity makes mu drop as vertical load rises, so the outside tyre
 * in a corner has slightly less grip than the inside one.
 */
export class TireModel {
  constructor(cfg = CAR.tyre) {
    this.cfg = cfg;
    this.peakSlipAngle = cfg.peakSlipAngle * DEG;
    this.normaliser = 1 / this._peakShape();
  }

  _shape(s) {
    const bs = this.cfg.shapeB * s;
    return Math.sin(
      this.cfg.shapeC * Math.atan(bs - this.cfg.shapeE * (bs - Math.atan(bs))),
    );
  }

  _peakShape() {
    let peak = 0;
    for (let s = 0.005; s <= 6; s += 0.005) peak = Math.max(peak, this._shape(s));
    return peak;
  }

  /** Normalised force coefficient for a given combined slip magnitude. */
  forceFraction(s) {
    return this._shape(s) * this.normaliser;
  }

  /**
   * @param {number} load      vertical load on the contact patch (N)
   * @param {number} slipRatio kappa, (wheel speed - ground speed) / ground speed
   * @param {number} slipAngle alpha in radians
   * @returns {{fx:number, fy:number, usage:number, mu:number}}
   *          fx = force along the wheel's forward direction (N)
   *          fy = force along the wheel's lateral direction (N)
   */
  evaluate(load, slipRatio, slipAngle) {
    const { mu0, loadRef, loadSensitivity, peakSlipRatio } = this.cfg;

    if (load <= 1) return { fx: 0, fy: 0, usage: 0, mu: 0 };

    // load sensitivity (exponent is negative -> more load, less grip)
    const mu = mu0 * Math.pow(load / loadRef, -loadSensitivity);

    const sx = slipRatio / peakSlipRatio;
    const sy = slipAngle / this.peakSlipAngle;
    const s = Math.hypot(sx, sy);

    if (s < 1e-5) return { fx: 0, fy: 0, usage: 0, mu };

    const maxF = mu * load;
    const strength = maxF * this.forceFraction(s);

    // longitudinal force follows the slip ratio, lateral fights the slide
    return {
      fx: (strength * sx) / s,
      fy: (-strength * sy) / s,
      usage: clamp(strength / maxF, 0, 1.5),
      mu,
    };
  }
}
