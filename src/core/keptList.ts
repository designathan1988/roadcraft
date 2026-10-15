/** DO NOT write back the list a build could read */
export class KeptList {
  /** `what`: what the entries are, for the console ("blueprint", "road template"). */
  constructor(readonly key: string, private readonly what: string) {}

  /** The stored entries as they are; empty when nothing is stored, storage is blocked or its text is not a list. */
  entries(): readonly unknown[] {
    const stored = this.stored();
    return stored && 'entries' in stored ? stored.entries : [];
  }

  /** The entries this build reads, each by `read` (null: not read, kept as it is) */
  read<T>(read: (entry: unknown) => T | null): T[] {
    const out: T[] = [];
    for (const entry of this.entries()) {
      try {
        const value = read(entry);
        if (value !== null) out.push(value);
      } catch (error) {
        console.warn(`[kept] a ${this.what} this build cannot read; kept as it is`, error);
      }
    }
    return out;
  }

  /** Stores `change(entries)`; false when nothing was written (storage blocked or full). */
  update(change: (entries: readonly unknown[]) => readonly unknown[]): boolean {
    const stored = this.stored();
    if (!stored) return false;
    let entries: readonly unknown[];
    if ('entries' in stored) entries = stored.entries;
    else {
      if (!this.write(`${this.key}.unreadable.${Date.now().toString(36)}`, stored.unreadable)) return false;
      entries = [];
    }
    return this.write(this.key, JSON.stringify(change(entries)));
  }

  /** What is stored: its entries; its text when it is not a list; null when storage cannot be read. */
  private stored(): { readonly entries: readonly unknown[] } | { readonly unreadable: string } | null {
    let text: string | null;
    try {
      text = localStorage.getItem(this.key);
    } catch (error) {
      console.warn(`[kept] the ${this.what} list cannot be read`, error);
      return null;
    }
    if (!text) return { entries: [] };
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? { entries: parsed } : { unreadable: text };
    } catch (error) {
      console.warn(`[kept] the ${this.what} list is not readable; set aside at the next change`, error);
      return { unreadable: text };
    }
  }

  private write(key: string, text: string): boolean {
    try {
      localStorage.setItem(key, text);
      return true;
    } catch (error) {
      console.warn(`[kept] the ${this.what} list was not written`, error);
      return false;
    }
  }
}
