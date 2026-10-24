/**
 * Central car setup. Every number here is a physical value in SI units
 * (metres, kilograms, newtons, radians) so the same file drives both the
 * physics and the visual model.
 *
 * Local car frame: +X = right, +Y = up, +Z = forward.
 * The rigid body origin sits at the centre of gravity (CoG).
 */

export const CAR = {
  name: 'R3 Spec',

  // ---------------------------------------------------------------- chassis
  mass: 1280,                       // kg (with driver + fuel)
  // collision box half extents, measured from the CoG
  halfExtents: { x: 0.86, y: 0.30, z: 2.02 },
  colliderOffset: { x: 0, y: -0.02, z: 0 },

  // ---------------------------------------------------------------- wheels
  wheel: {
    radius: 0.34,                   // m
    width: 0.245,                   // m
    mass: 18,                       // kg (unsprung, used for wheel inertia)
    // wheel centres in body space (static ride height)
    trackFront: 1.62,               // m
    trackRear: 1.62,                // m
    wheelbase: 2.60,                // m
  },

  // ----------------------------------------------------------- suspension
  // Raycast suspension: hard point -> spring -> damper -> bump stop.
  suspension: {
    hardpointY: 0.10,               // above CoG
    restLength: 0.26,               // m, hard point to wheel centre
    maxDroop: 0.10,                 // m, extension past rest
    bumpStopAt: 0.14,               // m, compression where the bump stop bites
    stiffnessFront: 42000,          // N/m per wheel
    stiffnessRear: 40000,
    bumpFront: 3600,                // Ns/m
    bumpRear: 3800,
    reboundFront: 5200,
    reboundRear: 5000,
    bumpStopFront: 220000,          // N/m (progressive end of travel)
    bumpStopRear: 200000,
    antiRollFront: 14000,           // N/m (roll stiffness added by ARB)
    antiRollRear: 9000,
  },

  // ------------------------------------------------------------------ tyres
  // Peak grip at ~1.45 mu is a semi-slick. Road tyres are ~1.0-1.15.
  tyre: {
    mu0: 1.45,
    loadRef: 4000,                  // N, load at which mu0 is quoted
    loadSensitivity: 0.10,          // mu falls off as load rises
    peakSlipRatio: 0.10,            // ~10% longitudinal slip at peak
    peakSlipAngle: 6.5,             // degrees
    // Magic Formula shape for the combined (normalised) slip magnitude
    shapeB: 9.0,
    shapeC: 1.5,
    shapeE: 0.92,
    rollingResistance: 0.014,
  },

  // ------------------------------------------------------------- drivetrain
  engine: {
    idleRpm: 950,
    redline: 7600,
    limiter: 7850,
    downshiftRpm: 2700,
    efficiency: 0.92,
    engineBrakeFactor: 0.13,
    // [rpm, Nm]
    torqueCurve: [
      [900, 170],
      [1500, 235],
      [2500, 300],
      [3500, 345],
      [4500, 372],
      [5500, 378],
      [6500, 352],
      [7300, 315],
      [7850, 260],
    ],
  },

  gearbox: {
    // 6-speed + reverse, final drive. RWD.
    ratios: [3.36, 2.19, 1.61, 1.28, 1.06, 0.87],
    reverse: 3.15,
    finalDrive: 3.55,
    shiftTime: 0.16,                // s of torque cut per shift
  },

  brakes: {
    maxTorque: 5200,                // Nm total, split by bias
    biasFront: 0.62,
    handbrakeTorque: 2600,          // Nm at the rear axle
  },

  // --------------------------------------------------------------- steering
  steering: {
    maxAngle: 0.55,                 // rad, low speed lock
    maxAngleHighSpeed: 0.115,       // rad, at speedFullLockKmh+
    speedFullLockKmh: 8,
    speedNoLockKmh: 190,
    rate: 3.2,                      // rad/s, steering wheel rate
    returnRate: 5.0,
    ackermann: 0.75,                // 0 = parallel, 1 = full Ackermann
  },

  // ------------------------------------------------------------------- aero
  aero: {
    airDensity: 1.225,
    dragCdA: 0.72,                  // Cd * A, m^2
    frontLiftClA: -0.95,            // negative = downforce
    rearLiftClA: -1.45,
    // application points (body space)
    frontAxleZ: 1.30,
    rearAxleZ: -1.30,
  },
};

/** Sample a [rpm, torque] curve with linear interpolation. */
export function sampleCurve(curve, x) {
  if (x <= curve[0][0]) return curve[0][1];
  const last = curve[curve.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i - 1];
    const [x2, y2] = curve[i];
    if (x <= x2) {
      const t = (x - x1) / (x2 - x1);
      return y1 + (y2 - y1) * t;
    }
  }
  return last[1];
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
