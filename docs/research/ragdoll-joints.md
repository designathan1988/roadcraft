# Ragdoll joints in Jolt: why the bomb broke the page (R1)

Symptom: after a bomb (or a shot after one), `RuntimeError: table index is out of
bounds` inside `Step` of JoltPhysics.js (`render/ragdoll.ts` → `ragdollJolt.ts`
`JoltWorld.step`), and the page hung. Seen in 3 of 12 executions of the gate and in
2 of 2 bombs in the game pane (2026-10-12).

## Sources read
- Jolt, `Jolt/Physics/Constraints/ConstraintManager.cpp` (GitHub, master): the
  manager keeps `Ref<Constraint>`; `Remove` resets `mConstraintIndex` and moves the
  last constraint into the freed slot; removing a constraint that is not in the
  manager is checked only by `JPH_ASSERT` (debug builds): in a release build it pops
  another constraint, or reads freed memory.
- Jolt, `Jolt/Core/TempAllocator.h`: `TempAllocatorImpl::Allocate` out of memory
  traces "TempAllocator: Out of memory" and calls `std::abort()` — a different error
  from the one seen, so not the cause here.
- JoltPhysics.js 1.1.0 `JoltJS.h`: `JoltSettings` defaults (10 240 bodies, 65 536
  pairs, 10 240 contact constraints, 10 MB temp allocator); `JoltInterface` makes a
  `TempAllocatorImpl`; the package ships a debug build (`jolt-physics/debug-wasm-compat`)
  with the asserts on.
- Jolt, `SwingTwistConstraint.h/.cpp` and `HingeConstraint.h`: a swing-twist joint
  builds each body's frame as the matrix (twist, plane × twist, plane) and takes its
  quaternion; a hinge's "mHingeAxis1 and mNormalAxis1 should be perpendicular".
  The frame is a rotation only for unit, perpendicular axes.

## What was measured
Probe (question written first): the dev server with the debug Jolt build, a generated
city at 400/400, 12 bombs dropped by real clicks on people:
- before: 5 394 assert lines — 2 917 `SwingTwistConstraintPart.h:328 (ioSwing.IsNormalized())`
  and 197 `AngleConstraintPart.h:64 (inWorldSpaceAxis.IsNormalized(1.0e-4f))`;
- after the fix below: 0, and no page error; the release build ran the same 12 bombs
  without error.

## Causes (in `render/ragdoll.ts` `joltSpec`, at the SOURCE)
1. A thigh's cone leant forwards turned its twist axis (`lean`) but kept the plane
   axis computed for the untilted bone: frame 1 was not a rotation.
2. A direction between two particles on one point (a limb torn off, the particles
   left at the stump) was a zero vector (three's `normalize` of zero is zero): a
   hinge with a zero axis.
3. Found on the way (also fixed): `JoltRagdoll.tear` gave the piece the joints inside
   it without taking them from the body: two owners, a joint removed twice.

## Fix
- `render/ragdollAxes.ts`: every axis unit, every frame a rotation, with fixed
  fallbacks for degenerate directions; a leant cone turns its plane axis with its
  twist axis (`coneFrames`), a hinge's normal is made exactly perpendicular
  (`hingeFrame`). `tests/render/ragdollAxes.spec.ts` (5 000 random bodies, degenerate
  ones included; the SOURCE's leant cone shown invalid).
- `ragdollJolt.ts`: each joint is refused (an Error) before it reaches Jolt if its
  axes are not unit and perpendicular; one owner per joint in `tear`; a joint taken out
  twice is refused instead of corrupting the engine. `tests/render/ragdollJolt.spec.ts`.

## Not established
- The release-build crash is intermittent: the same probe run on the old build did
  not crash that time. The link "invalid frames → solver corruption → table index out
  of bounds" rests on the debug asserts and the source, not on a reproduced crash;
  confirmation is the gate (bomb and pistol in every execution) staying free of it.
- `joltSpec` builds all 12 parts even for a body that lost a limb (R15): the lost limb
  is simulated again on the body if it is recreated in Jolt. Not a crash; open.
