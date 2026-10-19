/** THE FUNCTIONS A SOURCE DECLARES, found by their shape line by line (no parser in the page): declarations, named function expressions and arrows, class and object methods. Approximate: a signature spread over lines, a callback passed inline, is not one. Interface and type bodies skipped. */

export interface DeclaredFunction {
  readonly name: string;
  /** 1-based. */
  readonly line: number;
  readonly kind: 'função' | 'arrow' | 'método';
}

const IDENT = '[A-Za-z_$][\\w$]*';
const DECL = new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})\\s*[<(]`);
const ARROW = new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|(?:<[^>]*>)?\\([^)]*\\)?[^=]*=>|${IDENT}\\s*=>|\\($)`);
const PROP_ARROW = new RegExp(`^\\s*(?:readonly\\s+)?(${IDENT})\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)]*\\)?[^=;]*=>|${IDENT}\\s*=>)`);
const CLASS_FIELD = new RegExp(`^\\s*(?:(?:public|private|protected|static|readonly|override)\\s+)*(#?${IDENT})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:\\([^)]*\\)?[^=]*=>|${IDENT}\\s*=>)`);
const METHOD = new RegExp(`^\\s*(?:(?:public|private|protected|static|async|override|get|set|abstract)\\s+)*\\*?(#?${IDENT})\\s*(?:<[^>]*>)?\\s*\\(.*\\)\\s*(?::\\s*[^{=;]+)?\\{(?:\\s*|.*\\}\\s*[,;]?\\s*)(?:\\/\\/.*)?$`);
const KEYWORD = /^(?:if|for|while|switch|catch|return|function|else|do|try|with|new|typeof|await|yield|super)$/;
const TYPE_BLOCK = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface\b|type\s+[\w$]+(?:<[^>]*>)?\s*=\s*\{|enum\b)/;

/** The functions `text` declares, by line. */
export function declaredFunctions(text: string): DeclaredFunction[] {
  const out: DeclaredFunction[] = [];
  const lines = text.split('\n');
  let inComment = false;
  /** While in an interface/type body: the depth to return to. */
  let typeDepth = -1;
  let depth = 0;
  lines.forEach((raw, i) => {
    let line = raw;
    if (inComment) {
      const end = line.indexOf('*/');
      if (end < 0) return;
      inComment = false;
      line = line.slice(end + 2);
    }
    const open = line.indexOf('/*');
    if (open >= 0 && line.indexOf('*/', open + 2) < 0) { inComment = true; line = line.slice(0, open); }
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const startDepth = depth;
    // Braces counted outside strings (roughly: quotes on one line).
    const code = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
    for (const c of code) { if (c === '{') depth++; else if (c === '}') depth--; }
    if (typeDepth >= 0) {
      if (depth <= typeDepth) typeDepth = -1;
      return;
    }
    if (TYPE_BLOCK.test(code)) {
      if (depth > startDepth) typeDepth = startDepth;
      return;
    }
    let m = DECL.exec(code);
    if (m) { out.push({ name: m[1]!, line: i + 1, kind: 'função' }); return; }
    m = ARROW.exec(code);
    if (m) { out.push({ name: m[1]!, line: i + 1, kind: 'arrow' }); return; }
    m = PROP_ARROW.exec(code) ?? CLASS_FIELD.exec(code);
    if (m && !KEYWORD.test(m[1]!)) { out.push({ name: m[1]!, line: i + 1, kind: 'arrow' }); return; }
    m = METHOD.exec(code);
    if (m && !KEYWORD.test(m[1]!) && startDepth > 0) out.push({ name: m[1]!, line: i + 1, kind: 'método' });
  });
  return out;
}
