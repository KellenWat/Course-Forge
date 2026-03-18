// ---------------------------------------------------------------------------
// ballPhysics.js — shared golf ball physics constants and helpers
// Used by GameView.jsx and DrivingRange.jsx
// ---------------------------------------------------------------------------

// --- Physical constants -----------------------------------------------------
export const GRAVITY          = -9.81;
export const BALL_RADIUS_VIS  = 0.3;      // visual sphere radius (m) — large for visibility
export const BALL_RADIUS_PHYS = 0.02135;  // regulation golf ball radius (m) — 1.68" diameter
export const BALL_MASS        = 0.0459;   // kg — regulation golf ball
export const FIXED_DT         = 1 / 120; // physics substep (s)

// --- Aerodynamic constants --------------------------------------------------
// Drag: F = -K_DRAG * |v| * v  (velocity-squared, opposing motion)
// K_DRAG = 0.5 * CD * rho * A, CD=0.24 (dimpled golf ball), rho=1.225 kg/m³,
// A = π * r²  r=0.02135 m (regulation radius)
export const K_DRAG       = 2.1e-4;  // N·s/m — ~16 m/s² decel at 60 m/s launch

// Magnus lift: F = K_MAGNUS * (ω × v)
// Calibrated: ~2 m/s² lift at 3000 rpm, 60 m/s
export const K_MAGNUS     = 4.2e-6;

// Spin decays due to aerodynamic torque while airborne
export const SPIN_DECAY   = 0.28;    // fraction lost per second in flight

// Rapier damping coefficients
export const AIR_LIN_DAMP = 0.0;    // explicit drag force handles deceleration
export const AIR_ANG_DAMP = 0.06;

// Height of ball centre above terrain (m) required to be considered "in flight"
// Small value so flight mode activates immediately after launch
export const FLIGHT_THRESH = 0.05;

// --- Utilities --------------------------------------------------------------
export const deg2rad = d => d * Math.PI / 180;
export const mphToMs = mph => mph * 0.44704;

// ---------------------------------------------------------------------------
// computeAeroForces
// Call once per animation frame while ball is tracked.
//
// Parameters:
//   vel      — { x, y, z }  current linear velocity (m/s)
//   vLen     — |vel| (pre-computed)
//   inFlight — boolean: true when ball is above FLIGHT_THRESH
//   spin     — { backspin, sidespin } in rpm, mutated in place (decay applied)
//   dt       — frame delta time (s)
//
// Returns { Fx, Fy, Fz } net aerodynamic force in Newtons.
// Returns zero vector when not in flight or moving too slowly.
// ---------------------------------------------------------------------------
export function computeAeroForces(vel, vLen, inFlight, spin, dt) {
  let Fx = 0, Fy = 0, Fz = 0;

  if (!inFlight || vLen <= 0.5) return { Fx, Fy, Fz };

  // Velocity-squared drag (always opposes motion)
  Fx -= K_DRAG * vLen * vel.x;
  Fy -= K_DRAG * vLen * vel.y;
  Fz -= K_DRAG * vLen * vel.z;

  // Magnus spin effects
  if (spin) {
    const hLen = Math.sqrt(vel.x ** 2 + vel.z ** 2);
    if (hLen > 0.1) {
      const vxn = vel.x / hLen, vzn = vel.z / hLen;
      const ω_back = spin.backspin * (2 * Math.PI / 60);
      const ω_side = spin.sidespin * (2 * Math.PI / 60);

      // Backspin → pure vertical lift (proportional to horizontal speed only).
      // Using the full ω×v cross product introduces a backward Fz during ascent
      // that causes loop-de-loops at high spin; this decoupled model is stable.
      Fy += K_MAGNUS * ω_back * hLen;

      // Sidespin → lateral curve perpendicular to horizontal velocity direction
      // Must multiply by hLen so force scales with speed, symmetric with backspin lift
      Fx += K_MAGNUS * ω_side * vzn * hLen;
      Fz -= K_MAGNUS * ω_side * vxn * hLen;
    }

    // Spin decays due to aerodynamic torque
    spin.backspin *= (1 - SPIN_DECAY * dt);
    spin.sidespin *= (1 - SPIN_DECAY * dt);
  }

  return { Fx, Fy, Fz };
}

// ---------------------------------------------------------------------------
// stepPhysics
// Apply aero forces and advance the Rapier world by the correct number of
// fixed substeps for the current frame delta.
//
// Parameters:
//   ballBody    — Rapier RigidBody
//   rapierWorld — Rapier World
//   Fx, Fy, Fz — net force (N) from computeAeroForces
//   dt          — frame delta time (s)
// ---------------------------------------------------------------------------
export function stepPhysics(ballBody, rapierWorld, Fx, Fy, Fz, dt) {
  const steps = Math.max(1, Math.round(dt / FIXED_DT));
  const hasForce = Fx !== 0 || Fy !== 0 || Fz !== 0;
  for (let i = 0; i < steps; i++) {
    if (hasForce) ballBody.addForce({ x: Fx, y: Fy, z: Fz }, true);
    rapierWorld.step();
  }
}

