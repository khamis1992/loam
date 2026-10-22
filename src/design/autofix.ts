/**
 * design_autofix — deterministic repair of generated web UI code.
 *
 * v0 keeps its output error-free with a fast deterministic pass after the
 * stream: missing imports, missing `package.json` dependencies, missing
 * providers and token violations are fixed before the build loop runs. This
 * module is Loam's equivalent. It is pure and synchronous: it takes a map of
 * relative file paths to contents and returns the repaired map plus a
 * machine-readable report, so it can be unit-tested without touching disk and
 * applied by the `design_autofix` tool against a real task workspace.
 *
 * Everything here is deterministic and offline. It never runs a model, never
 * performs network I/O and never invents a dependency version outside the
 * curated allowlist below.
 */

export type DesignFileMap = Record<string, string>;

export type AutofixKind =
  | "missing_import"
  | "missing_dependency"
  | "missing_provider"
  | "token_replacement";

export interface AutofixFix {
  kind: AutofixKind;
  file: string;
  detail: string;
}

export interface AutofixReport {
  ok: boolean;
  changed: string[];
  fixes: AutofixFix[];
  counts: Record<AutofixKind, number>;
}

export interface AutofixResult {
  files: DesignFileMap;
  report: AutofixReport;
}

export interface AutofixOptions {
  /** Import aliases used to resolve local components (default `@/` -> `src/`). */
  aliases?: Record<string, string>;
  /** Extra dependency versions to allow beyond the built-in catalog. */
  dependencyVersions?: Record<string, string>;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".jsx", ".js"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".git", ".loam"]);

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isSourceFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [...SOURCE_EXTENSIONS].some((ext) => lower.endsWith(ext));
}

function isSkippedPath(filePath: string): boolean {
  return filePath.split("/").some((segment) => SKIP_DIRS.has(segment));
}

function defaultAliases(options: AutofixOptions): Record<string, string> {
  return { "@/": "src/", ...(options.aliases ?? {}) };
}

function resolveAlias(specifier: string, aliases: Record<string, string>): string | null {
  for (const [prefix, target] of Object.entries(aliases)) {
    if (specifier === prefix.slice(0, -1)) return normalizePath(target);
    if (specifier.startsWith(prefix)) return normalizePath(target + specifier.slice(prefix.length));
  }
  return null;
}

/** Curated dependency versions. Only packages listed here may be auto-added. */
const DEPENDENCY_VERSIONS: Record<string, string> = {
  react: "^18.3.1",
  "react-dom": "^18.3.1",
  "lucide-react": "^0.469.0",
  clsx: "^2.1.1",
  "tailwind-merge": "^2.6.0",
  "class-variance-authority": "^0.7.1",
  recharts: "^2.15.0",
  "next-themes": "^0.4.4",
  sonner: "^1.7.1",
  "@tanstack/react-query": "^5.62.0",
  "@radix-ui/react-tooltip": "^1.1.6",
  "@radix-ui/react-slot": "^1.1.1",
  "@radix-ui/react-dialog": "^1.1.4",
  "@radix-ui/react-dropdown-menu": "^2.1.5",
};

/** shadcn/ui (new-york) components that are commonly dropped from imports. */
const KNOWN_COMPONENTS: Record<string, string> = {
  Button: "@/components/ui/button",
  Input: "@/components/ui/input",
  Card: "@/components/ui/card",
  Dialog: "@/components/ui/dialog",
  DialogTrigger: "@/components/ui/dialog",
  DialogContent: "@/components/ui/dialog",
  DropdownMenu: "@/components/ui/dropdown-menu",
  DropdownMenuTrigger: "@/components/ui/dropdown-menu",
  DropdownMenuContent: "@/components/ui/dropdown-menu",
  Label: "@/components/ui/label",
  Select: "@/components/ui/select",
  SelectTrigger: "@/components/ui/select",
  SelectContent: "@/components/ui/select",
  SelectItem: "@/components/ui/select",
  Table: "@/components/ui/table",
  TableHeader: "@/components/ui/table",
  TableBody: "@/components/ui/table",
  TableRow: "@/components/ui/table",
  TableCell: "@/components/ui/table",
  Badge: "@/components/ui/badge",
  Separator: "@/components/ui/separator",
  Skeleton: "@/components/ui/skeleton",
  Textarea: "@/components/ui/textarea",
  Switch: "@/components/ui/switch",
  Avatar: "@/components/ui/avatar",
  AvatarImage: "@/components/ui/avatar",
  AvatarFallback: "@/components/ui/avatar",
  Alert: "@/components/ui/alert",
  AlertTitle: "@/components/ui/alert",
  AlertDescription: "@/components/ui/alert",
};

