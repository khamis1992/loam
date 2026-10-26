#!/usr/bin/env python3
"""Apply the Loam legal-mode integration to a Loam checkout at 5227df4.

Usage: python3 apply-integration.py <scratch-dir> <loam-checkout>

Copies the new files and performs anchored edits on existing files. Every
anchor must match exactly once; otherwise the script stops without writing
that file (re-run after fixing). Idempotent: an edit whose first added line is
already present is skipped.
"""
import pathlib, shutil, sys

SRC = pathlib.Path(sys.argv[1]).resolve()
DST = pathlib.Path(sys.argv[2]).resolve()

COPY = [
    "src/legal", "src/tools/legalTools.ts", "src/tools/__tests__/legalTools.test.ts",
    "src/server/routes/legal.ts", "src/server/routes/__tests__/legal.test.ts",
    "src/scripts/legal-mock-server.ts", "electron/legal-key.cjs",
    "skills/qatar-legal-research", "skills/qatar-defense-memo", "skills/qatar-contract-review",
]
WEB_COPY = [  # scratch web/ -> packages/web/
    "src/services/legalApi.ts", "src/components/legal",
]

def copy(rel_src: pathlib.Path, rel_dst: pathlib.Path) -> None:
    s, d = SRC / rel_src, DST / rel_dst
    if s.is_dir():
        shutil.copytree(s, d, dirs_exist_ok=True)
    else:
        d.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(s, d)

for rel in COPY:
    copy(pathlib.Path(rel), pathlib.Path(rel))
for rel in WEB_COPY:
    copy(pathlib.Path("web") / rel, pathlib.Path("packages/web") / rel)

