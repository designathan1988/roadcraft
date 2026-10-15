import { type GrowAnswer, type GrowAsk, GrowthReplica } from '@editor/growthReplica';
import type { GrowthLane } from '@editor/growthFeed';
import { jobPort } from './jobs/jobPool';

/** THE GROWTH'S LANE OF THE JOB POOL, FROM THE PAGE (`growth.worker.ts`): one building at a time; a failed or silent lane falls back to a replica on the page */

/** Longest the worker may stay silent with a lot waiting (one lot is milliseconds; the module's first load, some hundred). */
const SILENCE_MS = 10_000;

export class GrowthPool implements GrowthLane {
  private worker: Worker | null = null;
  /** No worker to be had: the replica on the page, and the ask it answers at the next frame. */
  private local: GrowthReplica | null = null;
  private pending: GrowAsk | null = null;
  /** An answer not taken yet (`take` said no). */
  private held: GrowAnswer | null = null;
  /** When the lot waiting on the worker was posted; null: none waits. */
  private postedAt: number | null = null;

  /** `take`: an answer came, false to offer it again next frame; `restarted`: the replica is new, all to be sent again. */
  constructor(private readonly take: (answer: GrowAnswer) => boolean, private readonly restarted: () => void) {}

  post(ask: GrowAsk, transfer: readonly ArrayBuffer[]): void {
    if (!this.worker && !this.local) this.start();
    if (this.worker) {
      this.worker.postMessage(ask, [...transfer]);
      this.postedAt = performance.now();
    } else this.pending = ask;
  }

  /** Once a frame: an answer held offered again, the page's replica's lot answered, a silent worker given up. */
  pump(): void {
    if (this.held && this.take(this.held)) this.held = null;
    if (this.local && this.pending && !this.held) {
      const ask = this.pending;
      this.pending = null;
      this.offer(this.local.handle(ask));
    }
    if (this.postedAt !== null && performance.now() - this.postedAt > SILENCE_MS) {
      this.fail(`the growth worker was silent for ${SILENCE_MS} ms with a lot waiting`);
    }
  }

  /** Ends the worker (the page going away). */
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.postedAt = null;
  }

  private offer(answer: GrowAnswer): void {
    if (!this.take(answer)) this.held = answer;
  }

  private start(): void {
    if (typeof Worker === 'undefined') { this.local = new GrowthReplica(); return; }
    try {
      const worker = jobPort('growth', 0);
      worker.onmessage = (event: MessageEvent<GrowAnswer>) => {
        if (this.worker !== worker) return;
        this.postedAt = null;
        this.offer(event.data);
      };
      worker.onerror = (event) => this.fail(`the growth worker failed: ${event.message}`);
      worker.onmessageerror = () => this.fail('the growth worker sent a message that cannot be read');
      this.worker = worker;
    } catch (error) {
      console.warn('[growth] no worker for the growth; it runs on the page', error);
      this.local = new GrowthReplica();
    }
  }

  private fail(why: string): void {
    if (!this.worker) return;
    console.warn(`[growth] ${why}; the growth goes on on the page`);
    this.dispose();
    this.local = new GrowthReplica();
    this.restarted();
  }
}
