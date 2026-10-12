import type { RoadSegment } from '@world/doc';
import { type RoadProfileSpec, profileOf, profileWidth } from '@world/roads/profile';
import { plural, t } from '../i18n';
import { drawSection, metresText } from './crossSection';
import { setDrawProfile } from './drawProfile';
import { openProfileEditor } from './profileEditor';
import './roads.css';

/**
 * THE ROAD'S PROFILE in the inspector (docs/VIAS.md V2): the cross-section in
 * miniature, drawn as the editor draws it (`crossSection.ts`) with each
 * element's width under it, the road's total width, lanes, paving and speed
 * in one line, and the button that opens the profile editor. Every change is
 * made in the editor, one place; what it applies is one edit of the road
 * (`apply`), judged and paid for like any other.
 */
export function mountProfilePanel(
  host: HTMLElement,
  segment: RoadSegment,
  apply: (profile: RoadProfileSpec, type?: number) => void,
  /**
   * V8: this road's profile copied to the whole street it runs in (`chain`
   * segments, itself included), and the road tool given it to draw with
   * (the eyedropper).
   */
  more: { readonly chain?: number; readonly toStreet?: () => void; readonly drawWith?: () => void } = {},
): void {
  const profile = profileOf(segment);
  const panel = document.createElement('section');
  panel.className = 'rp-summary road-profile-panel';

  const head = document.createElement('div');
  head.className = 'rp-summary-head';
  const title = document.createElement('span');
  title.textContent = t('profile.title');
  const total = document.createElement('span');
  total.className = 'rp-sub';
  total.textContent = t('profileEditor.totalWidth', { width: metresText(profileWidth(profile)) });
  head.append(title, total);

  const art = document.createElement('div');
  art.className = 'rp-summary-art';
  art.innerHTML = drawSection(profile, { width: 300, height: 112, handles: false, title: t('profile.diagram') }).svg;

  const lanes = profile.elements.filter((e) => e.kind === 'lane').length;
  const facts = document.createElement('div');
  facts.className = 'rp-sub rp-summary-facts';
  facts.textContent = [
    plural('profile.summary.lanes', lanes),
    t(`profile.materialName.${profile.carriageway ?? 'asphalt'}`),
    t('profileEditor.speedValue', { speed: profile.speedKmh }),
  ].join(' · ');

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'rp-btn primary';
  edit.textContent = t('profileEditor.open');
  edit.dataset['action'] = 'openProfileEditor';
  edit.onclick = () => openProfileEditor({
    title: t('profileEditor.thisRoad'),
    profile,
    type: segment.type,
    apply: (next, type) => apply(next, type),
    drawWith: (name, next, type) => setDrawProfile({ name, profile: next, type }),
  });

  const row = document.createElement('div');
  row.className = 'rp-summary-actions';
  row.append(edit);
  if (more.drawWith) {
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'rp-btn';
    pick.textContent = t('profile.drawWith');
    pick.title = t('profile.drawWithTip');
    pick.dataset['action'] = 'eyedropper';
    pick.onclick = () => {
      setDrawProfile({ name: t('profile.copied'), profile, type: segment.type });
      more.drawWith?.();
    };
    row.append(pick);
  }
  if (more.toStreet && (more.chain ?? 0) > 1) {
    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'rp-btn';
    all.textContent = t('profile.toStreet', { count: more.chain ?? 0 });
    all.title = t('profile.toStreetTip');
    all.dataset['action'] = 'toStreet';
    all.onclick = () => more.toStreet?.();
    row.append(all);
  }
  panel.append(head, art, facts, row);
  host.append(panel);
}
