import type { SerializedDoc } from '@world/doc';
import { type TilePiece, assembleWholeMap } from '@world/cityGen/assemble';
import { TILES, type WholeMapOptions, planWholeMap } from '@world/cityGen/wholeMap';
import type { TileAnswer, TileAsk } from './cityTile.worker';
import { jobLanes, jobPort } from './jobs/jobPool';

/** THE WHOLE MAP GENERATED, FROM THE PAGE (rewrite F7): every tile built in the job pool (`cityTile.worker.ts`), a lane per worker, each lane given the next tile when it answers; the page only counts them and, once all are in, joins them (`assembleWholeMap`) into the map it opens. Nothing of a tile is built on the page: a tile that fails gives the whole map up (the map left as it was). */

export class WholeMapRun {
  private readonly ports: Worker[] = [];
  private readonly pieces: TilePiece[] = [];
  /** The tiles not asked for yet, the heaviest (the most built up) first so the last to finish is a light one. */
  private readonly queue: TileAsk[];
  private over = false;

  /** `progress`: tiles done of all; `done`: the map joined; `failed`: why it was given up. */
  constructor(
    private readonly options: WholeMapOptions,
    private readonly progress: (done: number, total: number) => void,
    private readonly done: (map: SerializedDoc, tileMs: number) => void,
    private readonly failed: (why: string) => void,
  ) {
    const plan = planWholeMap(options);
    const all: { ask: TileAsk; heat: number }[] = [];
    for (let j = 0; j < TILES; j++) for (let i = 0; i < TILES; i++) all.push({ ask: { options: this.options, i, j }, heat: plan.tile(i, j).heat });
    this.queue = all.sort((a, b) => b.heat - a.heat).map((t) => t.ask);
  }

  get total(): number {
    return TILES * TILES;
  }

  start(): void {
    for (let lane = 0; lane < jobLanes(this.total); lane++) {
      const port = jobPort('cityTiles');
      port.onmessage = (event: MessageEvent<TileAnswer>) => this.answered(port, event.data);
      port.onerror = (event) => this.fail(`a tile worker failed: ${event.message}`);
      port.onmessageerror = () => this.fail('a tile worker sent a message that cannot be read');
      this.ports.push(port);
      this.next(port);
    }
  }

  /** Every lane let go (the page going away, another map asked for). */
  dispose(): void {
    this.over = true;
    for (const port of this.ports) port.terminate();
    this.ports.length = 0;
  }

  private next(port: Worker): void {
    const ask = this.queue.shift();
    if (ask) port.postMessage(ask);
  }

  private answered(port: Worker, answer: TileAnswer): void {
    if (this.over) return;
    if ('error' in answer) { this.fail(`tile ${answer.i},${answer.j}: ${answer.error}`); return; }
    this.pieces.push(answer.piece);
    this.progress(this.pieces.length, this.total);
    if (this.pieces.length < this.total) { this.next(port); return; }
    this.dispose();
    this.done(assembleWholeMap(this.pieces), this.pieces.reduce((s, p) => s + p.ms, 0));
  }

  private fail(why: string): void {
    if (this.over) return;
    this.dispose();
    this.failed(why);
  }
}