/** Lucide icon names used by the generated UI. */
const KNOWN_ICONS = new Set([
  "Search",
  "Menu",
  "ArrowRight",
  "ArrowLeft",
  "ChevronDown",
  "ChevronRight",
  "Check",
  "X",
  "Plus",
  "Trash",
  "Pencil",
  "Settings",
  "User",
  "Users",
  "Home",
  "Star",
  "Heart",
  "Bell",
  "Calendar",
  "Download",
  "Upload",
  "Filter",
  "Loader2",
  "LoaderCircle",
  "CircleAlert",
  "Info",
  "Sparkles",
]);

const REACT_BUILTINS = new Set(["Fragment", "Suspense", "StrictMode", "Profiler", "memo", "forwardRef"]);

const RAW_COLOR_CLASS_MAP: Record<string, string> = {
  "bg-white": "bg-background",
  "bg-black": "bg-foreground",
  "text-white": "text-foreground",
  "text-black": "text-foreground",
  "border-white": "border-border",
  "border-black": "border-border",
  "divide-white": "divide-border",
  "divide-black": "divide-border",
  "ring-white": "ring-ring",
  "ring-black": "ring-ring",
  "bg-gray-50": "bg-muted",
  "bg-gray-100": "bg-muted",
  "bg-gray-200": "bg-muted",
  "bg-gray-800": "bg-card",
  "bg-gray-900": "bg-background",
  "bg-gray-950": "bg-background",
  "text-gray-400": "text-muted-foreground",
  "text-gray-500": "text-muted-foreground",
  "text-gray-600": "text-muted-foreground",
  "text-gray-900": "text-foreground",
  "border-gray-200": "border-border",
  "border-gray-300": "border-border",
  "border-gray-800": "border-border",
  "placeholder-gray-400": "placeholder-muted-foreground",
};

const RAW_HEX_ARBITRARY_MAP: Record<string, string> = {
  "bg-[#ffffff]": "bg-background",
  "bg-[#fff]": "bg-background",
  "bg-[#000000]": "bg-foreground",
  "bg-[#000]": "bg-foreground",
  "text-[#ffffff]": "text-foreground",
  "text-[#fff]": "text-foreground",
  "text-[#000000]": "text-foreground",
  "text-[#000]": "text-foreground",
  "border-[#ffffff]": "border-border",
  "border-[#fff]": "border-border",
  "border-[#000000]": "border-border",
  "border-[#000]": "border-border",
};

const FONT_SCALE_PX: ReadonlyArray<readonly [number, string]> = [
  [12, "xs"],
  [14, "sm"],
  [16, "base"],
  [18, "lg"],
  [20, "xl"],
  [24, "2xl"],
  [30, "3xl"],
  [36, "4xl"],
  [48, "5xl"],
  [60, "6xl"],
  [72, "7xl"],
  [96, "8xl"],
  [128, "9xl"],
];

const SPACING_PREFIXES = [
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "m",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "gap",
  "gap-x",
  "gap-y",
  "space-x",
  "space-y",
  "w",
  "h",
  "size",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "inset-x",
  "inset-y",
];

function nearestFontSizeClass(px: number): string {
  let best = FONT_SCALE_PX[0]!;
  for (const entry of FONT_SCALE_PX) {
    if (Math.abs(entry[0] - px) < Math.abs(best[0] - px)) best = entry;
  }
  return best[1]!;
}

function nearestSpacingClass(px: number): string {
  const steps = Math.round(px / 4);
  return String(Math.max(0, steps));
}

