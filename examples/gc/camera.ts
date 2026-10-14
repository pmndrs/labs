export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

// State updated every frame lives in Float64Array so writing a double never allocates

export interface CameraState {
  position: Float64Array;
  quaternion: Float64Array;
}

export interface Target {
  position: Float64Array;
  yaw: number;
}

export interface SceneObject {
  position: Float64Array;
  rotationY: number;
  quaternion: Float64Array;
  scale: Float64Array;
}

/** Camera pose at the origin facing -z. */
export function createCameraState(): CameraState {
  return { position: new Float64Array(3), quaternion: Float64Array.of(0, 0, 0, 1) };
}

/** Orientation from yaw about y followed by pitch about x, facing -z at rest. */
function yawPitch(out: Float64Array, yaw: number, pitch: number): void {
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  out[0] = cy * sp;
  out[1] = sy * cp;
  out[2] = -sy * sp;
  out[3] = cy * cp;
}

/** Write the yaw and pitch that point the camera from one position toward another. */
function aimAngles(out: Float64Array, from: Float64Array, to: Float64Array): Float64Array {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  out[0] = Math.atan2(-dx, -dz);
  out[1] = Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  return out;
}

/** Frame-rate independent blend factor for exponential smoothing. */
function smoothing(damping: number, dt: number): number {
  return damping > 0 ? 1 - Math.exp(-dt / damping) : 1;
}

/** A target that circles the origin while slowly turning. */
export function createMovingTarget(): { target: Target; step: () => void } {
  const target: Target = { position: Float64Array.of(0, 2, 10), yaw: 0 };
  let time = 0;
  return {
    target,
    step: () => {
      time += 0.016;
      target.position[0] = Math.sin(time) * 10;
      target.position[2] = Math.cos(time) * 10;
      target.yaw = time * 0.3;
    },
  };
}

/** Points the camera directly at the target every update. */
export class LookAtAim {
  private target: Target;
  private aim = new Float64Array(2);

  constructor(target: Target) {
    this.target = target;
  }

  update(out: CameraState): void {
    // Indexed reads avoid array destructuring, which can allocate an iterator
    const aim = aimAngles(this.aim, out.position, this.target.position);
    yawPitch(out.quaternion, aim[0], aim[1]);
  }
}

/** Moves the camera toward an offset behind the target, rotated with the target's yaw. */
export class FollowBody {
  private target: Target;
  private offset: Vec3;
  private damping: number;

  constructor(target: Target, { offset, damping }: { offset: Vec3; damping: number }) {
    this.target = target;
    this.offset = offset;
    this.damping = damping;
  }

  update(out: CameraState, dt: number): void {
    const [ox, oy, oz] = this.offset;
    const cos = Math.cos(this.target.yaw);
    const sin = Math.sin(this.target.yaw);
    const t = smoothing(this.damping, dt);
    const [tx, ty, tz] = this.target.position;
    const position = out.position;
    position[0] += (tx + ox * cos + oz * sin - position[0]) * t;
    position[1] += (ty + oy - position[1]) * t;
    position[2] += (tz - ox * sin + oz * cos - position[2]) * t;
  }
}

export interface FramingOptions {
  screenPosition: Vec2;
  aspect: number;
  fov?: number;
  deadZone: Vec2;
  damping: number;
  hardLimit: Vec2;
}

/**
 * Keeps the target near a screen position. The camera holds still while the target
 * stays inside the dead zone, eases back when it leaves, and never lets it pass the hard limit.
 */
export class FramingAim {
  private target: Target;
  private screenPosition: Vec2;
  private halfExtent: Vec2;
  private deadZone: Vec2;
  private damping: number;
  private hardLimit: Vec2;
  // Current yaw and pitch, and scratch space reused every update
  private angles = new Float64Array(2);
  private desired = new Float64Array(2);
  private errors = new Float64Array(2);

  constructor(
    target: Target,
    { screenPosition, aspect, fov = Math.PI / 3, deadZone, damping, hardLimit }: FramingOptions
  ) {
    this.target = target;
    this.screenPosition = screenPosition;
    this.halfExtent = [Math.tan(fov / 2) * aspect, Math.tan(fov / 2)];
    this.deadZone = deadZone;
    this.damping = damping;
    this.hardLimit = hardLimit;
  }

  update(out: CameraState, dt: number): void {
    const { angles, errors } = this;
    const desired = aimAngles(this.desired, out.position, this.target.position);
    const yawError = desired[0] - angles[0];
    errors[0] = Math.atan2(Math.sin(yawError), Math.cos(yawError));
    errors[1] = desired[1] - angles[1];
    const t = smoothing(this.damping, dt);
    for (let axis = 0; axis < 2; axis++) {
      // Screen offset of the target relative to where it should sit
      const offset = Math.tan(errors[axis]) / this.halfExtent[axis] - this.screenPosition[axis];
      const excess = Math.sign(offset) * Math.max(0, Math.abs(offset) - this.deadZone[axis]);
      const limit = this.hardLimit[axis];
      const next = Math.max(-limit, Math.min(limit, offset - excess * t));
      // Turn so the target lands at the eased screen offset
      angles[axis] +=
        errors[axis] - Math.atan((next + this.screenPosition[axis]) * this.halfExtent[axis]);
    }
    yawPitch(out.quaternion, angles[0], angles[1]);
  }
}

/** A scene object with a transform that can be rotated about y. */
export function createSceneObject(x: number, y: number): SceneObject {
  return {
    position: Float64Array.of(x, y, 0),
    rotationY: 0,
    quaternion: Float64Array.of(0, 0, 0, 1),
    scale: Float64Array.of(1, 1, 1),
  };
}

/** Recompute the object's quaternion from its rotation. */
export function updateTransform(object: SceneObject): void {
  yawPitch(object.quaternion, object.rotationY, 0);
}
