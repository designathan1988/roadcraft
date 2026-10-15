import {
  ELDER_AMPLITUDE, SHUFFLE_AMPLITUDE, bakeFps, gaitClipOf,
  type GaitClip, type GaitClipName, type GaitClips,
} from '@render/citizenGait';
import {
  WALK_ADVANCE, strideShare, walkDuration, walkSource,
  type LibraryClip, type LibraryClipName, type WalkSex,
} from '@render/citizenWalk';

const bakedFrames = (duration: number, fps: number): number => Math.max(1, Math.round(duration * fps));

/** The Rocketbox library clips the gait plays, by the name the gait knows them by. */
const GAIT_LIBRARY = [
  'walkSlow', 'start', 'stop', 'run', 'turnLeft', 'turnRight',
  'idle', 'look', 'phone', 'talk', 'listen', 'sitDown', 'sitIdle', 'standUp',
  'read', 'bag', 'trolley', 'umbrella', 'cheer', 'dance', 'wave', 'drink', 'photo', 'crouchDown', 'crouchIdle', 'crouchUp', 'laugh', 'angry', 'argue', 'knock', 'headphones', 'eatIdle', 'workTable',
  'walkN1', 'walkN2', 'walkN3', 'walkStroll', 'walkCool', 'walkFast',
  // A drunk's walk (`DRUNK_WALKS`): every key of `GaitClips` made here, or `pace` read undefined.
  'walkDrunk',
] as const satisfies readonly (LibraryClipName & GaitClipName)[];

/**
 * Every gait clip of one sex at scale 1, straight from the library: what the
 * renderer bakes, without a body to bake it on. The tests measure with this.
 */
export function gaitClipsOf(library: Readonly<Record<LibraryClipName, LibraryClip>>, sex: WalkSex): GaitClips {
  const out = {} as Record<GaitClipName, GaitClip>;
  for (const name of GAIT_LIBRARY) {
    const clip = library[name];
    out[name] = gaitClipOf(clip, 1, bakedFrames(clip.duration, bakeFps(clip)));
  }
  const duration = walkDuration(sex);
  const walk: GaitClip = { frames: bakedFrames(duration, 30), duration, loop: true, stride: WALK_ADVANCE[sex] };
  out.walk = walk;
  out.walkElder = { ...walk, stride: walk.stride * strideShare(walkSource(sex), ELDER_AMPLITUDE) };
  out.walkShuffle = { ...out.walkSlow, stride: out.walkSlow.stride * strideShare(library.walkSlow.source, SHUFFLE_AMPLITUDE) };
  out.walkHandL = walk;
  out.walkHandR = walk;
  out.walkRest = { frames: 1, duration: 1, loop: true, stride: 0 };
  out.walkBack = out.walkLeft = out.walkRight = out.walkShuffle;
  return out;
}
