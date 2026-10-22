import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// Cross-file data-flow review for JavaScript/TypeScript workspaces: tracks
// request-shaped data from sources (req.query/body/params/headers) through
// variable assignments, imported function calls and middleware-style req
// passing into dangerous sinks in other files. This is a bounded syntactic
// approximation over the TypeScript parser — not type checking, not taint
// proof. Every reported flow is a review candidate with its full hop chain;
// absence of flows proves nothing.

export interface FlowHop { file: string; line: number; what: string }
export interface SourceFlow {
  source: FlowHop;
  hops: FlowHop[];
  sink: FlowHop & { kind: "sql_like" | "html_like" | "command_like" };
}
export interface FlowLink { sink: string; route: string; url: string; check: string }
export interface FlowScan {
  filesScanned: number;
  importsResolved: number;
  flows: SourceFlow[];
  sanitized: number;
  guardCuts: number;
  links?: FlowLink[];
  coverage: { bounded: boolean; reason?: string; parseErrors: number; unsupported: number; depthLimit: number };
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "release", "feed", ".next", "coverage", "vendor"]);
const CODE_EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const MAX_FILES = 200;
const MAX_FLOWS = 50;
const MAX_DEPTH = 4;

const SOURCE_PATTERNS = /^(?:req|request|ctx|context)\.(?:query|body|params|headers|cookies)(?:\.|$)|^location\.(?:hash|search|href)$|^new URLSearchParams/;
const SANITIZERS = /^(?:escapehtml|htmlescape|escapeuri|encodeuricomponent|encodeuri|escape|encode|sanitiz\w*|purif\w*|clean\w*|strip\w*|normaliz\w*|parseint|parsefloat|number|boolean|isnumeric|isint|isfinite|valid\w*|escapejavascript)$/;
const SINK_CALLS: Record<string, SourceFlow["sink"]["kind"]> = { query: "sql_like", exec: "command_like", execsync: "command_like", spawn: "command_like", execfilesync: "command_like" };
const SINK_WRITES = new Set(["innerhtml", "outerhtml", "insertadjacenthtml", "document.write"]);

const rel = (root: string, file: string) => path.relative(root, file).replace(/\\/g, "/");
const lineOf = (ast: ts.SourceFile, node: ts.Node) => ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1;

function resolveModule(specifier: string, fromFile: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, ...[".ts", ".tsx", ".js", ".mjs", ".cjs"].map(ext => base + ext), ...["index.ts", "index.js", "index.mjs", "index.cjs"].map(idx => path.join(base, idx))];
  for (const candidate of candidates) try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* try next */ }
  return undefined;
}

interface FileFacts {
  file: string; ast: ts.SourceFile; rel: string;
  imports: Map<string, { file: string; name: string }>; // localName -> resolved export
  exports: Map<string, readonly ts.ParameterDeclaration[]>; // exported name -> function parameters
  crossCalls: Array<{ local: string; argIndex: number; line: number; taintedFrom: string }>;
}

function parametersOf(node: ts.Node, ast: ts.SourceFile): readonly ts.ParameterDeclaration[] | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node.parameters;
  if (ts.isVariableDeclaration(node) && node.initializer) return parametersOf(node.initializer, ast);
  if (ts.isPropertyAssignment(node)) return parametersOf(node.initializer, ast);
  return undefined;
}

