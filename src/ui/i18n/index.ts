import { EN } from './en';
import { PT_BR } from './pt-BR';

/** Interface translation. */

export type LanguageCode = 'en' | 'pt-BR';

export interface LanguageSpec {
  readonly code: LanguageCode;
  /** The language's own name, as its speakers write it. */
  readonly label: string;
}

export const LANGUAGES: readonly LanguageSpec[] = [
  { code: 'en', label: 'English' },
  { code: 'pt-BR', label: 'Português' },
];

export type Dictionary = Readonly<Record<string, string>>;

const DICTIONARIES: Readonly<Record<LanguageCode, Dictionary>> = {
  en: EN,
  'pt-BR': PT_BR,
};

const STORAGE_KEY = 'roadcraft.language';

const isLanguage = (value: unknown): value is LanguageCode => value === 'en' || value === 'pt-BR';

function detect(): LanguageCode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    // Private browsing denies storage; the browser's own language still applies.
  }
  // An empty list (some embedded browsers) is no choice: the single language then.
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of preferred) {
    if (typeof tag !== 'string') continue;
    if (tag.toLowerCase().startsWith('pt')) return 'pt-BR';
    if (tag.toLowerCase().startsWith('en')) return 'en';
  }
  return 'en';
}

let current: LanguageCode = 'en';
const listeners = new Set<(language: LanguageCode) => void>();

export function language(): LanguageCode {
  return current;
}

/** Looks up a key, substituting `{name}` placeholders from `params`. */
export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const table = DICTIONARIES[current];
  const template = table[key] ?? EN[key] ?? key;
  if (!params && !template.includes('{')) return template;
  // Placeholders every sentence may use (the road tool's keys), under the call's own.
  params = { ...globalParams(), ...params };
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

let globalParams: () => Readonly<Record<string, string | number>> = () => ({});
/** Placeholders any sentence may use without its caller passing them: the road tool's rebindable keys */
export function setGlobalParams(provider: () => Readonly<Record<string, string | number>>): void {
  globalParams = provider;
}

/** Picks the singular or plural key by `count`, and passes it as `{count}`. */
export function plural(key: string, count: number): string {
  return t(count === 1 ? `${key}.one` : `${key}.other`, { count });
}

const decimalFormats = new Map<string, Intl.NumberFormat>();
/** A measure with `digits` decimals, in the interface language's notation ("22,0" in Portuguese, "22.0" in English). */
export function formatDecimal(value: number, digits: number, lang: LanguageCode = current): string {
  const key = `${lang}:${digits}`;
  let format = decimalFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    decimalFormats.set(key, format);
  }
  return format.format(value);
}

/** A number the player typed, with a decimal comma or point: "3,1" and "3.1" are 3.1. */
export function parseDecimal(text: string): number {
  const s = text.trim().replace(',', '.');
  return s === '' || !/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number.NaN : Number(s);
}

export function setLanguage(next: LanguageCode): void {
  if (next === current) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Not being able to remember the choice is not a reason to refuse it.
  }
  document.documentElement.lang = next;
  applyTranslations(document);
  for (const listener of listeners) listener(next);
}

export function onLanguageChange(listener: (language: LanguageCode) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Rewrites every element in `root` that declares a translation key. */
export function applyTranslations(root: ParentNode = document): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset['i18n'];
    if (key) element.textContent = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    const key = element.dataset['i18nHtml'];
    if (key) element.innerHTML = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    const key = element.dataset['i18nTitle'];
    if (key) element.title = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    const key = element.dataset['i18nLabel'];
    if (key) element.setAttribute('aria-label', t(key));
  }
  const title = document.querySelector<HTMLTitleElement>('title[data-i18n]');
  if (title) document.title = t(title.dataset['i18n'] as string);
}

/** Resolves the initial language and applies it. Call once, at start-up. */
export function initLanguage(): LanguageCode {
  current = detect();
  document.documentElement.lang = current;
  applyTranslations(document);
  return current;
}