EDITS = {
    "src/modes/catalog.ts": [
        ('const GEN_RESEARCH = ["search_images", "search_x", "solve_logic"];\n',
         'const GEN_RESEARCH = ["search_images", "search_x", "solve_logic"];\n'
         '/** Legal mode (Qatar): verified-corpus research, cite-check, contract review. */\n'
         'const LEGAL = ["legal_search", "legal_article", "legal_cite_check", "legal_memo_check", "contract_import", "contract_clauses", "contract_review", "contract_redline"];\n'
         '/** Control tools minus the project wiki writer: client facts must not land in the plaintext wiki. */\n'
         'const LEGAL_CONTROL = CONTROL.filter((name) => name !== "wiki_write");\n'),
        ('  { id: "automate", label: "Loam Flow",',
         '  { id: "legal", label: "Loam Legal", labelAr: "قانوني", icon: "§", hue: 35, hue2: 15,\n'
         '    tagline: "نصوص موثقة قبل الرأي", description: "ابحث في التشريعات القطرية الموثقة، وصغ المذكرات والآراء، وراجع العقود باستشهادات مُتحقق منها حرفياً. المخرجات مسودات حتى يعتمدها محامٍ مرخّص.", outputHint: "مسودة قانونية باستشهادات موثقة. Use legal_search/legal_article for every legal statement and legal_cite_check (or legal_memo_check) before presenting a draft; never cite from memory.", readOnly: false,\n'
         '    tools: [...READ, "file_write", "file_edit", "find_and_edit", "file_mkdir", ...EDIT_EXTRA, "artifact_publish", ...LEGAL, ...LEGAL_CONTROL], panels: ["files", "legal"],\n'
         '    fields: [{ id: "matter", label: "المسألة", placeholder: "وقائع الدعوى أو العقد المطلوب مراجعته", multiline: true }, { id: "asOf", label: "تاريخ تطبيق النصوص", placeholder: "تاريخ الوقائع أو العقد (YYYY-MM-DD)" }],\n'
         '    starters: [{ label: "مذكرة دفاع", prompt: "صغ مذكرة دفاع في الدعوى المرفقة وفق مهارة qatar-defense-memo، بنصوص موثقة في تاريخ الوقائع." }, { label: "مراجعة عقد", prompt: "راجع العقد المرفق وفق القانون القطري ومهارة qatar-contract-review، وأعد تقرير المراجعة." }] },\n'
         '  { id: "automate", label: "Loam Flow",'),
        ('"legal-compliance": "research",', '"legal-compliance": "legal",'),
    ],
    "src/policy/riskTier.ts": [
        ('const READ_TOOL_NAMES = new Set<string>([\n',
         'const READ_TOOL_NAMES = new Set<string>([\n'
         '  // Legal mode: corpus reads and checks (client text never leaves via these).\n'
         '  "legal_search",\n  "legal_article",\n  "legal_cite_check",\n  "legal_memo_check",\n  "contract_clauses",\n  "contract_review",\n'),
        ('const WRITE_TOOL_NAMES = new Set<string>([\n',
         'const WRITE_TOOL_NAMES = new Set<string>([\n'
         '  // Legal mode: write inside the task workspace / encrypted matters store.\n'
         '  "contract_import",\n  "contract_redline",\n'),
    ],
    "src/config.ts": [
        ('  routing?: import("./llm/router.js").RoutingConfig;\n}\n',
         '  routing?: import("./llm/router.js").RoutingConfig;\n'
         '  /** Legal mode (Qatar). Absent = disabled; normalized by src/legal/config.ts. */\n'
         '  legal?: Partial<import("./legal/config.js").LegalConfig>;\n}\n'),
    ],
    "src/setup/runtime.ts": [
        ('import { createKnowledgeTools } from "../tools/knowledge.js";\n',
         'import { createKnowledgeTools } from "../tools/knowledge.js";\n'
         'import { createLegalTools } from "../tools/legalTools.js";\n'
         'import { normalizeLegalConfig } from "../legal/config.js";\n'
         'import { requestMattersKey, parentPortOf } from "../legal/keyHandoff.js";\n'
         'import { createLegalRuntime, type LegalRuntime } from "../legal/runtime.js";\n'
         'import { fromFile } from "../knowledge/importers.js";\n'
         'import { DATA_DIR } from "../config.js";\n'),
        ('  mcp: McpToolset | null;\n',
         '  mcp: McpToolset | null;\n'
         '  /** Legal mode runtime (corpus + encrypted matters); null when cfg.legal.enabled is false. */\n'
         '  legal: LegalRuntime | null;\n'),
        ('    model: cfg.memory.model || cfg.model,\n  }));\n',
         '    model: cfg.memory.model || cfg.model,\n  }));\n'
         '  // Legal mode (Qatar): opt-in. The corpus is public law; matters are encrypted with a\n'
         '  // DPAPI-wrapped key handed over by Electron main (fail closed without it).\n'
         '  const legalConfig = normalizeLegalConfig(cfg.legal);\n'
         '  const legal = legalConfig.enabled\n'
         '    ? createLegalRuntime({\n'
         '        dataDir: DATA_DIR,\n'
         '        config: legalConfig,\n'
         '        ollamaUrl: cfg.ollamaUrl,\n'
         '        ...(legalConfig.embedModel ? { embedder: new OllamaEmbedder(cfg.ollamaUrl, legalConfig.embedModel) } : {}),\n'
         '        extractText: async (absPath: string) => (await fromFile(absPath)).text,\n'
         '      })\n'
         '    : null;\n'
         '  if (legal) {\n'
         '    registry.registerAll(createLegalTools(legal.toolDeps));\n'
         '    if (!requestMattersKey(parentPortOf(process))) log.warn("legal: no Electron parent port; matters stay locked");\n'
         '  }\n'),
        ('  return {\n    cfg,\n    ollama,\n    registry,\n',
         '  return {\n    cfg,\n    ollama,\n    registry,\n    legal,\n'),
    ],
    "src/server/recovery.ts": [
        ('  mission?: boolean;\n  knowledge?: boolean;\n}\n',
         '  mission?: boolean;\n  knowledge?: boolean;\n  /** Legal mode: the matter this run works on (decides egress). */\n  legalMatterId?: string;\n}\n'),
    ],
    "src/server/http.ts": [
        ('import { handleKnowledgeRoutes } from "./routes/knowledge.js";\n',
         'import { handleKnowledgeRoutes } from "./routes/knowledge.js";\n'
         'import { handleLegalRoutes } from "./routes/legal.js";\n'
         'import type { LegalRuntime } from "../legal/runtime.js";\n'),
        ('  embedder?: { embed(texts: string[]): Promise<number[][]> };\n}\n',
         '  embedder?: { embed(texts: string[]): Promise<number[][]> };\n'
         '  /** Legal mode runtime; absent when legal mode is disabled. */\n'
         '  legal?: LegalRuntime;\n}\n'),
        ('  knowledge?: boolean;\n  /** O6: protocol session',
         '  knowledge?: boolean;\n  /** Legal mode: the matter this run works on. */\n  legalMatterId?: string;\n  /** O6: protocol session'),
        ('        if (await handleKnowledgeRoutes(req, res, p, {\n          workspace: cfg.workspace,\n          ...(deps.embedder ? { embedder: deps.embedder } : {}),\n          model: cfg.memory.model || cfg.model,\n        })) return;\n',
         '        if (await handleKnowledgeRoutes(req, res, p, {\n          workspace: cfg.workspace,\n          ...(deps.embedder ? { embedder: deps.embedder } : {}),\n          model: cfg.memory.model || cfg.model,\n        })) return;\n\n'
         '        // Legal mode (Qatar): corpus, matters, verification, review gate.\n'
         '        if (p.startsWith("/api/legal")) {\n'
         '          if (!deps.legal) return sendJson(res, p.split("?")[0] === "/api/legal/status" ? 200 : 404, { enabled: false });\n'
         '          if (await handleLegalRoutes(req, res, p, { corpus: deps.legal.corpus, matters: deps.legal.matters, egress: deps.legal.egress, keys: deps.legal.keys, enabled: true })) return;\n'
         '        }\n'),
        ('            knowledge?: unknown;\n',
         '            knowledge?: unknown;\n            legalMatterId?: unknown;\n'),
        ('          const knowledge = body.knowledge === true;\n',
         '          const knowledge = body.knowledge === true;\n'
         '          const legalMatterId = typeof body.legalMatterId === "string" && body.legalMatterId.trim() ? body.legalMatterId.trim() : undefined;\n'),
        ('              ...(mission ? { mission: true } : {}),\n              knowledge,\n            });\n',
         '              ...(mission ? { mission: true } : {}),\n              knowledge,\n              ...(legalMatterId ? { legalMatterId } : {}),\n            });\n'),
    ],
    "src/index.ts": [
        ('import { OllamaClient } from "./ollama.js";\n',
         'import { OllamaClient } from "./ollama.js";\n'
         'import { legalRunConfig } from "./legal/runConfig.js";\n'),
        ('    const effectiveCfg = { ...cfg, policy: { ...cfg.policy, allowOutsideWorkspaceRead: false }, workspace: opts.savedRun.workspace, model: chosenModel || cfg.model };\n',
         '    const baseEffectiveCfg = { ...cfg, policy: { ...cfg.policy, allowOutsideWorkspaceRead: false }, workspace: opts.savedRun.workspace, model: chosenModel || cfg.model };\n'
         '    // Legal mode: pin the approved local model and close every silent model switch\n'
         '    // (fallback chain, failover providers, coding router, routing map, A/B arms).\n'
         '    const legalRun = getLoamMode(opts.savedRun.mode).id === "legal";\n'
         '    if (legalRun && !rt.legal) throw new Error("Legal mode is disabled. Enable it in Settings › Legal.");\n'
         '    const legalMatter = legalRun && rt.legal && opts.savedRun.legalMatterId ? rt.legal.matters.getMatter(opts.savedRun.legalMatterId) ?? null : null;\n'
         '    if (legalRun && opts.savedRun.legalMatterId && !legalMatter) throw new Error("Legal matter not found");\n'
         '    const legalPlan = legalRun && rt.legal ? legalRunConfig(baseEffectiveCfg, chosenModel || cfg.model, legalMatter, rt.legal.egress) : null;\n'
         '    const effectiveCfg = legalPlan ? legalPlan.cfg : baseEffectiveCfg;\n'
         '    if (legalPlan && rt.legal) rt.legal.runModels.set(task, legalPlan.model);\n'),
        ('    const runOllama = flexCreds && effectiveCfg.model === flexModelId ? new OllamaClient(cfg.ollamaUrl, { baseUrl: flexCreds.baseUrl, apiKey: flexCreds.apiKey }) : ollama;\n',
         '    // A legal run never uses the runtime FailoverClient: a plain loopback client with no cloud config.\n'
         '    const runOllama = legalPlan\n'
         '      ? new OllamaClient(cfg.ollamaUrl)\n'
         '      : flexCreds && effectiveCfg.model === flexModelId ? new OllamaClient(cfg.ollamaUrl, { baseUrl: flexCreds.baseUrl, apiKey: flexCreds.apiKey }) : ollama;\n'),
        ('    const abModels = opts.abModels && opts.abModels.length > 0\n',
         '    const abModels = legalPlan ? [] : opts.abModels && opts.abModels.length > 0\n'),
        ('        knowledge: opts.knowledge === true,\n      };\n',
         '        knowledge: opts.knowledge === true,\n'
         '        ...(opts.legalMatterId ? { legalMatterId: opts.legalMatterId } : {}),\n      };\n'),
        ('      clearRunSignal(task.id); heartbeat?.stop(); if (lease) releaseRunLease(lease); videoStudioRelay.cancelTask(task.id);\n',
         '      clearRunSignal(task.id); heartbeat?.stop(); if (lease) releaseRunLease(lease); videoStudioRelay.cancelTask(task.id);\n'
         '      rt.legal?.runModels.delete(task.id);\n'),
        ('    embedder: rt.embedder ?? undefined,\n    screenLive: rt.screenLive,\n',
         '    embedder: rt.embedder ?? undefined,\n    ...(rt.legal ? { legal: rt.legal } : {}),\n    screenLive: rt.screenLive,\n'),
    ],
    "electron/main.cjs": [
        ('ipcMain, protocol, utilityProcess } = require("electron");',
         'ipcMain, protocol, utilityProcess, safeStorage } = require("electron");'),
        ('    serverChild.on("exit", () => { exited = true; });\n',
         '    serverChild.on("exit", () => { exited = true; });\n'
         '    // Legal mode: answer the server\'s key request with the DPAPI-unwrapped matters key.\n'
         '    require("./legal-key.cjs").attachLegalKey(serverChild, app, safeStorage);\n'),
    ],
    "src/protocol/types.ts": [
        ('    knowledge?: boolean;\n    /** Neo N10: composer output type',
         '    knowledge?: boolean;\n'
         '    /** Legal mode: id of the active matter (opaque; the server reloads it from the encrypted store). */\n'
         '    legalMatterId?: string;\n'
         '    /** Neo N10: composer output type'),
    ],
    "src/protocol/socket.ts": [
        ('              knowledge: um.extData.knowledge === true,\n',
         '              knowledge: um.extData.knowledge === true,\n'
         '              // Legal mode: the matter this run works on (ignored by every other mode).\n'
         '              ...(typeof um.extData.legalMatterId === "string" && um.extData.legalMatterId ? { legalMatterId: um.extData.legalMatterId } : {}),\n'),
    ],
    "packages/web/src/app/app/[sessionUid]/TaskPageClient.tsx": [
        ("import { uploadFile } from '@/services/upload';\n",
         "import { uploadFile } from '@/services/upload';\n"
         "import { legalExtData } from '@/services/legalApi';\n"),
        ("makeExtData(cwd, { approveForMe, knowledge: knowledgeOn, ...extData })",
         "makeExtData(cwd, { approveForMe, knowledge: knowledgeOn, ...legalExtData(), ...extData })"),
    ],
    "packages/web/src/components/settings/SettingsDialog.tsx": [
        ("import { KnowledgeGardenPane } from './KnowledgeGardenPane';\n",
         "import { KnowledgeGardenPane } from './KnowledgeGardenPane';\n"
         "import { LegalPanel } from '@/components/legal/LegalPanel';\n"),
        ("  { id: 'Knowledge Garden', group: 'Capabilities', icon: 'Leaf' },\n",
         "  { id: 'Knowledge Garden', group: 'Capabilities', icon: 'Leaf' },\n"
         "  { id: 'Legal', group: 'Capabilities', icon: 'BookMarked' },\n"),
        ("'Knowledge Garden', 'Learned lessons'",
         "'Knowledge Garden', 'Legal', 'Learned lessons'"),
        ("    case 'Knowledge Garden': return <KnowledgeGardenPane />;\n",
         "    case 'Knowledge Garden': return <KnowledgeGardenPane />;\n"
         "    case 'Legal': return <LegalPanel />;\n"),
    ],
    "package.json": [
        ('    "test:memory": ',
         '    "test:legal": "node --import tsx --test src/legal/__tests__/*.test.ts src/tools/__tests__/legalTools.test.ts src/server/routes/__tests__/legal.test.ts",\n    "test:memory": '),
    ],
}

