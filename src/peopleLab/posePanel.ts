import { FACE_GROUPS, FACE_LABELS, FACE_PRESETS, shapesOf } from './faceRig';
import type { PoseEditor } from './posing';
import { icon } from './icons';
import { el, type widgets } from './widgets';

/** THE RIG AND ANIMATION PANEL: poses to start from, the bones (clicked on the body), IK, the face's 52 shapes, and the timeline under the view */

export interface PosePanelHooks {
  readonly ui: ReturnType<typeof widgets>;
  readonly render: () => void;
  readonly now: () => number;
  /** Ready poses: a name each, set when picked. */
  readonly poses: readonly (readonly [string, () => void, boolean])[];
  /** The part shown: pose, rig, face or animation. */
  readonly group: string;
  readonly setGroup: (g: string) => void;
  /** The face's 52 shapes are on the person (`faceRig.attachFace`); asked for when the face opens. */
  readonly faceReady: boolean;
  readonly prepareFace: () => void;
}

/** The face's region shown and whether a pair moves as one. */
const faceView = { group: 'smile', mirrored: true };

export function posePanel(e: PoseEditor, { ui, render, now, poses, group, setGroup, faceReady, prepareFace }: PosePanelHooks): Node[] {
  const { slider, iconSeg, toggle } = ui;
  const groups: readonly (readonly [string, string, string])[] = [['pose', 'pose', 'Poses'], ['rig', 'bones', 'Rig e IK'], ['rosto', 'face', 'Expressão'], ['anim', 'anim', 'Animação']];
  const bar = iconSeg(groups, group, (g) => setGroup(g));
  const button = (ico: string, title: string, on: boolean, run: () => void): HTMLButtonElement => {
    const b = el('button', { cls: `toggle${on ? ' on' : ''}`, title }, icon(ico, 16));
    b.onclick = () => { run(); render(); };
    return b;
  };
  const CHAIN_ICONS: readonly (readonly [string, boolean])[] = [['hand', false], ['hand', true], ['foot', false], ['foot', true]];
  const body: Record<string, () => Node[]> = {
    pose: () => [
      el('div', { cls: 'grid' }, ...poses.map(([label, set, on]) => {
        const t = el('button', { cls: `tile${on ? ' on' : ''}` }, label);
        t.onclick = () => { set(); render(); };
        return t;
      })),
    ],
    rig: () => [
      el('div', { cls: 'bar' },
        button('rotate', 'Girar osso', e.mode === 'rotate', () => e.setMode('rotate')),
        button('move', 'Mover osso', e.mode === 'translate', () => e.setMode('translate')),
        el('span', { cls: 'bar-gap' }),
        ...e.chains.map((label, i) => {
          const [ico, right] = CHAIN_ICONS[i] ?? ['key', false];
          const b = button(ico, label, e.ikActive(i), () => e.toggleIk(i));
          if (right) b.classList.add('flip');
          return b;
        }),
        el('span', { cls: 'bar-gap' }),
        button('undo', 'Repor pose', false, () => e.reset())),
    ],
    rosto: () => {
      if (!faceReady) { prepareFace(); return [el('div', { cls: 'loading' })]; }
      const regions = FACE_GROUPS.map(([id, ico, title]) => [id, ico, title] as const);
      const shown = FACE_GROUPS.find(([id]) => id === faceView.group) ?? FACE_GROUPS[0]!;
      const sliders: Node[] = [];
      for (const entry of shown[3]) {
        for (const [key, names] of shapesOf(entry, faceView.mirrored)) {
          const pair = entry.endsWith('*');
          const base = pair ? entry.slice(0, -1) : key;
          const side = pair && key.endsWith('Left') ? ' E' : pair && key.endsWith('Right') ? ' D' : '';
          const value = Math.max(...names.map((n) => e.face[n] ?? 0));
          sliders.push(slider(`${FACE_LABELS[base] ?? base}${side}`, 0, 1, 0.01, value, (v) => { for (const n of names) e.setFace(n, v); }));
        }
      }
      return [
        el('div', { cls: 'chips' }, ...FACE_PRESETS.map(([label, weights]) => {
          const b = el('button', { textContent: label });
          b.onclick = () => { e.setWholeFace(weights); render(); };
          return b;
        })),
        el('div', { cls: 'bar' }, iconSeg(regions, faceView.group, (g) => { faceView.group = g; }),
          toggle('mirror', 'Espelhar esquerda e direita', faceView.mirrored, (v) => { faceView.mirrored = v; })),
        ...sliders,
      ];
    },
    anim: () => {
      const add = button('key', 'Chave aqui', false, () => e.addKey());
      const play = button(e.playing ? 'stop' : 'play', e.playing ? 'Parar' : 'Tocar', e.playing, () => { if (e.playing) e.stop(); else e.play(now()); });
      const loop = button('loop', 'Repetir', e.loop, () => { e.loop = !e.loop; });
      return [
        el('div', { cls: 'bar' }, add, play, loop),
        slider('Duração', 1, 12, 0.5, e.duration, (v) => { e.duration = v; render(); }, (v) => `${v} s`),
        el('div', { cls: 'chips' }, ...e.keys.map((k) => {
          const b = el('button', { textContent: `${k.t.toFixed(2)} s`, cls: Math.abs(k.t - e.time) < 1e-3 ? 'on' : '', title: 'Clique: ir · botão direito: apagar' });
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