// ---------------------------------------------------------------------------
// computeLaunchVelocity
// Convert simulator inputs into an initial velocity vector.
//
// Parameters:
//   ballSpeedMph  — ball speed in mph
//   launchAngle   — vertical launch angle in degrees
//   azimuthDeg    — horizontal direction in degrees (0 = straight, + = right)
//   flipX         — set true for GameView (X axis pre-negated in OBJ mesh)
//
// Returns { vx, vy, vz } in m/s.
// ---------------------------------------------------------------------------
export function computeLaunchVelocity(ballSpeedMph, launchAngle, azimuthDeg, flipX = false) {
  const speedMs  = mphToMs(ballSpeedMph);
  const loftRad  = deg2rad(launchAngle);
  const azRad    = deg2rad(azimuthDeg);
  const hSpeed   = Math.cos(loftRad) * speedMs;
  return {
    vx: (flipX ? -1 : 1) * Math.sin(azRad) * hSpeed,
    vy: Math.sin(loftRad) * speedMs,
    vz: Math.cos(azRad)   * hSpeed,
  };
}

// ---------------------------------------------------------------------------
// SURFACE_ROLL — per-surface rolling physics
//
// ballFriction:    coefficient on the ball collider (floor is 0.8; Rapier
//                  averages the two, so combined ≈ (ballFriction + 0.8) / 2)
// restitution:     bounce coefficient on landing
// linearDamping:   velocity loss rate while rolling (higher = stops sooner)
// angularDamping:  spin decay rate while rolling (higher = spin dies faster)
//
// Key design intent:
//   Green   — low damping so backspin persists long enough to reverse the ball
//   Fairway — medium; ball checks up but rarely spins back
//   Rough   — high; ball dies in the grass, spin irrelevant
//   Sand    — maximum; ball plugs
// ---------------------------------------------------------------------------
export const SURFACE_ROLL = {
  green:   { ballFriction: 0.35, restitution: 0.08, linearDamping: 0.4,  angularDamping: 0.6  },
  fairway: { ballFriction: 0.50, restitution: 0.10, linearDamping: 1.8,  angularDamping: 3.0  },
  rough:   { ballFriction: 0.80, restitution: 0.05, linearDamping: 5.5,  angularDamping: 7.0  },
  sand:    { ballFriction: 0.90, restitution: 0.02, linearDamping: 12.0, angularDamping: 10.0 },
};

// ---------------------------------------------------------------------------
// createBallBody
// Create and return a Rapier dynamic rigid body + collider for the golf ball.
// Used for in-flight Rapier bodies (GameView) where surface type is unknown.
//
// Parameters:
//   rapierWorld — Rapier World instance
//   RAPIER      — the Rapier module (passed in to avoid import duplication)
//   x, y, z     — start position
// ---------------------------------------------------------------------------
export function createBallBody(rapierWorld, RAPIER, x, y, z) {
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinearDamping(AIR_LIN_DAMP)
    .setAngularDamping(AIR_ANG_DAMP)
    .setCcdEnabled(true);
  const body = rapierWorld.createRigidBody(bodyDesc);
  rapierWorld.createCollider(
    RAPIER.ColliderDesc.ball(BALL_RADIUS_PHYS)
      .setRestitution(0.55)
      .setFriction(0.35)
      .setMass(BALL_MASS),
    body
  );
  return body;
}

// ---------------------------------------------------------------------------
// createRollingBody
// Create a Rapier body tuned for ground rolling on a specific surface type.
// Called when the ball transitions from kinematic flight to Rapier rolling.
//
// Parameters:
//   rapierWorld — Rapier World instance
//   RAPIER      — the Rapier module
//   x, y, z     — landing position
//   surfaceKey  — keyof SURFACE_ROLL ('green' | 'fairway' | 'rough' | 'sand')
// ---------------------------------------------------------------------------
export function createRollingBody(rapierWorld, RAPIER, x, y, z, surfaceKey = 'fairway') {
  const surf = SURFACE_ROLL[surfaceKey] ?? SURFACE_ROLL.fairway;
  const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    .setLinearDamping(surf.linearDamping)
    .setAngularDamping(surf.angularDamping)
    .setCcdEnabled(true);
  const body = rapierWorld.createRigidBody(bodyDesc);
  rapierWorld.createCollider(
    RAPIER.ColliderDesc.ball(BALL_RADIUS_PHYS)
      .setRestitution(surf.restitution)
      .setFriction(surf.ballFriction)
      .setMass(BALL_MASS),
    body
  );
  return body;
}

// ---------------------------------------------------------------------------
// applyLandingSpin
// Set the angular velocity of a rolling body to match the ball's spin at
// the moment of ground contact, so Rapier's friction model naturally produces
// check-up and spin-back behaviour.
//
// Physics: backspin makes the contact point slide forward → friction decelerates
// the ball. If backspin is high enough relative to horizontal speed, the ball
// eventually reverses direction (classic wedge check / spin-back on greens).
//
// Parameters:
//   body — Rapier RigidBody (the rolling body just created)
//   vel  — { x, y, z } velocity at landing (m/s)
//   spin — { backspin, sidespin } in rpm (the kinematic spin state at landing)
// ---------------------------------------------------------------------------
export function applyLandingSpin(body, vel, spin) {
  if (!spin) return;
  const hLen = Math.sqrt(vel.x ** 2 + vel.z ** 2);
  // Unit vector in direction of horizontal motion
  const vxn = hLen > 0.01 ? vel.x / hLen : 0;
  const vzn = hLen > 0.01 ? vel.z / hLen : 1;

  const ω_back = spin.backspin * (2 * Math.PI / 60); // rad/s
  const ω_side = spin.sidespin * (2 * Math.PI / 60);

  // Backspin axis is perpendicular to direction of motion in the horizontal
  // plane, pointing left of travel (right-hand rule gives correct contact slip).
  // For ball moving in +z: axis = -x  →  angvel.x = -ω_back
  body.setAngvel({
    x: -vzn * ω_back,
    y:  ω_side,
    z:  vxn  * ω_back,
  }, true);
}
