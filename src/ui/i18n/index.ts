import { EN } from './en';
import { PT_BR } from './pt-BR';

/**
 * Interface translation.
 *
 * Every string a player can read lives in a dictionary here, never inline in a
 * module or in `index.html`. Two rules make that workable:
 *
 *  1. **The code is English.** Keys, identifiers, comments and documentation are
 *     English whatever language the interface is showing; the dictionaries are
 *     the only place another language appears.
 *  2. **Markup declares its own keys.** An element carries `data-i18n` (text),
 *     `data-i18n-title`, `data-i18n-label` (aria-label) or `data-i18n-html`, and
 *     `applyTranslations` rewrites them. Adding a language therefore never means
 *     touching the markup, and a missing key is visible immediately because it
 *     falls back to the English string rather than to an empty element.
 */

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
  const preferred = typeof navigator === 'undefined' ? [] : navigator.languages ?? [navigator.language];
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

/**
 * Looks up a key, substituting `{name}` placeholders from `params`.
 *
 * Falls back to English and then to the key itself, so a missing translation
 * degrades to a readable string rather than to a blank.
 */
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
/**
 * Placeholders any sentence may use without its caller passing them: the
 * road tool's rebindable keys (`{heightUp}`, `editor/roads/keys.ts`), so a
 * hint re-translated on a change of language still names the right key.
 */
export function setGlobalParams(provider: () => Readonly<Record<string, string | number>>): void {
  globalParams = provider;
}

/** Whether the reference dictionary defines `key` (every language has the same keys). */
export function hasKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(EN, key);
}

/** Picks the singular or plural key by `count`, and passes it as `{count}`. */
export function plural(key: string, count: number): string {
  return t(count === 1 ? `${key}.one` : `${key}.other`, { count });
}

const decimalFormats = new Map<string, Intl.NumberFormat>();
/**
 * A measure with `digits` decimals, in the interface language's notation
 * ("22,0" in Portuguese, "22.0" in English). One `Intl.NumberFormat` per
 * language and precision, kept: labels drawn every frame use it (MDN,
 * `Number.prototype.toLocaleString`, "Performance").
 */
export function formatDecimal(value: number, digits: number, lang: LanguageCode = current): string {
  const key = `${lang}:${digits}`;
  let format = decimalFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    decimalFormats.set(key, format);
  }
  return format.format(value);
}

/**
 * A number the player typed, with a decimal comma or point: "3,1" and "3.1"
 * are 3.1. Grouping marks are not accepted (a field holds a measure, not a
 * sum of money). NaN when it is not a number.
 */
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
