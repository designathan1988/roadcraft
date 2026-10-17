// @vitest-environment happy-dom The road catalogue in the road tool's drawer (the player's order of 2026-10-09).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { catalogStrip, pickedRoad } from '@ui/roads/catalogPanel';
import { drawProfile, setDrawProfile } from '@ui/roads/drawProfile';
import { closeProfileEditor } from '@ui/roads/profileEditor';
import { saveTemplate } from '@ui/roads/templates';
import { classTemplates } from '@world/roads/templates';

afterEach(() => { setDrawProfile(null); closeProfileEditor(); document.body.innerHTML = ''; localStorage.clear(); });

function mount(classIndex = 0): { root: HTMLElement; picked: number[]; render: () => void } {
  const picked: number[] = [];
  let cls = classIndex;
  const host = { classIndex: () => cls, pickClass: (i: number) => { cls = i; picked.push(i); }, refresh: () => { document.body.replaceChildren(catalogStrip(host)); } };
  document.body.replaceChildren(catalogStrip(host));
  return { root: document.body, picked, render: host.refresh };
}

describe('the road catalogue', () => {
  it('shows five tabs and a plan-view tile per road with its whole name, width and price, no native control', () => {
    const { root } = mount();
    expect([...root.querySelectorAll('.rc-tab')].map((b) => (b as HTMLElement).dataset['category'])).toEqual(['streets', 'avenues', 'highways', 'special', 'mine']);
    const cards = root.querySelectorAll('.rc-card');
    expect(cards.length).toBeGreaterThan(8);
    for (const card of cards) {
      expect(card.querySelector('.rc-name')?.textContent).toBeTruthy();
      expect(card.querySelector('.rc-meta')?.textContent).toMatch(/m · .*\/m/);
      expect(card.querySelector('img.rc-art')).not.toBeNull();
    }
    expect(root.querySelectorAll('select, input').length).toBe(0);
  });

  it('a click picks a road and the tool draws with it; a class card goes back to the class', () => {
    const { root, picked } = mount();
    (root.querySelector('.rc-tab[data-category="avenues"]') as HTMLButtonElement).click();
    (document.body.querySelector('[data-road="catalog:avenueBusCentre"]') as HTMLButtonElement).click();
    expect(drawProfile()?.profile.elements.some((e) => e.kind === 'lane' && e.use === 'bus')).toBe(true);
    expect(picked.at(-1)).toBe(drawProfile()?.type);
    expect(document.body.querySelector('.rc-card.on [data-action="customise"]')).not.toBeNull();
    expect(pickedRoad({ classIndex: () => 0 })?.id).toBe('catalog:avenueBusCentre');
    (document.body.querySelector('[data-road="class:avenue"]') as HTMLButtonElement).click();
    expect(drawProfile()).toBeNull();
  });

  it('"Customise..." opens the profile editor docked, not over the drawer', () => {
    mount();
    (document.body.querySelector('.rc-tab[data-category="streets"]') as HTMLButtonElement).click();
    (document.body.querySelector('.rc-card.on [data-action="customise"]') as HTMLButtonElement).click();
    const panel = document.querySelector('.rp-panel');
    expect(panel?.classList.contains('docked')).toBe(true);
    expect(panel?.querySelector('[data-action="fold"]')).not.toBeNull();
  });

  it('keeps the strip it built while nothing it shows changed: a render or a pick does not build the cards again (plan K5)', () => {
    // A road of the player's saved: the list read from storage is text to parse.
    expect(saveTemplate('Mine', 1, classTemplates()[1]!.profile)).not.toBeNull();
    const { root, render } = mount();
    const strip = root.querySelector('.rc-catalog')!;
    const img = strip.querySelector('img.rc-art')!;
    const parse = vi.spyOn(JSON, 'parse');
    // A render of the drawer (PageUp, PageDown): the same strip, its pictures not drawn again, the saved roads not parsed.
    render();
    expect(document.body.querySelector('.rc-catalog')).toBe(strip);
    expect(strip.querySelector('img.rc-art')).toBe(img);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    // A pick moves the mark and "Customise..." to the card picked, on the same cards.
    const cards = [...strip.querySelectorAll('.rc-card')];
    const other = cards.find((c) => !c.classList.contains('on'))!;
    (other.querySelector('.rc-card-main') as HTMLButtonElement).click();
    expect(document.body.querySelector('.rc-catalog')).toBe(strip);
    expect(other.classList.contains('on')).toBe(true);
    expect(strip.querySelectorAll('.rc-card.on').length).toBe(1);
    expect(strip.querySelectorAll('[data-action="customise"]').length).toBe(1);
    expect(other.querySelector('[data-action="customise"]')).not.toBeNull();
  });
});
