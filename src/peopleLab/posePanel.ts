import { FACE_CHANNELS, JOINTS, type PoseEditor } from './posing';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE RIG AND ANIMATION PANEL: poses to start from, the bones (also clicked on the body), IK, the face, and the timeline under the view */

export interface PosePanelHooks {
  readonly ui: ReturnType<typeof widgets>;
  readonly render: () => void;
  readonly now: () => number;
  /** Ready poses: a name each, set when picked. */
  readonly poses: readonly (readonly [string, () => void, boolean])[];
  /** The part shown: rig or animation. */
  readonly group: string;
  readonly setGroup: (g: string) => void;
}

export function posePanel(e: PoseEditor, { ui, render, now, poses, group, setGroup }: PosePanelHooks): Node[] {
  const { slider } = ui;
  const groups: readonly (readonly [string, string])[] = [['pose', 'Pose'], ['rig', 'Rig'], ['rosto', 'Expressão'], ['anim', 'Animação']];
  const bar = el('div', { cls: 'subtabs' }, ...groups.map(([id, label]) => {
    const b = el('button', { textContent: label, cls: id === group ? 'on' : '' });
    b.onclick = () => { setGroup(id); render(); };
    return b;
  }));
  const tool = (label: string, ico: string, on: boolean, run: () => void): HTMLButtonElement => {
    const b = el('button', { cls: `tool${on ? ' on' : ''}`, title: label }, icon(ico, 18), label);
    b.onclick = () => { run(); render(); };
    return b;
  };
  const bones = (): HTMLElement => el('div', { cls: 'chips' }, ...JOINTS.map(([label, name]) => {
    const b = el('button', { textContent: label, cls: e.bone === name ? 'on' : '' });
    b.onclick = () => { e.stop(); e.select(e.bone === name ? null : name); render(); };
    return b;
  }));
  const body: Record<string, () => Node[]> = {
    pose: () => [
      el('div', { cls: 'grid' }, ...poses.map(([label, set, on]) => {
        const t = el('button', { cls: `tile${on ? ' on' : ''}` }, label);
        t.onclick = () => { set(); render(); };
        return t;
      })),
    ],
    rig: () => [
      el('div', { cls: 'tools' }, tool('Girar', 'rotate', e.mode === 'rotate', () => e.setMode('rotate')), tool('Mover osso', 'move', e.mode === 'translate', () => e.setMode('translate'))),
      el('div', { cls: 'gap' }),
      bones(),
      el('h3', { textContent: 'IK' }),
      el('div', { cls: 'chips' }, ...e.chains.map((label, i) => {
        const b = el('button', { textContent: label, cls: e.ikActive(i) ? 'on' : '' });
        b.onclick = () => { e.toggleIk(i); render(); };
        return b;
      })),
      el('div', { cls: 'gap' }),
      (() => { const b = el('button', { cls: 'big alt' }, icon('trash', 15), 'Repor pose'); b.onclick = () => { e.reset(); render(); }; return b; })(),
    ],
    rosto: () => FACE_CHANNELS.map(([ch, label]) => slider(label, 0, 1, 0.01, e.face[ch] ?? 0, (v) => e.setFace(ch, v))),
    anim: () => {
      const add = el('button', { cls: 'big save' }, icon('key', 15), 'Chave');
      add.onclick = () => { e.addKey(); render(); };
      const play = el('button', { cls: 'big alt' }, icon(e.playing ? 'stop' : 'play', 15), e.playing ? 'Parar' : 'Tocar');
      play.onclick = () => { if (e.playing) e.stop(); else e.play(now()); render(); };
      const loop = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: e.loop }), 'Repetir');
      loop.querySelector('input')!.addEventListener('change', (ev) => { e.loop = (ev.target as HTMLInputElement).checked; });
      return [
        el('div', { cls: 'pair' }, add, play),
        slider('Duração', 1, 12, 0.5, e.duration, (v) => { e.duration = v; render(); }, (v) => `${v} s`),
        loop,
        el('h3', { textContent: 'Chaves' }),
        el('div', { cls: 'chips' }, ...e.keys.map((k) => {
          const b = el('button', { textContent: `${k.t.toFixed(2)} s`, cls: Math.abs(k.t - e.time) < 1e-3 ? 'on' : '' });
          b.onclick = () => { e.scrub(k.t); render(); };
          b.oncontextmenu = (ev) => { ev.preventDefault(); e.deleteKey(k.t); render(); };
          return b;
        })),
      ];
    },
  };
  return [bar, ...(body[group] ?? body['pose']!)()];
}

/** The timeline under the view: a ruler of the duration, the keys as diamonds, the playhead dragged to scrub. */
export function timeline(e: PoseEditor, render: () => void): HTMLElement {
  const box = el('div', { cls: 'timeline on' });
  const track = el('div', { cls: 'track' });
  const head = el('div', { cls: 'playhead' });
  const label = el('span', { cls: 'tl-time' });
  const pct = (t: number): string => `${(t / e.duration) * 100}%`;
  const draw = (): void => {
    track.replaceChildren(...e.keys.map((k) => { const d = el('div', { cls: 'tl-key' }); d.style.left = pct(k.t); return d; }), head);
    for (let s = 0; s <= Math.floor(e.duration); s++) { const tick = el('div', { cls: 'tl-tick' }); tick.style.left = pct(s); tick.textContent = String(s); track.append(tick); }
    head.style.left = pct(Math.min(e.time, e.duration));
    label.textContent = `${e.time.toFixed(2)} s`;
  };
  const at = (ev: PointerEvent): number => {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * e.duration;
  };
  let dragging = false;
  track.addEventListener('pointerdown', (ev) => { dragging = true; track.setPointerCapture(ev.pointerId); e.scrub(Math.round(at(ev) * 24) / 24); draw(); });
  track.addEventListener('pointermove', (ev) => { if (dragging) { e.scrub(Math.round(at(ev) * 24) / 24); draw(); } });
  track.addEventListener('pointerup', () => { dragging = false; render(); });
  box.append(label, track);
  draw();
  (box as HTMLElement & { draw?: () => void }).draw = draw;
  return box;
}
