import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import type { FromSim } from '@sim/host/protocol';
import type { NodeId, SegmentId } from '@world/ids';
import { RoadDoc } from '@world/doc';

/** The panels' questions to the simulation's worker (`SimClient.asked`): each kept by its kind and id while it is asked */

const RUN = { traffic: true, pedestrians: true, maxShare: 1 };
type Inside = { receive(message: FromSim): void; readonly answers: Map<string, unknown> };
const inside = (client: SimClient): Inside => client as unknown as Inside;

describe('sim client answers', () => {
  it('keeps an answer by its question, and lets it go once nobody asks it', () => {
    const client = new SimClient(new RoadDoc());
    const road = 5 as SegmentId;
    // The first ask has no answer yet (ask 1).
    expect(client.segmentTraffic(road)).toBeNull();
    inside(client).receive({ type: 'answer', id: 1, answer: { flow: 3 } });
    // Asked again: the last answer (ask 2); the junction of the same number is another question (ask 3).
    expect(client.segmentTraffic(road)).toEqual({ flow: 3 });
    expect(client.junction(5 as NodeId)).toBeNull();
    expect(inside(client).answers.size).toBe(2);
    // Asked through the panels' rounds: kept.
    for (let i = 0; i < 10; i++) { client.frame(0.5, false, RUN); client.segmentTraffic(road); }
    expect(inside(client).answers.size).toBe(1);
    expect(client.segmentTraffic(road)).toEqual({ flow: 3 });
    // Nobody asks for a while: let go, and a late answer to it is not kept.
    client.frame(3, false, RUN);
    client.frame(3, false, RUN);
    expect(inside(client).answers.size).toBe(0);
    inside(client).receive({ type: 'answer', id: 2, answer: { flow: 9 } });
    expect(inside(client).answers.size).toBe(0);
  });
});