function collectFacts(absPath: string, source: string): FileFacts | undefined {
  const ast = ts.createSourceFile(absPath, source, ts.ScriptTarget.Latest, true);
  if ((ast as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics?.length) return undefined;
  const imports = new Map<string, { file: string; name: string }>();
  const exports = new Map<string, readonly ts.ParameterDeclaration[]>();
  const declarations = new Map<string, ts.Node[]>();
  const remember = (name: string, node: ts.Node) => { const list = declarations.get(name) ?? []; list.push(node); declarations.set(name, list); };
  const rememberExport = (name: string, node: ts.Node) => {
    if (exports.has(name)) return;
    const direct = parametersOf(node, ast);
    if (direct) { exports.set(name, direct); return; }
    // Shorthand `module.exports = { fn }` / `export { fn }` reference a local declaration by name.
    if (ts.isShorthandPropertyAssignment(node) || ts.isExportSpecifier(node)) {
      const candidates = declarations.get(name) ?? [];
      for (const candidate of candidates) { const params = parametersOf(candidate, ast); if (params) { exports.set(name, params); return; } }
    }
  };
  const walk = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) remember(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) remember(node.name.text, node);
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const target = resolveModule(node.moduleSpecifier.text, absPath);
      if (target && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          const imported = (element.propertyName ?? element.name).text;
          imports.set(element.name.text, { file: target, name: imported });
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" && node.arguments.length === 1) {
      const specifier = node.arguments[0];
      const target = specifier && ts.isStringLiteral(specifier) ? resolveModule(specifier.text, absPath) : undefined;
      const parent = node.parent;
      if (target && parent && ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
        for (const element of parent.name.elements) {
          const bound = element.name;
          if (!ts.isIdentifier(bound)) continue;
          const property = element.propertyName;
          imports.set(bound.text, { file: target, name: property && ts.isIdentifier(property) ? property.text : bound.text });
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) for (const element of node.exportClause.elements) rememberExport(element.name.text, element);
    if (ts.isFunctionDeclaration(node) && node.name && (node.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) rememberExport(node.name.text, node);
    if (ts.isVariableStatement(node) && (node.modifiers ?? []).some(m => m.kind === ts.SyntaxKind.ExportKeyword)) for (const declaration of node.declarationList.declarations) if (ts.isIdentifier(declaration.name)) rememberExport(declaration.name.text, declaration);
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.expression.left) && ts.isIdentifier(node.expression.left.expression) && node.expression.left.expression.text === "exports" && ts.isIdentifier(node.expression.left.name)) rememberExport(node.expression.left.name.text, node.expression.right);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression) && node.left.expression.text === "module" && ts.isObjectLiteralExpression(node.right)) for (const property of node.right.properties) { const name = property.name; if (name && ts.isIdentifier(name)) rememberExport(name.text, property); }
    ts.forEachChild(node, walk);
  };
  walk(ast);
  return { file: absPath, ast, rel: "", imports, exports, crossCalls: [] };
}

