import { bench, group } from '../../src/index.ts';
import {
  createCameraState,
  createMovingTarget,
  createSceneObject,
  FollowBody,
  FramingAim,
  LookAtAim,
  type SceneObject,
  updateTransform,
} from './camera.ts';

group('low garbage', () => {
  bench('look at', function* () {
    const { target, step } = createMovingTarget();
    const aim = new LookAtAim(target);
    const out = createCameraState();
    out.position[1] = 2;
    out.position[2] = 15;
    yield () => {
      step();
      aim.update(out);
      return out;
    };
  });

  bench('follow', function* () {
    const { target, step } = createMovingTarget();
    const body = new FollowBody(target, { offset: [0, 3, 8], damping: 0.5 });
    const out = createCameraState();
    yield () => {
      step();
      body.update(out, 0.016);
      return out;
    };
  });

  bench('framing', function* () {
    const { target, step } = createMovingTarget();
    const aim = new FramingAim(target, {
      screenPosition: [0, 0],
      aspect: 16 / 9,
      deadZone: [0.2, 0.2],
      damping: 0.5,
      hardLimit: [0.4, 0.4],
    });
    const out = createCameraState();
    out.position[1] = 2;
    out.position[2] = 15;
    yield () => {
      step();
      aim.update(out, 0.016);
      return out;
    };
  });
});

group('short-lived garbage', () => {
  for (const [name, count] of [
    ['light: 1 pose copy', 1],
    ['heavy: 128 pose copies', 128],
  ] as const) {
    bench(name, function* () {
      const { target, step } = createMovingTarget();
      const body = new FollowBody(target, { offset: [0, 3, 8], damping: 0.5 });
      const out = createCameraState();
      yield () => {
        step();
        body.update(out, 0.016);
        return Array.from({ length: count }, () => ({
          position: out.position.slice(),
          quaternion: out.quaternion.slice(),
        }));
      };
    });
  }
});

group('retained garbage', () => {
  bench('undo: 1,000 transforms', function* () {
    const objects = Array.from({ length: 1000 }, (_, index) =>
      createSceneObject(index % 50, Math.floor(index / 50))
    );
    const history: Array<Array<Pick<SceneObject, 'position' | 'quaternion' | 'scale'>> | null> =
      Array.from({ length: 64 }, () => null);
    let cursor = 0;
    let edit = 0;

    yield () => {
      const object = objects[edit++ % objects.length];
      object.rotationY += 0.01;
      updateTransform(object);
      history[cursor] = objects.map((object) => ({
        position: object.position.slice(),
        quaternion: object.quaternion.slice(),
        scale: object.scale.slice(),
      }));
      cursor = (cursor + 1) % history.length;
      return history;
    };
  });
});
