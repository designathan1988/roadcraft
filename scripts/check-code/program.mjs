// THE PROGRAM the code rules read (`scripts/check-code.mjs`): the TypeScript program of the project, its type check
import ts from 'typescript';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const projectAt = process.argv.indexOf('--project');
const root = projectAt >= 0 ? resolve(process.argv[projectAt + 1]) : process.cwd();
const BASELINE = join(root, 'scripts/baselines/code-rules.baseline.json');
const rel = (file) => relative(root, file).split(sep).join('/');
const started = performance.now();

// ------------------------------------------------------------ the type check
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); process.exit(2); },
});
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: parsed.options,
  projectReferences: parsed.projectReferences,
  configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => ts.sys.newLine,
  }));
  console.error(`types: ${diagnostics.length} error(s)`);
  process.exit(1);
}
const typed = performance.now();
const checker = program.getTypeChecker();

// ------------------------------------------------------------ the functions
const sources = program.getSourceFiles().filter((f) => !f.isDeclarationFile && rel(f.fileName).startsWith('src/'));
const srcFiles = new Map();
const inSrc = (node) => {
  const file = node.getSourceFile();
  let yes = srcFiles.get(file);
  if (yes === undefined) srcFiles.set(file, yes = rel(file.fileName).startsWith('src/'));
  return yes;
};
const fromThree = (node) => /node_modules[\\/](three|@types[\\/]three)[\\/]/.test(node.getSourceFile().fileName);

const isFunction = (n) => (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)
  || ts.isArrowFunction(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
  || ts.isConstructorDeclaration(n)) && n.body !== undefined;
const skipParens = (n) => { while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression; return n; };
const tagged = (node, tag) => ts.getJSDocTags(node).some((t) => t.tagName.text === tag)
  || (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
    && ts.getJSDocTags(node.parent.parent.parent).some((t) => t.tagName.text === tag);

const symbolOf = (node) => {
  let s = checker.getSymbolAtLocation(node);
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  return s;
};

export { BASELINE, checker, fromThree, inSrc, isFunction, rel, skipParens, sources, started, symbolOf, tagged, typed };
