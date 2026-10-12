/** The part of three's bundled meshoptimizer simplifier (`examples/jsm/libs`) the game uses. */
declare module 'three/examples/jsm/libs/meshopt_simplifier.module.js' {
  export const MeshoptSimplifier: {
    readonly ready: Promise<void>;
    simplify(
      indices: Uint32Array,
      positions: Float32Array,
      stride: number,
      targetIndexCount: number,
      targetError: number,
      flags: readonly string[],
    ): [Uint32Array, number];
  };
}
