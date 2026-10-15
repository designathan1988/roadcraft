// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { FrameTimer, HealthLog } from '@core/health';
import { BarrierTool } from '@editor/barriers';
import { setLanguage } from '@ui/i18n';
import { EN } from '@ui/i18n/en';
import { PT_BR } from '@ui/i18n/pt-BR';
import { watchHealth } from '@ui/healthWatch';
import { CameraGestures } from '@view/cameraGestures';

/**
 * EVERY TEXT THE PLAYER READS COMES FROM THE DICTIONARIES. The F9 monitor's
 * messages and the gestures it names were Portuguese inside the code (an
 * English player read "Erro sem mensagem"), and the Portuguese dictionary
 * carried English words ("Inset", "Offset", "Inspector").
 */
const src = (path: string): string => readFileSync(resolve(process.cwd(), 'src', path), 'utf8');

afterEach(() => { setLanguage('en'); });

describe('text the player reads', () => {
  it('no Portuguese inside the code of the monitor, the camera gestures and the walls tool', () => {
    for (const path of ['ui/healthWatch.ts', 'view/cameraGestures.ts', 'editor/barriers.ts']) {
      expect(src(path).match(/[ãõçáéíóúâêôà]/giu) ?? [], path).toEqual([]);
    }
  });

  it('the monitor writes its messages in the player\'s language', () => {
    const realError = console.error;
    const realWorker = window.Worker;
    // happy-dom has no Worker; the monitor wraps the page's own.
    window.Worker = class extends EventTarget {} as unknown as typeof Worker;
    try {
      const log = new HealthLog();
      watchHealth({ log, frames: new FrameTimer(), canvas: document.createElement('canvas'), context: () => '' });
      setLanguage('en');
      window.dispatchEvent(new ErrorEvent('error', { message: '' }));
      setLanguage('pt-BR');
      window.dispatchEvent(new ErrorEvent('error', { message: '' }));
      const messages = log.latest(10).map((e) => e.message);
      expect(messages).toContain(EN['health.msg.noMessage']);
      expect(messages).toContain(PT_BR['health.msg.noMessage']);
      expect(EN['health.msg.noMessage']).not.toBe(PT_BR['health.msg.noMessage']);
    } finally {
      console.error = realError;
      window.Worker = realWorker;
    }
  });

  it('gestures are named by dictionary keys', () => {
    const barrier = new BarrierTool({ net: () => null, kind: () => 'fence', removeAt: () => false, build: () => {}, hint: () => {}, redraw: () => {} });
    barrier.down({ x: 0, y: 0 }, false, 0, 0, 1);
    const key = barrier.gesture()!;
    expect(EN[key], key).toBeTruthy();
    expect(PT_BR[key], key).toBeTruthy();
    const hand = new CameraGestures({} as never);
    hand.startOrbit(1, { x: 0, y: 0 }, false, 0);
    const orbit = hand.gesture()!;
    expect(EN[orbit], orbit).toBeTruthy();
    expect(PT_BR[orbit], orbit).toBeTruthy();
    for (const k of ['gesture.camera.pinch', 'gesture.camera.pan']) {
      expect(src('view/cameraGestures.ts')).toContain(`'${k}'`);
      expect(EN[k], k).toBeTruthy();
      expect(PT_BR[k], k).toBeTruthy();
    }
  });

  it('the Portuguese dictionary is Portuguese', () => {
    for (const key of ['builder.tool.insetFace', 'builder.tool.offsetOut', 'builder.tool.offsetIn']) {
      expect(PT_BR[key], key).not.toBe(EN[key]);
    }
    for (const [key, text] of Object.entries(PT_BR)) expect(text, key).not.toMatch(/\binspector\b|\bOffset\b|\bInset\b/i);
  });
});