/** Propagates taint syntactically inside one file and records sink flows. */
function propagate(facts: FileFacts, roots: Map<string, FlowHop>): { flows: SourceFlow[]; crossCalls: FileFacts["crossCalls"]; sanitized: number; guardCuts: number } {
  const { ast } = facts;
  const flows: SourceFlow[] = [];
  const crossCalls: FileFacts["crossCalls"] = [];
  let sanitized = 0;
  let guardCuts = 0;
  const tainted = new Map<string, FlowHop>(roots);
  const seenSinks = new Set<string>();
  const identifiersIn = (node: ts.Node): string[] => {
    const found: string[] = [];
    const visit = (child: ts.Node) => { if (ts.isIdentifier(child)) found.push(child.text); ts.forEachChild(child, visit); };
    visit(node);
    return found;
  };
  const taintedIdsIn = (node: ts.Node): FlowHop[] => [...new Set(identifiersIn(node))].flatMap(id => tainted.has(id) ? [tainted.get(id)!] : []);
  // A call whose callee name matches known sanitizer/validator/coercion
  // families is modeled as producing clean output; a reassignment through
  // one untaints the variable.
  const sanitizerOf = (expression: ts.Expression): string | undefined => {
    const callee = ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) ? expression.expression.text.toLowerCase() : undefined;
    return callee && SANITIZERS.test(callee) ? callee : undefined;
  };
  // Control-flow guards: `if (!valid\w*(x) …) return|throw` with an otherwise
  // empty early-exit branch marks x as validated from the guard onward —
  // sinks reached after the guard with that identifier are cut.
  const VALIDATOR_GUARD = /^(?:valid\w*|is\w+|assert\w*|check\w*|ensure\w*|verify\w*|schema\.validate|validate)$/;
  const guards: Array<{ id: string; end: number }> = [];
  const collectGuards = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && node.expression && ts.isPrefixUnaryExpression(node.expression) && node.expression.operator === ts.SyntaxKind.ExclamationToken && ts.isCallExpression(node.expression.operand)) {
      const call = node.expression.operand;
      const callee = ts.isIdentifier(call.expression) ? call.expression.text.toLowerCase() : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text.toLowerCase() : undefined;
      const isEarlyExit = node.thenStatement && (ts.isReturnStatement(node.thenStatement) || ts.isThrowStatement(node.thenStatement) || (ts.isBlock(node.thenStatement) && node.thenStatement.statements.length > 0 && node.thenStatement.statements.every(statement => ts.isReturnStatement(statement) || ts.isThrowStatement(statement))));
      if (callee && VALIDATOR_GUARD.test(callee) && isEarlyExit) {
        const guardedIds = [...new Set(identifiersIn(call))].filter(id => tainted.has(id) || SOURCE_PATTERNS_SOURCE(id));
        for (const id of guardedIds) guards.push({ id, end: node.thenStatement.end });
      }
    }
    ts.forEachChild(node, collectGuards);
  };
  const SOURCE_PATTERNS_SOURCE = (id: string): boolean => /^(?:req|request|ctx|context)$/.test(id);
  const guardedBefore = (id: string, position: number): boolean => guards.some(guard => guard.id === id && guard.end <= position);
  const passes = 4;
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    guards.length = 0;
    collectGuards(ast);
    // Carriers still active at a position: guard-cut identifiers drop out.
    const activeCarriersAt = (node: ts.Node): FlowHop[] => {
      const position = node.getEnd();
      const carriers = taintedIdsIn(node);
      const active = carriers.filter(hop => {
        const id = [...tainted.entries()].filter(([, hop2]) => hop2 === hop).map(([id]) => id)[0];
        return id === undefined || !guardedBefore(id, position);
      });
      if (carriers.length > active.length) guardCuts += carriers.length - active.length;
      return active;
    };
    const walk = (node: ts.Node) => {
      // Roots: request-shaped expressions bind their variable — unless the
      // value flows through a modeled sanitizer, which produces clean output.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && !tainted.has(node.name.text)) {
        const text = node.initializer.getText(ast).replace(/^\s*|\s*$/g, "");
        if (SOURCE_PATTERNS.test(text)) { tainted.set(node.name.text, { file: facts.rel, line: lineOf(ast, node.initializer), what: text.slice(0, 80) }); changed = true; }
        else if (sanitizerOf(node.initializer)) { if (taintedIdsIn(node.initializer).length) sanitized++; }
        else if (ts.isCallExpression(node.initializer) && taintedIdsIn(node.initializer).length) { tainted.set(node.name.text, { file: facts.rel, line: lineOf(ast, node.initializer), what: "derived from " + [...new Set(identifiersIn(node.initializer))].filter(id => tainted.has(id)).join(", ") }); changed = true; }
        else if (taintedIdsIn(node.initializer).length) { tainted.set(node.name.text, taintedIdsIn(node.initializer)[0]!); changed = true; }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && node.right) {
        if (sanitizerOf(node.right)) { if (taintedIdsIn(node.right).length || tainted.has(node.left.text)) sanitized++; if (tainted.delete(node.left.text)) changed = true; }
        else if (taintedIdsIn(node.right).length && !tainted.has(node.left.text)) { tainted.set(node.left.text, taintedIdsIn(node.right)[0]!); changed = true; }
      }
      // Cross-file call: tainted argument into an imported function —
      // guard-cut identifiers stop here too, so they never seed the target.
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && facts.imports.has(node.expression.text)) {
        const callee = node.expression.text;
        node.arguments.forEach((argument, argIndex) => {
          const carriers = activeCarriersAt(argument);
          if (carriers.length) crossCalls.push({ local: callee, argIndex, line: lineOf(ast, node), taintedFrom: carriers[0]!.file + ":" + carriers[0]!.line });
        });
      }
      // Sinks: calls with tainted arguments and dangerous property writes;
      // guard-cut identifiers no longer reach the sink.
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text.toLowerCase();
        const kind = SINK_CALLS[method];
        if (kind && activeCarriersAt(node).length && flows.length < MAX_FLOWS) {
          const dedupe = facts.rel + ":" + lineOf(ast, node) + ":" + kind;
          if (!seenSinks.has(dedupe)) {
            seenSinks.add(dedupe);
            const carriers = activeCarriersAt(node);
            flows.push({ source: roots.size ? [...roots.values()][0]! : carriers[0]!, hops: [...new Set(carriers)], sink: { file: facts.rel, line: lineOf(ast, node), what: node.expression.getText(ast).slice(0, 80), kind } });
          }
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
        const name = ts.isPropertyAccessExpression(node.left) ? node.left.name.text : ts.isStringLiteral(node.left.argumentExpression) ? node.left.argumentExpression.text : "";
        if (SINK_WRITES.has(name.toLowerCase()) && activeCarriersAt(node.right).length && flows.length < MAX_FLOWS) {
          const dedupe = facts.rel + ":" + lineOf(ast, node) + ":html";
          if (!seenSinks.has(dedupe)) {
            seenSinks.add(dedupe);
            const carriers = activeCarriersAt(node.right);
            flows.push({ source: roots.size ? [...roots.values()][0]! : carriers[0]!, hops: [...new Set(carriers)], sink: { file: facts.rel, line: lineOf(ast, node), what: name + " =", kind: "html_like" } });
          }
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
    if (!changed) break;
  }
  return { flows, crossCalls, sanitized, guardCuts: Math.min(guardCuts, 1000) };
}