function replaceClassTokens(source: string): { source: string; replacements: string[] } {
  const replacements: string[] = [];
  let result = source;
  const applyMap = (map: Record<string, string>, label: string): void => {
    for (const [raw, token] of Object.entries(map)) {
      const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp("(^|[\\s\"'`])" + escaped + "(?=[\\s\"'`]|$)", "g");
      result = result.replace(pattern, (match, lead) => {
        replacements.push(`${label}: ${raw} -> ${token}`);
        return `${lead}${token}`;
      });
    }
  };
  applyMap(RAW_COLOR_CLASS_MAP, "raw-colour");
  applyMap(RAW_HEX_ARBITRARY_MAP, "raw-colour");
  result = result.replace(
    /\b(text)-\[(\d+(?:\.\d+)?)px\]/g,
    (_match, prefix: string, pxText: string) => {
      const px = Number(pxText);
      const token = nearestFontSizeClass(px);
      replacements.push(`font-size: ${prefix}-[${pxText}px] -> ${prefix}-${token}`);
      return `${prefix}-${token}`;
    },
  );
  for (const prefix of SPACING_PREFIXES) {
    const escaped = prefix.replace(/[-]/g, "\\-");
    const pattern = new RegExp(`\\b(${escaped})-\\[(\\d+(?:\\.\\d+)?)px\\]`, "g");
    result = result.replace(pattern, (match, matchedPrefix: string, pxText: string) => {
      const px = Number(pxText);
      const token = nearestSpacingClass(px);
      replacements.push(`spacing: ${matchedPrefix}-[${pxText}px] -> ${matchedPrefix}-${token}`);
      return `${matchedPrefix}-${token}`;
    });
  }
  return { source: result, replacements };
}

interface ParsedImports {
  /** Names brought into scope by import statements. */
  names: Set<string>;
  /** Every bare/alias specifier imported anywhere in the file. */
  specifiers: string[];
  /** Index just past the last import statement (insertion point). */
  lastImportEnd: number;
  /** True when the file starts with a "use client"/"use server" directive. */
  directiveEnd: number;
}

const IMPORT_LINE = /(^|\n)\s*(?:import\s+(?:type\s+)?[\s\S]*?from\s+["'][^"']+["']|import\s+["'][^"']+["']|export\s+(?:type\s+)?\{\s*\}\s*from\s+["'][^"']+["'])\s*;?/g;

