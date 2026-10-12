import { t } from './i18n';

/**
 * The build stamp: branch, short commit and date of what is running
 * (`build-stamp.ts` at the project root), shown in the About dialog; in
 * development re-read from the server each time the dialog opens.
 */
export interface BuildStamp {
  readonly branch: string;
  readonly hash: string;
  readonly date: string;
  readonly dirty: boolean;
}

declare const __BUILD_STAMP__: BuildStamp | undefined;

const BAKED: BuildStamp = typeof __BUILD_STAMP__ !== 'undefined' && __BUILD_STAMP__
  ? __BUILD_STAMP__
  : { branch: 'unknown', hash: 'unknown', date: '', dirty: false };

let stamp: BuildStamp = BAKED;
const listeners = new Set<(value: BuildStamp) => void>();

export const buildStamp = (): BuildStamp => stamp;

export function formatBuildStamp(value: BuildStamp = stamp): string {
  return t('build.stamp', {
    branch: value.branch,
    hash: value.dirty ? `${value.hash}+` : value.hash,
    date: value.date.slice(0, 16).replace('T', ' '),
  });
}

export function onBuildStamp(listener: (value: BuildStamp) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Re-reads the stamp from the development server (the About dialog opened): a fast-forward shows without a reload. */
export async function refreshBuildStamp(): Promise<void> {
  if (!import.meta.env.DEV) return;
  try {
    const response = await fetch('/__build', { cache: 'no-store' });
    if (!response.ok) return;
    const next = (await response.json()) as BuildStamp;
    if (next.hash === stamp.hash && next.branch === stamp.branch && next.dirty === stamp.dirty) return;
    stamp = next;
    for (const listener of listeners) listener(stamp);
  } catch {
    // The server went away; keep the last stamp.
  }
}