/**
 * Links static flows to dynamic evidence: a flow whose source file also
 * declares a route is joined with any dynamic finding proven on that same
 * route path — the static hop chain and the live proof describe the same
 * attack surface from both directions.
 */
export function linkFlowsToDynamicEvidence(flows: SourceFlow[], routes: Array<{ path: string; file: string }>, dynamic: Array<{ check: string; target: string }>): FlowLink[] {
  const links: FlowLink[] = [];
  const seen = new Set<string>();
  for (const flow of flows) {
    const sink = flow.sink.file + ":" + flow.sink.line;
    const fileRoutes = routes.filter(route => route.file === flow.source.file);
    if (!fileRoutes.length) continue;
    for (const finding of dynamic) {
      let pathname = "";
      try { pathname = new URL(finding.target).pathname; } catch { continue; }
      const route = fileRoutes.find(candidate => candidate.path === pathname);
      if (!route) continue;
      const key = sink + "|" + finding.check + "|" + finding.target;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ sink, route: route.path, url: finding.target, check: finding.check });
    }
  }
  return links;
}

export function traceSourceFlows(rootDir: string): FlowScan {
  const files: string[] = [];
  const coverage: FlowScan["coverage"] = { bounded: false, parseErrors: 0, unsupported: 0, depthLimit: 0 };
  const walk = (dir: string) => {
    if (files.length >= MAX_FILES) { coverage.bounded = true; coverage.reason = `stopped at the ${MAX_FILES}-file scan limit`; return; }
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { coverage.unsupported++; return; }
    for (const entry of entries) {
      if (coverage.bounded) return;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(path.join(dir, entry.name)); continue; }
      if (!CODE_EXTS.has(path.extname(entry.name).toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (files.length >= MAX_FILES) { coverage.bounded = true; coverage.reason = `stopped at the ${MAX_FILES}-file scan limit`; return; }
      files.push(full);
    }
  };
  walk(rootDir);
  const factsByFile = new Map<string, FileFacts>();
  let importsResolved = 0;
  for (const file of files) {
    let text = "";
    try {
      const st = fs.statSync(file);
      if (st.size > 300_000) { coverage.unsupported++; continue; }
      const bytes = fs.readFileSync(file); text = bytes.toString("utf8");
      if (!bytes.equals(Buffer.from(text, "utf8"))) { coverage.unsupported++; continue; }
    } catch { coverage.unsupported++; continue; }
    const facts = collectFacts(file, text);
    if (!facts) { coverage.parseErrors++; continue; }
    facts.rel = rel(rootDir, file);
    factsByFile.set(file, facts);
    importsResolved += facts.imports.size;
  }
  const allFlows: SourceFlow[] = [];
  const flowsBySink = new Map<string, SourceFlow>();
  // Worklist: start from every file that binds request-shaped roots, then
  // follow tainted arguments into imported functions up to MAX_DEPTH hops.
  type Item = { facts: FileFacts; roots: Map<string, FlowHop>; hops: FlowHop[]; origin?: FlowHop; depth: number };
  const queue: Item[] = [];
  for (const facts of factsByFile.values()) {
    const roots = new Map<string, FlowHop>();
    const walkDecl = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name) && SOURCE_PATTERNS.test(node.initializer.getText(facts.ast).trim())) roots.set(node.name.text, { file: facts.rel, line: lineOf(facts.ast, node.initializer), what: node.initializer.getText(facts.ast).trim().slice(0, 80) });
      // Route/middleware handlers: the whole request object is tainted.
      if ((ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && node.parameters.length) {
        const first = node.parameters[0]!;
        const name = ts.isIdentifier(first.name) ? first.name.text : ts.isObjectBindingPattern(first.name) ? "" : "";
        const bodyText = node.body ? node.body.getText(facts.ast) : "";
        if (name && /\b(?:req|request|ctx)\b/.test(name) === false && /\b(?:req|request|ctx)\.(?:query|body|params|headers)/.test(bodyText) === false) { ts.forEachChild(node, walkDecl); return; }
        if (name && /\b(?:req|request|ctx)\b/.test(name)) roots.set(name, { file: facts.rel, line: lineOf(facts.ast, first), what: name + " (request/middleware parameter)" });
      }
      ts.forEachChild(node, walkDecl);
    };
    walkDecl(facts.ast);
    if (roots.size) queue.push({ facts, roots, hops: [], origin: [...roots.values()][0], depth: 0 });
  }
  let sanitizedTotal = 0, guardCutTotal = 0;
  const visited = new Set<string>();
  while (queue.length && allFlows.length < MAX_FLOWS) {
    const item = queue.shift()!;
    const { flows, crossCalls, sanitized, guardCuts } = propagate(item.facts, item.roots);
    sanitizedTotal += sanitized; guardCutTotal += guardCuts;
    for (const flow of flows) {
      // The reported source is the original request-shaped entry, not the
      // intermediate parameter the worklist entered this file through.
      const effectiveSource = item.origin ?? flow.source;
      const candidate: SourceFlow = { source: effectiveSource, hops: [...item.hops, ...flow.hops.map(hop => ({ ...hop, what: hop.what + " (tainted)" }))], sink: flow.sink };
      const key = flow.sink.file + ":" + flow.sink.line + ":" + flow.sink.kind;
      const existing = flowsBySink.get(key);
      // Keep the longest chain per sink: the cross-file provenance wins over
      // the same file's locally-seeded short flow.
      if (!existing || candidate.hops.length > existing.hops.length) {
        if (existing) allFlows.splice(allFlows.indexOf(existing), 1);
        flowsBySink.set(key, candidate);
        allFlows.push(candidate);
        if (allFlows.length >= MAX_FLOWS) { coverage.bounded = true; coverage.reason = "stopped at the 50-flow reporting limit"; break; }
      }
    }
    if (item.depth >= MAX_DEPTH - 1) { if (crossCalls.length) coverage.depthLimit++; continue; }
    for (const call of crossCalls) {
      const resolved = item.facts.imports.get(call.local);
      if (!resolved) continue;
      const target = factsByFile.get(resolved.file);
      const parameters = target?.exports.get(resolved.name);
      if (!target || !parameters) continue;
      const key = resolved.file + "#" + resolved.name + "#" + call.argIndex + "#" + call.taintedFrom;
      if (visited.has(key)) continue;
      visited.add(key);
      const parameter = parameters[call.argIndex];
      if (!parameter || !ts.isIdentifier(parameter.name)) continue;
      const hop: FlowHop = { file: target.rel, line: lineOf(target.ast, parameter), what: resolved.name + "(arg " + call.argIndex + ") ← " + call.taintedFrom };
      const roots = new Map<string, FlowHop>([[parameter.name.text, hop]]);
      queue.push({ facts: target, roots, hops: [...item.hops, hop], origin: item.origin ?? [...item.roots.values()][0], depth: item.depth + 1 });
    }
  }
  return { filesScanned: factsByFile.size, importsResolved, flows: allFlows, sanitized: sanitizedTotal, guardCuts: guardCutTotal, coverage };
}
