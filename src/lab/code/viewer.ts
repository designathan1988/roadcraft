import type { SourceStore } from './sourceStore';

/** THE CODE SHOWN: the original source around a line, the line marked, and a link that opens it in the editor (Vite's dev server `/__open-in-editor?file=path:line:column`, launch-editor resolving the path from the project's folder). */

export interface CodeViewer {
  readonly element: HTMLElement;
  /** `file`: a server path (`/src/x.ts`); `line`, `column` 1-based. */
  show(file: string, line: number, column: number, title: string): void;
  clear(): void;
}

/** Lines shown each side of the one marked. */
const AROUND = 14;

/** Asks the dev server to open `file` at `line` in the editor it finds running (or $LAUNCH_EDITOR). */
export function openInEditor(file: string, line: number, column: number): void {
  const path = file.replace(/^\//, '');
  void fetch(`/__open-in-editor?file=${encodeURIComponent(`${path}:${line}:${column}`)}`).catch((error: unknown) => console.warn('lab code: editor not opened', error));
}

export function createCodeViewer(store: SourceStore): CodeViewer {
  const root = document.createElement('div');
  root.className = 'lab-code-viewer';
  const bar = document.createElement('div');
  bar.className = 'lab-row';
  const label = document.createElement('span');
  label.className = 'lab-muted';
  label.textContent = 'Select a function to see its code.';
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open in editor';
  open.title = 'Opens the file at this line in the editor (Vite /__open-in-editor)';
  open.hidden = true;
  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = 'More lines';
  more.hidden = true;
  bar.append(label, open, more);
  const pre = document.createElement('pre');
  pre.className = 'lab-code';
  pre.hidden = true;
  root.append(bar, pre);
  let token = 0;
  let span = AROUND;
  let at: { file: string; line: number; column: number; title: string } | null = null;

  const draw = (text: string, line: number): void => {
    const lines = text.split('\n');
    const from = Math.max(1, line - span), to = Math.min(lines.length, line + span);
    const width = String(to).length;
    const out: HTMLElement[] = [];
    for (let n = from; n <= to; n++) {
      const row = document.createElement('div');
      row.className = n === line ? 'lab-code-line lab-code-hit' : 'lab-code-line';
      row.textContent = `${String(n).padStart(width)}  ${lines[n - 1] ?? ''}`;
      out.push(row);
    }
    pre.replaceChildren(...out);
    pre.hidden = false;
    // The marked line in the middle of the box (the box `position: relative`, `code.css`), the panel itself not scrolled.
    const hit = out[line - from];
    if (hit) pre.scrollTop = Math.max(0, hit.offsetTop - pre.clientHeight / 2);
  };

  const viewer: CodeViewer = {
    element: root,
    show(file, line, column, title) {
      const mine = ++token;
      if (at?.file !== file || at.line !== line) span = AROUND;
      at = { file, line, column, title };
      label.textContent = `${title} — ${file.replace(/^\//, '')}:${line}`;
      open.hidden = false;
      more.hidden = false;
      open.onclick = () => openInEditor(file, line, column);
      const now = store.textNow(file);
      if (now !== null) { draw(now, line); return; }
      pre.hidden = false;
      pre.textContent = 'loading…';
      void store.text(file).then((text) => {
        if (mine !== token) return;
        if (text === null) pre.textContent = `code of ${file} unavailable`;
        else draw(text, line);
      });
    },
    clear() {
      token++;
      at = null;
      label.textContent = 'Select a function to see its code.';
      open.hidden = more.hidden = pre.hidden = true;
    },
  };
  more.onclick = () => {
    span *= 2;
    if (at) viewer.show(at.file, at.line, at.column, at.title);
  };
  return viewer;
}
