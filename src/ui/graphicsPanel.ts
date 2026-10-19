import { onLanguageChange, t } from './i18n';

/** THE GRAPHICS OPTIONS: a dialog of choices, each applied to the running game as it is picked (`graphicsWiring.ts`). */

export type PresetName = 'low' | 'medium' | 'high' | 'ultra';

export interface GraphicsChoices {
  readonly preset: PresetName;
  /** The shadow map's side, texels; 0 no shadows. */
  readonly shadows: number;
  readonly ambientOcclusion: boolean;
  readonly smaa: boolean;
  /** The drawn resolution follows the GPU's frame time (`core/dynamicResolution.ts`). */
  readonly dynamicResolution: boolean;
  /** Frames a second at most; 0 none. */
  readonly fpsLimit: number;
  readonly vsync: boolean;
  readonly fullscreen: boolean;
}

export interface GraphicsPanelDeps {
  read(): GraphicsChoices;
  /** One choice made: applied at once. */
  change(patch: Partial<GraphicsChoices>): void;
  /** The desktop shell answers: VSync is offered (a browser always syncs). */
  desktop(): boolean;
  /** The GPU's name as the driver gives it. */
  gpu(): string;
}

const PRESETS: readonly PresetName[] = ['low', 'medium', 'high', 'ultra'];
const SHADOWS = [0, 1024, 2048, 4096] as const;
const FPS = [0, 30, 60, 120, 144] as const;

export function createGraphicsPanel(deps: GraphicsPanelDeps): { open(): void } {
  const dialog = document.createElement('dialog');
  dialog.className = 'options-dialog glass';
  dialog.setAttribute('aria-labelledby', 'optionsTitle');
  document.body.appendChild(dialog);

  const choiceRow = <T extends string | number | boolean>(name: string, items: readonly (readonly [T, string])[], value: T,
    pick: (v: T) => void, note?: string): HTMLElement => {
    const row = document.createElement('div');
    row.className = 'options-row';
    const label = document.createElement('div');
    label.className = 'options-name';
    label.textContent = name;
    const group = document.createElement('div');
    group.className = 'options-choices';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', name);
    for (const [v, text] of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `v2-choice${v === value ? ' on' : ''}`;
      b.textContent = text;
      b.setAttribute('aria-pressed', String(v === value));
      // The choice already made: nothing to apply (UI-08: the post chain was made again, the canvas sized twice, for a click on the lit button).
      b.onclick = () => { if (v === value) return; pick(v); render(); };
      group.appendChild(b);
    }
    row.append(label, group);
    if (note) {
      const small = document.createElement('div');
      small.className = 'options-note';
      small.textContent = note;
      row.appendChild(small);
    }
    return row;
  };
  const onOff = (): readonly (readonly [boolean, string])[] => [[false, t('gfx.off')], [true, t('gfx.on')]];

  function render(): void {
    const now = deps.read();
    const title = document.createElement('h2');
    title.id = 'optionsTitle';
    title.textContent = t('gfx.title');
    const rows = [
      choiceRow(t('gfx.preset'), PRESETS.map((p) => [p, t(`quality.${p}`)] as const), now.preset, (preset) => deps.change({ preset })),
      choiceRow(t('gfx.shadows'), SHADOWS.map((s) => [s, t(`gfx.shadows.${s}`)] as const), now.shadows, (shadows) => deps.change({ shadows })),
      choiceRow(t('gfx.ao'), onOff(), now.ambientOcclusion, (ambientOcclusion) => deps.change({ ambientOcclusion })),
      choiceRow(t('gfx.aa'), onOff(), now.smaa, (smaa) => deps.change({ smaa })),
      choiceRow(t('gfx.dynamicResolution'), onOff(), now.dynamicResolution, (dynamicResolution) => deps.change({ dynamicResolution }),
        t('gfx.dynamicResolution.note')),
      choiceRow(t('gfx.fpsLimit'), FPS.map((f) => [f, f === 0 ? t('gfx.fpsLimit.none') : String(f)] as const), now.fpsLimit,
        (fpsLimit) => deps.change({ fpsLimit })),
      ...(deps.desktop()
        ? [choiceRow(t('gfx.vsync'), onOff(), now.vsync, (vsync) => deps.change({ vsync }), t('gfx.vsync.note'))]
        : []),
      choiceRow(t('gfx.fullscreen'), onOff(), now.fullscreen, (fullscreen) => deps.change({ fullscreen })),
    ];
    const gpu = document.createElement('p');
    gpu.className = 'options-gpu';
    gpu.textContent = `${t('gfx.gpu')}: ${deps.gpu()}`;
    const form = document.createElement('form');
    form.method = 'dialog';
    const close = document.createElement('button');
    close.className = 'about-close';
    close.textContent = t('gfx.close');
    form.appendChild(close);
    dialog.replaceChildren(title, ...rows, gpu, form);
  }

  onLanguageChange(() => { if (dialog.open) render(); });
  return {
    open() {
      render();
      if (!dialog.open) dialog.showModal();
    },
  };
}
