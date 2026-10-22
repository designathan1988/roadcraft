/** Small DOM helpers of the GPU area's tabs. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

export function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', '', text);
  b.type = 'button';
  b.title = title;
  b.onclick = onClick;
  return b;
}

export function bytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
  if (n >= 1024) return `${(n / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} KB`;
  return `${n} B`;
}

export const ms = (v: number): string => v.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

/** One colour per pass, steady across frames. */
export const PASS_COLOURS: Record<string, string> = {
  shadows: '#8e7cc3', scene: '#2fb3a0', gtao: '#e6a23c', canyon: '#d4675c', bloom: '#f2d16b', clouds: '#6fa8dc', smaa: '#9fc5a8', output: '#b4b4b4',
};

/** A table's filter from a tab's `focus` params: only what was given. */
export function filterOf(params: Readonly<Record<string, string>>, withCategory = true): { text?: string; category?: string } {
  return {
    ...(params['filter'] !== undefined ? { text: params['filter'] } : {}),
    ...(withCategory && params['category'] !== undefined ? { category: params['category'] } : {}),
  };
}