function parseImports(source: string): ParsedImports {
  const names = new Set<string>();
  const specifiers: string[] = [];
  let lastImportEnd = 0;
  let directiveEnd = 0;
  const directiveMatch = /^(?:["']use (?:client|server)["'];?\s*)/.exec(source);
  if (directiveMatch) directiveEnd = directiveMatch[0].length;
  let match: RegExpExecArray | null;
  IMPORT_LINE.lastIndex = directiveEnd;
  while ((match = IMPORT_LINE.exec(source)) !== null) {
    const statement = match[0].replace(/^\n/, "");
    lastImportEnd = match.index + match[0].length;
    const fromMatch = /from\s+["']([^"']+)["']/.exec(statement);
    const sideEffect = /^import\s+["'][^"']+["']/.test(statement.trim());
    if (fromMatch) {
      specifiers.push(fromMatch[1]!);
      const clause = statement.slice(0, fromMatch.index);
      const braceMatch = /\{([\s\S]*)\}/.exec(clause);
      if (braceMatch) {
        for (const part of braceMatch[1]!.split(",")) {
          const token = part.trim();
          if (!token) continue;
          const asMatch = /\sas\s+([A-Za-z0-9_]+)$/.exec(token);
          const name = asMatch ? asMatch[1]! : token.replace(/^type\s+/, "").trim();
          if (/^[A-Za-z0-9_]+$/.test(name)) names.add(name);
        }
      }
      const defaultMatch = /import\s+([A-Za-z0-9_]+)\s*(?:,|\{)?\s*from\s+["']/.exec(statement);
      if (defaultMatch) names.add(defaultMatch[1]!);
      const typeDefaultMatch = /import\s+type\s+([A-Za-z0-9_]+)\s*(?:,|\{)?\s*from\s+["']/.exec(statement);
      if (typeDefaultMatch) names.add(typeDefaultMatch[1]!);
      const namespaceMatch = /\*\s+as\s+([A-Za-z0-9_]+)/.exec(clause);
      if (namespaceMatch) names.add(namespaceMatch[1]!);
    } else if (sideEffect) {
      const spec = /^import\s+["']([^"']+)["']/.exec(statement.trim());
      if (spec) specifiers.push(spec[1]!);
    }
  }
  return { names, specifiers, lastImportEnd, directiveEnd };
}

function collectDeclaredNames(source: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /\b(?:function|class|interface|enum)\s+([A-Za-z0-9_]+)/g,
    /\b(?:const|let|var)\s+([A-Za-z0-9_]+)/g,
    /\btype\s+([A-Za-z0-9_]+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) names.add(match[1]!);
  }
  return names;
}

function findUsedJsxNames(source: string): Set<string> {
  const names = new Set<string>();
  const pattern = /<\s*([A-Z][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) names.add(match[1]!);
  return names;
}

/** Names a local file exports (named, aliased and default exports). */
function collectExports(source: string): Set<string> {
  const names = new Set<string>();
  const patterns: RegExp[] = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/g,
    /\bexport\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z0-9_]+)/g,
    /\bexport\s+default\s+(?:function\s+|class\s+)?([A-Za-z0-9_]+)/g,
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) names.add(match[1]!);
  }
  const brace = /\bexport\s*\{([\s\S]*?)\}/g;
  let match: RegExpExecArray | null;
  while ((match = brace.exec(source)) !== null) {
    for (const part of match[1]!.split(",")) {
      const token = part.trim();
      if (!token) continue;
      const asMatch = /\sas\s+([A-Za-z0-9_]+)$/.exec(token);
      const name = asMatch ? asMatch[1]! : token.replace(/^type\s+/, "").trim();
      if (/^[A-Za-z0-9_]+$/.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Map every exported name in the project to the alias specifier that provides
 * it. A file may export several components from one module (for example
 * `tooltip.tsx` exports Tooltip, TooltipTrigger, TooltipContent and
 * TooltipProvider), so name-based resolution alone is not enough.
 */
function buildExportIndex(files: DesignFileMap, aliases: Record<string, string>): Map<string, string> {
  const baseDir = aliases["@/"] ?? "src/";
  const aliasPrefix = baseDir === "src/" ? "@/" : baseDir;
  const entries: Array<{ name: string; specifier: string; priority: number }> = [];
  for (const file of Object.keys(files)) {
    if (!isSourceFile(file) || !file.startsWith(baseDir)) continue;
    if (file.endsWith(".d.ts")) continue;
    const specifier = aliasPrefix + file.slice(baseDir.length).replace(/\.(tsx?|jsx?)$/, "");
    const priority = file.includes(`${baseDir}components/ui/`)
      ? 0
      : file.includes(`${baseDir}components/`)
        ? 1
        : 2;
    for (const name of collectExports(files[file]!)) {
      entries.push({ name, specifier, priority });
    }
  }
  entries.sort((a, b) => a.priority - b.priority || a.specifier.localeCompare(b.specifier));
  const index = new Map<string, string>();
  for (const entry of entries) if (!index.has(entry.name)) index.set(entry.name, entry.specifier);
  return index;
}

function resolveComponentTarget(
  name: string,
  aliases: Record<string, string>,
  exportIndex: Map<string, string>,
): string | null {
  const local = exportIndex.get(name);
  if (local) return local;
  if (KNOWN_COMPONENTS[name]) return KNOWN_COMPONENTS[name]!;
  if (KNOWN_ICONS.has(name)) return "lucide-react";
  if (REACT_BUILTINS.has(name)) return "react";
  return null;
}

function buildImportLines(bySpecifier: Map<string, Set<string>>): string[] {
  return [...bySpecifier.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([specifier, names]) => `import { ${[...names].sort().join(", ")} } from "${specifier}";`);
}

function insertImports(source: string, imports: string[], parsed: ParsedImports): string {
  if (imports.length === 0) return source;
  const insertAt = Math.max(parsed.lastImportEnd, parsed.directiveEnd);
  const prefix = source.slice(0, insertAt);
  const suffix = source.slice(insertAt);
  const needsLeadingNewline = prefix.length > 0 && !prefix.endsWith("\n");
  const block = `${imports.join("\n")}\n`;
  return `${prefix}${needsLeadingNewline ? "\n" : ""}${block}${suffix}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add a single named import, merging into an existing import from the same
 * module when one is present so the file never ends up with two `import ...`
 * statements for the same specifier.
 */
function addImport(source: string, name: string, specifier: string): { source: string; added: boolean } {
  const parsed = parseImports(source);
  if (parsed.names.has(name)) return { source, added: false };
  const existing = new RegExp(
    `import\\s+(?:type\\s+)?\\{([\\s\\S]*?)\\}\\s*from\\s+["']${escapeRegex(specifier)}["']`,
  ).exec(source);
  if (existing) {
    const names = existing[1]!
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (names.includes(name)) return { source, added: false };
    names.push(name);
    names.sort();
    const replacement = `import { ${names.join(", ")} } from "${specifier}"`;
    return { source: source.slice(0, existing.index) + replacement + source.slice(existing.index + existing[0].length), added: true };
  }
  const line = `import { ${name} } from "${specifier}";`;
  return { source: insertImports(source, [line], parsed), added: true };
}

interface ProviderRule {
  triggers: string[];
  provider: string;
  specifier: string;
}

const PROVIDER_RULES: readonly ProviderRule[] = [
  {
    triggers: ["Tooltip", "TooltipTrigger", "TooltipContent"],
    provider: "TooltipProvider",
    specifier: "@/components/ui/tooltip",
  },
];

function findMatchingParen(source: string, openIndex: number): number {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const char = source[i]!;
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i += 1;
      }
    } else if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function findRootReturnOpen(source: string): number {
  const componentPattern = /(?:export\s+default\s+function|export\s+function|function)\s+[A-Za-z0-9_]+\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{/g;
  let match: RegExpExecArray | null;
  let best = -1;
  while ((match = componentPattern.exec(source)) !== null) {
    const bodyStart = match.index + match[0].length - 1;
    const returnPattern = /\breturn\s*\(/g;
    returnPattern.lastIndex = bodyStart;
    const returnMatch = returnPattern.exec(source);
    if (returnMatch) {
      const openIndex = source.indexOf("(", returnMatch.index + "return".length);
      if (openIndex > bodyStart && openIndex < source.length) best = openIndex;
    }
  }
  return best;
}

function reindentBlock(block: string, minIndent: number, targetIndent: number): string {
  const delta = targetIndent - minIndent;
  return block
    .split("\n")
    .map((line) => {
      if (line.trim().length === 0) return "";
      const original = line.match(/^[ \t]*/)![0].length;
      return " ".repeat(Math.max(0, original + delta)) + line.trimStart();
    })
    .join("\n");
}

function wrapReturnInProvider(source: string, provider: string): { source: string; wrapped: boolean } {
  const openIndex = findRootReturnOpen(source);
  if (openIndex < 0) return { source, wrapped: false };
  const closeIndex = findMatchingParen(source, openIndex);
  if (closeIndex < 0) return { source, wrapped: false };
  const inner = source.slice(openIndex + 1, closeIndex).replace(/^\n/, "").replace(/\n[ \t]*$/, "");
  const nonEmpty = inner.split("\n").filter((line) => line.trim().length > 0);
  const baseIndent = nonEmpty.length > 0
    ? Math.min(...nonEmpty.map((line) => line.match(/^[ \t]*/)![0].length))
    : 2;
  const pad = " ".repeat(baseIndent);
  const closePad = " ".repeat(Math.max(0, baseIndent - 2));
  const body = reindentBlock(inner, baseIndent, baseIndent + 2);
  const replacement = `(\n${pad}<${provider}>\n${body}\n${pad}</${provider}>\n${closePad})`;
  return { source: `${source.slice(0, openIndex)}${replacement}${source.slice(closeIndex + 1)}`, wrapped: true };
}

function emptyReport(): AutofixReport {
  return {
    ok: true,
    changed: [],
    fixes: [],
    counts: { missing_import: 0, missing_dependency: 0, missing_provider: 0, token_replacement: 0 },
  };
}

function packagePackageName(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  const resolved = specifier.startsWith("@/") ? null : specifier;
  if (!resolved) return null;
  if (resolved.startsWith("@")) {
    const parts = resolved.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  const parts = resolved.split("/");
  return parts[0] ?? null;
}

function applyDependencyFixes(
  files: DesignFileMap,
  sourceFiles: string[],
  versions: Record<string, string>,
  report: AutofixReport,
): void {
  const pkgPath = Object.keys(files).find((p) => p.replace(/\\/g, "/").endsWith("package.json"));
  if (!pkgPath) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(files[pkgPath]!) as Record<string, unknown>;
  } catch {
    return;
  }
  const deps = new Set(Object.keys((pkg.dependencies as Record<string, unknown> | undefined) ?? {}));
  const devDeps = new Set(Object.keys((pkg.devDependencies as Record<string, unknown> | undefined) ?? {}));
  const present = new Set([...deps, ...devDeps]);
  const needed = new Map<string, string>();
  for (const file of sourceFiles) {
    const parsed = parseImports(files[file]!);
    for (const specifier of parsed.specifiers) {
      const name = packagePackageName(specifier);
      if (!name || present.has(name)) continue;
      const version = versions[name];
      if (version) needed.set(name, version);
    }
  }
  if (needed.size === 0) return;
  const nextDeps = { ...(pkg.dependencies as Record<string, unknown> | undefined) };
  for (const [name, version] of [...needed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    nextDeps[name] = version;
    report.counts.missing_dependency += 1;
    report.fixes.push({ kind: "missing_dependency", file: pkgPath, detail: `added ${name}@${version}` });
  }
  pkg.dependencies = nextDeps;
  files[pkgPath] = `${JSON.stringify(pkg, null, 2)}\n`;
  report.changed.push(pkgPath);
}

export function autofixProject(input: DesignFileMap, options: AutofixOptions = {}): AutofixResult {
  const report = emptyReport();
  const files: DesignFileMap = {};
  for (const [rawPath, content] of Object.entries(input)) {
    const normalized = normalizePath(rawPath);
    if (isSkippedPath(normalized)) continue;
    files[normalized] = content;
  }
  const aliases = defaultAliases(options);
  const versions = { ...DEPENDENCY_VERSIONS, ...(options.dependencyVersions ?? {}) };
  const sourceFiles = Object.keys(files).filter(isSourceFile).sort();
  const exportIndex = buildExportIndex(files, aliases);

  // 1. Missing imports.
  for (const file of sourceFiles) {
    let source = files[file]!;
    const parsed = parseImports(source);
    const declared = collectDeclaredNames(source);
    const available = new Set([...parsed.names, ...declared]);
    const used = findUsedJsxNames(source);
    const missing = new Map<string, Set<string>>();
    for (const name of used) {
      if (available.has(name)) continue;
      const target = resolveComponentTarget(name, aliases, exportIndex);
      if (!target) continue;
      const set = missing.get(target) ?? new Set<string>();
      set.add(name);
      missing.set(target, set);
    }
    if (missing.size > 0) {
      const lines = buildImportLines(missing);
      source = insertImports(source, lines, parsed);
      for (const [specifier, names] of missing) {
        for (const name of names) {
          report.counts.missing_import += 1;
          report.fixes.push({ kind: "missing_import", file, detail: `${name} from "${specifier}"` });
        }
      }
      files[file] = source;
      report.changed.push(file);
    }
  }

  // 2. Missing package.json dependencies (scan the post-import source).
  applyDependencyFixes(files, sourceFiles, versions, report);

  // 3. Missing providers.
  for (const file of sourceFiles) {
    let source = files[file]!;
    const available = new Set([...parseImports(source).names, ...collectDeclaredNames(source)]);
    for (const rule of PROVIDER_RULES) {
      const triggers = rule.triggers.filter((name) => source.includes(`<${name}`) || new RegExp(`\\b${name}\\b`).test(source));
      if (triggers.length === 0) continue;
      if (source.includes(`<${rule.provider}`) || available.has(rule.provider)) continue;
      const added = addImport(source, rule.provider, rule.specifier);
      if (!added.added) continue;
      const wrapped = wrapReturnInProvider(added.source, rule.provider);
      if (wrapped.wrapped) {
        source = wrapped.source;
        report.counts.missing_provider += 1;
        report.fixes.push({
          kind: "missing_provider",
          file,
          detail: `wrapped root in ${rule.provider} (triggers: ${triggers.join(", ")})`,
        });
        files[file] = source;
        report.changed.push(file);
      }
    }
  }

  // 4. Token replacement.
  for (const file of sourceFiles) {
    const original = files[file]!;
    const { source, replacements } = replaceClassTokens(original);
    if (replacements.length > 0) {
      files[file] = source;
      report.changed.push(file);
      report.counts.token_replacement += replacements.length;
      for (const detail of replacements) {
        report.fixes.push({ kind: "token_replacement", file, detail });
      }
    }
  }

  report.changed = [...new Set(report.changed)].sort();
  return { files, report };
}

export const DESIGN_AUTOFIX_TOOL_NAME = "design_autofix";
export const DESIGN_AUTOFIX_TOOL_NAMES = [DESIGN_AUTOFIX_TOOL_NAME];
