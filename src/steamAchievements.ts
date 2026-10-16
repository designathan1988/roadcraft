/** STEAM ACHIEVEMENTS: milestones of the city told to the desktop shell (`desktop/main.cjs` `steam:unlock`); nothing without it. */

interface UnlockBridge {
  unlock(id: string): Promise<boolean>;
}

/** Roads on the map and the achievement each count unlocks; the ids are the ones set in Steamworks for the game. */
const ROAD_MILESTONES: readonly (readonly [count: number, id: string])[] = [[1, 'ROADS_1'], [100, 'ROADS_100'], [1000, 'ROADS_1000']];

export function createSteamAchievements(): { roads(count: number): void } {
  const bridge = (window as unknown as { roadcraftDesktop?: UnlockBridge }).roadcraftDesktop ?? null;
  /** Milestones passed this session: each asked once. */
  let passed = 0;
  return {
    roads(count) {
      if (!bridge) return;
      while (passed < ROAD_MILESTONES.length && count >= ROAD_MILESTONES[passed]![0]) {
        const id = ROAD_MILESTONES[passed]![1];
        passed++;
        void bridge.unlock(id).catch((error: unknown) => console.warn('achievement not told to Steam', id, error));
      }
    },
  };
}
