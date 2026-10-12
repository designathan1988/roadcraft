import { formatBuildStamp, onBuildStamp, refreshBuildStamp } from './buildStamp';
import { onLanguageChange } from './i18n';

/** The About dialog (`index.html`): which build this is, and the credits. */
export function mountAbout(): void {
  const build = document.getElementById('aboutBuild');
  if (!build) return;
  const paint = (): void => {
    build.textContent = formatBuildStamp();
  };
  paint();
  onBuildStamp(paint);
  onLanguageChange(paint);
}

/** Opens the About dialog (the menu's About). */
export function openAbout(): void {
  const dialog = document.getElementById('aboutDialog') as HTMLDialogElement | null;
  const build = document.getElementById('aboutBuild');
  if (!dialog) return;
  if (build) build.textContent = formatBuildStamp();
  dialog.showModal();
  void refreshBuildStamp();
}