# i18n: add the legal UI strings to Loam's catalogs (keys are English source strings).
import json
catalog = json.loads((SRC / "web/src/i18n/legal.i18n.json").read_text(encoding="utf-8"))
for lang in ("ar", "en"):
    f = DST / "packages/web/src/i18n" / f"{lang}.json"
    raw = f.read_text(encoding="utf-8")
    data = json.loads(raw)
    lines = []
    for key, tr in catalog.items():
        if key in data:
            if data[key] != tr[lang]:
                print(f"i18n {lang}: kept existing translation for {key!r}")
            continue
        lines.append(f"  {json.dumps(key, ensure_ascii=False)}: {json.dumps(tr[lang], ensure_ascii=False)}")
    if lines:
        # Textual append before the closing brace: the rest of the file stays byte-identical
        # (a json.dump round-trip would silently drop the catalog's duplicate keys).
        body = raw.rstrip()
        assert body.endswith("}"), f"{f} does not end with a closing brace"
        f.write_text(body[:-1].rstrip() + ",\n" + ",\n".join(lines) + "\n}\n", encoding="utf-8")
        json.loads(f.read_text(encoding="utf-8"))  # still valid JSON
    print(f"i18n {lang}: +{len(lines)} keys")

failed = False
for rel, edits in EDITS.items():
    f = DST / rel
    text = original = f.read_text(encoding="utf-8")
    for old, new in edits:
        # Already applied? The first line the edit adds is the marker.
        added = [ln for ln in new.splitlines() if ln.strip() and ln not in old.splitlines()]
        if added and added[0] in text:
            continue
        n = text.count(old)
        if n != 1:
            print(f"ANCHOR {'MISSING' if n == 0 else 'AMBIGUOUS'} in {rel}: {old[:70]!r}")
            failed = True
            break
        text = text.replace(old, new)
    else:
        if text != original:
            f.write_text(text, encoding="utf-8")
            print(f"edited {rel}")
        else:
            print(f"unchanged {rel} (already applied)")
sys.exit(1 if failed else 0)
