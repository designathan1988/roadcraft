/** WHERE A REPORT GOES: a download in the browser, the dev server's `lab-reports/` (`scripts/vite/labReports.ts`), the desktop app's data folder (`desktop/main.cjs` `lab:report`). */

/** The desktop shell's call (`desktop/preload.cjs`), when the page runs in it. */
interface DesktopLab {
  saveLabReport?(stamp: string, json: string, md: string): Promise<string | null>;
}

export interface ServerReport {
  readonly name: string;
  readonly size: number;
  readonly mtime: number;
}

/** A file offered to the player (MDN: a Blob's object URL on an `<a download>`, revoked once clicked). */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A text opened in a new tab (the Markdown read in place). */
export function openText(text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  window.open(url, '_blank', 'noopener');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Written by the dev server into the repository's `lab-reports/`: the paths written, or null (no dev server, refused). */
export async function postToServer(stamp: string, json: string, md: string): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const response = await fetch('/__lab/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stamp, json, md }) });
    if (!response.ok) { console.warn('lab recorder: the dev server refused the report', response.status, await response.text()); return null; }
    const answer = (await response.json()) as { files?: string[] };
    return (answer.files ?? []).join(', ');
  } catch (error) {
    console.warn('lab recorder: report not sent to the dev server', error);
    return null;
  }
}

/** Written by the desktop app into its data folder: the folder, or null (not the desktop app). */
export async function saveDesktop(stamp: string, json: string, md: string): Promise<string | null> {
  const desktop = (window as unknown as { roadcraftDesktop?: DesktopLab }).roadcraftDesktop;
  if (!desktop?.saveLabReport) return null;
  try {
    return await desktop.saveLabReport(stamp, json, md);
  } catch (error) {
    console.warn('lab recorder: report not saved by the desktop app', error);
    return null;
  }
}

/** The reports the dev server keeps (`lab-reports/`), newest first; empty without one. */
export async function listServer(): Promise<ServerReport[]> {
  if (!import.meta.env.DEV) return [];
  try {
    const response = await fetch('/__lab/reports', { cache: 'no-store' });
    if (!response.ok) return [];
    return ((await response.json()) as { files?: ServerReport[] }).files ?? [];
  } catch (error) {
    console.warn('lab recorder: the dev server lists no reports', error);
    return [];
  }
}

export const serverUrl = (name: string): string => `/__lab/reports/${encodeURIComponent(name)}`;
