/**
 * Companion capability gateway (بوابة الأدوات الموحدة للمساعدين).
 *
 * Stage 1 of the companions frontier plan: every companion run resolves its
 * effective toolset here before execution. Layers, all server-enforced:
 *   1. Loam mode  — base allowlist (registry.forMode).
 *   2. Work mode  — grants extra services (computer use on the user's device,
 *                   team delegation) or revokes host-control services.
 *   3. Agent      — optional per-companion service allowlist + tool denials.
 *   4. Registry   — only tools that are actually registered survive.
 * Nothing outside the resolved allowlist can execute for the run.
 */
import { getLoamMode, LOAM_MODES } from "../modes/catalog.js";

export interface CompanionService {
  id: string;
  labelAr: string;
  description: string;
  tools: string[];
  /** Dynamic tools are created at run start and bound to the companion's own
   *  device (stage 2) — availability depends on the device, not the registry. */
  dynamic?: boolean;
}

/** Service catalog mapped to real registered tool names (kept in sync by check-companions). */
export const COMPANION_SERVICES: CompanionService[] = [
  { id: "files", labelAr: "الملفات", description: "قراءة وإنشاء وتعديل وتنظيم ملفات مساحة المهمة", tools: ["file_read", "file_write", "file_edit", "file_list", "file_search", "file_stat", "file_mkdir", "file_move", "file_delete", "file_extract_text", "file_view_image"] },
  { id: "search", labelAr: "البحث", description: "البحث في الويب وقراءة المصادر", tools: ["web_search", "web_fetch"] },
  { id: "browser", labelAr: "المتصفح", description: "أتمتة متصفح بجلسة المهمة مع أدلة", tools: ["browser_open", "browser_goto", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_eval", "browser_screenshot", "browser_table", "browser_act", "browser_pages", "browser_close", "browser_trace_start", "browser_trace_stop", "browser_trace_status", "browser_som"] },
  { id: "office", labelAr: "الأوفيس", description: "مستندات وجداول وعروض وصور وتصاميم حية في لوحة العمل (Loam Docs/Sheets/Slides/Photo/Design) + استيراد وتصدير DOCX/XLSX/PPTX", tools: ["loam_document", "loam_studio", "office_craft", "office_import", "office_export", "office_status"] },
  { id: "data", labelAr: "تحليل البيانات", description: "جداول ومؤشرات داخل المهمة", tools: ["loam_dataset"] },
  { id: "creative", labelAr: "استديو صمّم", description: "تحرير الصور والفيديو والمجسمات + التصدير الخلفي", tools: ["loam_creative", "loam_canvas", "creative_export", "creative_export_status", "creative_export_result", "creative_timeline", "creative_image", "creative_subtitles"] },
  { id: "mobile", labelAr: "تطوير التطبيقات", description: "مشاريع تطبيقات ويب وجوال وبناء APK محلي", tools: ["loam_mobile", "rork_build", "rork_from_web"] },
  { id: "swarm", labelAr: "ذكاء الأسراب", description: "تفويض فرق مساعدين وبوابات جودة", tools: ["super_swarm", "super_quality_gate", "super_time_travel", "metagpt_company", "subagent_list", "delegate_subagent"] },
  { id: "security", labelAr: "الأمن السيبراني", description: "فحوص مصرّح بها (رؤوس/كوكيز/ملفات مكشوفة/TLS...) وتقارير عبر pentest_check", tools: ["pentest_check", "pentest_routes", "pentest_report"] },
  { id: "shell", labelAr: "بيئة الأوامر", description: "أوامر وطرفيات داخل مساحة المهمة", tools: ["shell_run", "shell_start", "shell_write", "shell_read", "shell_list", "shell_kill", "pty_start", "pty_write", "pty_read", "pty_list", "pty_kill"] },
  { id: "code", labelAr: "فهم الكود", description: "رموز المشروع وهيكلته والبحث الدلالي في الملفات", tools: ["code_symbols", "code_outline", "semantic_search"] },
  { id: "memory", labelAr: "الذاكرة والمعرفة", description: "ذاكرة دائمة وبحث في الجلسات", tools: ["memory_store", "memory_search", "memory_list", "memory_delete", "session_search"] },
  // N3 Knowledge Garden: the user's own imported documents, split into
  // retrievable seeds. Reachable only when the run's KB toggle is on, so the
  // service grants the names and src/index.ts applies the per-run gate.
  // Phase-2 W2 «تحدث مع ملفاتك»: task_files_ingest bulk-imports the task
  // workspace's text files through the same garden, so it rides the same gate.
  { id: "knowledge", labelAr: "حديقة المعرفة", description: "مستنداتك المستوردة مقسّمة إلى بذور قابلة للبحث مع الوسوم والاسترجاع الهجين (يقرأها الوكيل فقط عند تفعيل مفتاح الحديقة في التشغيل)", tools: ["kb_search", "kb_ingest", "kb_manage", "task_files_ingest"] },
  { id: "skills", labelAr: "المهارات", description: "اكتشاف المهارات وتشغيلها", tools: ["skill_list", "skill_view", "skill_create", "skill_patch", "skill_delete", "skill_search", "skill_install"] },
  { id: "preview", labelAr: "المعاينة", description: "تشغيل معاينات المشروع محليًا", tools: ["preview_serve", "preview_status", "preview_stop", "preview_screenshot"] },
  { id: "screen", labelAr: "متابعة الشاشة", description: "قراءة شاشة المستخدم الحية (يتطلب وضع العمل على جهازي)", tools: ["screen_look", "screen_stream_start", "screen_stream_status", "screen_stream_stop", "screen_watch"] },
  { id: "computer", labelAr: "التحكم بالكمبيوتر", description: "أدوات واجهة أصلية على جهاز المستخدم (يتطلب وضع العمل على جهازي)", tools: ["computer_screenshot", "computer_list_windows", "computer_focus_window", "computer_ui_tree", "computer_ui_list", "computer_ui_click", "computer_ui_set_text", "computer_click", "computer_type", "computer_key"] },
  { id: "integrations", labelAr: "الخدمات المتصلة", description: "موصلات خارجية مصرّح بها للمساعد", tools: ["integration_list", "integration_call", "mirofish_chat", "lovable_studio"] },
  { id: "device", labelAr: "جهاز المساعد المستقل", description: "تنفيذ أوامر وقراءة/كتابة/نقل ملفات داخل الجهاز الافتراضي المعزول الخاص بالمساعد (يتطلب وضع جهازه المستقل وجهازًا جاهزًا)", tools: ["device_exec", "device_read_file", "device_write_file", "device_list_files", "device_pull_file", "device_push_file", "device_write_secret"], dynamic: true },
  { id: "companion-memory", labelAr: "ذاكرة المساعد الشخصية", description: "ذاكرة دائمة خاصة بهذا المساعد: تفضيلات وحقائق وتعليمات بمصدر وتاريخ ودرجة ثقة — تُراجع وتُصدَّر ولا تنتقل بين المساعدين", tools: ["companion_memory_save", "companion_memory_search", "companion_memory_list"], dynamic: true },
  { id: "team", labelAr: "تعاون المساعدين", description: "تفويض جزء من العمل إلى رفيق آخر يعمل بهويته ومتابعة نتيجته (يتطلب وضعه ضمن فريق/تنفيذ)", tools: ["companion_delegate", "companion_delegations"], dynamic: true },
  { id: "learning", labelAr: "التعلم من طريقة العمل", description: "تحويل سير العمل المتكرر إلى مهارة مرقّمة الإصدارات مع توثيق سبب نجاحها", tools: ["companion_learn_skill"], dynamic: true },
  { id: "tasks", labelAr: "المهام والمشاريع", description: "إنشاء مهام Loam ومتابعتها وإلغاؤها وقراءة نتائجها", tools: ["task_create", "task_list", "task_get", "task_cancel"] },
  { id: "automation", labelAr: "الأتمتة", description: "روتينات مجدولة تُشغّل دوريًا (إنشاء/عرض/حذف)", tools: ["schedule_create", "schedule_list", "schedule_delete", "watch_create", "watch_list", "schedule_wakeup", "cancel_wakeup"] },
  { id: "core", labelAr: "الأدوات الأساسية", description: "البحث والكود والوثائق والتنفيذ والتكاملات المضمنة في Loam", tools: [
    "grep", "glob", "codegraph_status", "codegraph_index", "codegraph_query", "codegraph_node", "codegraph_neighbors", "codegraph_path", "codegraph_affected", "codegraph_hubs", "codegraph_community", "docs_lookup", "think", "finish", "plan", "phase_set", "message", "plan_exit", "suggest_plan", "ask_user", "context_recall", "budget_status", "budget_pause", "budget_resume", "threat_model_get", "mcp_list_servers", "mcp_search_tools", "mcp_tool_schema", "mcp_call_tool", "wiki_search", "wiki_read", "wiki_list", "wiki_write", "handoff_create", "handoff_list", "handoff_resolve", "app_list", "app_describe", "ask_codebase", "file_multi_edit", "artifact_publish", "search_images", "search_x", "solve_logic", "find_and_edit", "memory_add", "vault_ref", "code_session", "code_session_status", "code_session_collect", "app_task_create", "app_task_finish", "app_context_write", "app_verify", "app_version_note", "app_db_query", "app_add_dependency", "web_scaffold", "scaffold_backend", "deploy_app", "export_build", "design_create", "loam_design", "git_branch", "git_commit", "git_status_diff", "pr_create", "pr_view", "pr_comments", "pr_comment_checklist", "ci_watch", "pr_review", "verify_and_record", "wiki_generate", "app_run", "re_analyze", "re_decompile", "re_rebuild_verify", "fuzz_run", "aixcc_patch_propose", "managed_child_start", "managed_child_message", "managed_child_sleep", "managed_child_wake", "managed_child_terminate", "managed_child_answer", "managed_child_status", "managed_child_events", "schedule_self_reminder", "office_edit", "office_workflow_run", "office_intelligence_run", "image_ocr", "device_preview", "design_brief", "design_image_generate", "video_studio", "video_edit", "loam_recorder", "gen_3d_from_image", "gen_music", "generate_storyboard", "security_assess", "security_status", "security_audit_start", "security_audit_status", "security_audit_report", "remediation_start", "remediation_status", "remediation_report", "remediation_cancel", "secrets_scan", "sca_scan", "sbom_generate", "sast_scan", "sast_diff", "config_scan", "supplychain_scan", "recon_scan", "llm_scan", "mcp_scan", "threat_model_save", "threat_model_amend", "coverage_record", "coverage_update", "coverage_list", "coverage_report", "coverage_delete", "proxy_start", "proxy_status", "proxy_list_requests", "proxy_view_request", "proxy_repeat_request", "proxy_scope", "proxy_stop", "red_campaign", "red_report", "red_kill_switch", "github_list_repos", "github_list_issues", "github_create_issue", "swarm_run", "swarm_status", "legal_search", "legal_article", "legal_cite_check", "legal_memo_check", "contract_import", "contract_clauses", "contract_review", "contract_redline", "qatar_library_search", "qatar_library_doc", "mcp__rea__analyze_javascript_application", "mcp__rea__inspect_web_network_capture", "mcp__rea__export_evidence_bundle", "mcp__rea__import_evidence_bundle", "mcp__cua-driver__list_apps", "mcp__cua-driver__list_windows", "mcp__cua-driver__get_window_state", "mcp__cua-driver__get_desktop_state", "mcp__cua-driver__get_screen_size", "mcp__cua-driver__click", "mcp__cua-driver__type_text", "mcp__cua-driver__press_key", "mcp__cua-driver__hotkey", "mcp__cua-driver__scroll", "mcp__cua-driver__invoke_menu", "mcp__cua-driver__verify_state", "mcp__cua-driver__start_session", "mcp__cua-driver__end_session",
  ] },
];

export interface WorkModeDef {
  id: string;
  labelAr: string;
  description: string;
  /** Service ids granted on top of the Loam-mode tool set. */
  grants: string[];
  /** Service ids revoked even when the Loam mode lists their tools. */
  revokes: string[];
  /** Requires a provisioned companion device before a run can start (stage 2). */
  requiresDevice: boolean;
  /** Policy text appended to the system prompt for runs in this mode. */
  policy: string;
}

/** Tool names bound at run start (device/memory/team instances); capability resolution needs them upfront. */
export const COMPANION_DYNAMIC_TOOL_NAMES: string[] = COMPANION_SERVICES.filter((s) => s.dynamic).flatMap((s) => s.tools);

export const WORK_MODES: WorkModeDef[] = [
  { id: "chat", labelAr: "المحادثة", description: "يجيب ويبحث ويخطط ضمن الأدوات المسموحة دون تحكم بالجهاز أو أوامر تنفيذية", grants: ["companion-memory", "knowledge"], revokes: ["shell", "computer", "screen", "tasks", "automation"], requiresDevice: false,
    policy: "وضع «المحادثة»: أجب وابحث وخطط ضمن الأدوات المتاحة. لا تتحكم بجهاز المستخدم ولا تنفّذ أوامر نظام؛ إن طُلب التنفيذ فاقترح على المستخدم التبديل إلى وضع «تنفيذ داخل Loam»." },
  { id: "loam", labelAr: "تنفيذ داخل Loam", description: "يستخدم خدمات التطبيق وينشئ نتائج قابلة للتحرير دون لمس جهاز المستخدم", grants: ["tasks", "automation", "companion-memory", "team", "learning", "knowledge"], revokes: ["computer", "screen"], requiresDevice: false,
    policy: "وضع «تنفيذ داخل Loam»: أنجز العمل عبر خدمات Loam داخل مساحة المهمة، وأنتج نتائج قابلة للفتح والتحرير، ولا تتحكم بجهاز المستخدم." },
  { id: "user_device", labelAr: "العمل على جهازي", description: "يتحكم بجهاز المستخدم ضمن النطاق المسموح مع توقف فوري عند التدخل", grants: ["computer", "screen", "tasks", "automation", "companion-memory", "learning", "knowledge"], revokes: [], requiresDevice: false,
    policy: "وضع «العمل على جهازي»: تتحكم بجهاز المستخدم ضمن نطاق المهمة فقط. اقرأ عناصر الواجهة قبل أي إجراء، تحقق من نتيجة كل إجراء قبل التالي، لا تفتح بيانات خارج نطاق المهمة، وتوقف فورًا عند تدخل المستخدم أو طلب الإيقاف (مفتاح الإيقاف الفوري متاح للمستخدم)." },
  { id: "own_device", labelAr: "جهاز المساعد المستقل", description: "ينفّذ داخل بيئة معزولة خاصة به (عمليات وملفات وحساب مستقل) دون لمس جهاز المستخدم", grants: ["device", "tasks", "automation", "companion-memory", "team", "learning", "knowledge"], revokes: ["computer", "screen", "preview", "shell", "browser"], requiresDevice: true,
    policy: "وضع «جهاز المساعد المستقل»: نفّذ العمل داخل جهازك الافتراضي المعزول عبر أدوات device_* (exec/قراءة/كتابة/سرد/سحب/دفع) — لا تلمس جهاز المستخدم إطلاقًا. جهّز الملفات التي تحتاجها بـ device_push_file وأخرج النتائج إلى مساحة المهمة بـ device_pull_file حتى تصل للمستخدم. إن تولّى المستخدم التحكم ستُرجأ أوامرك؛ أبلغ المستخدم حينها وانتظر." },
  { id: "team", labelAr: "العمل ضمن فريق", description: "يتعاون مع مساعدين آخرين مع ملكية واضحة للمهام", grants: ["swarm", "tasks", "automation", "companion-memory", "team", "learning", "knowledge"], revokes: ["computer", "screen"], requiresDevice: false,
    policy: "وضع «العمل ضمن فريق»: فوّض أجزاء المهمة لمساعدين متخصصين عبر أدوات السرب، مع ملكية واضحة لكل مهمة، وتحقق من تكامل النتائج قبل التسليم، وابقَ أنت الواجهة الوحيدة أمام المستخدم." },
  { id: "continuous", labelAr: "العمل المستمر", description: "يتابع أهدافًا وروتينات ومواعيد في الخلفية", grants: ["tasks", "automation", "companion-memory", "knowledge"], revokes: ["computer", "screen"], requiresDevice: false,
    policy: "وضع «العمل المستمر»: تابع الهدف عبر خطوات قابلة للاستئناف، واحفظ نقاط الاستكمال، واقترح على المستخدم روتينًا مجدولًا (عبر خدمة الجدولة) عندما يكون التكرار جزءًا من الهدف." },
];

export function normalizeWorkMode(value?: string): string {
  const id = (value ?? "").trim() || "loam";
  if (WORK_MODES.some((m) => m.id === id)) return id;
  throw new Error(`Unknown work mode: ${id}`);
}

export function getWorkMode(value?: string): WorkModeDef {
  return WORK_MODES.find((m) => m.id === normalizeWorkMode(value))!;
}

/** Throws on unknown service ids so bad grants never silently pass. */
export function validateServiceIds(values: string[]): void {
  const known = new Set(COMPANION_SERVICES.map((s) => s.id));
  for (const id of values) {
    if (!known.has(id)) throw new Error(`Unknown companion service: ${id}`);
  }
}

export interface CompanionResolveInput {
  mode: string;
  workMode?: string;
  /** Per-agent service allowlist. undefined/empty = all services. */
  allowedServices?: string[];
  /** Disable only personal/shared companion memory, independent of work mode. */
  memoryEnabled?: boolean;
  disabledTools?: string[];
  registeredTools: string[];
}

export type ServiceStatus = "allowed" | "blocked_service" | "blocked_workmode" | "not_registered";

export interface ServiceCapability {
  id: string;
  labelAr: string;
  status: ServiceStatus;
  /** Effective tool names (registered, granted, not disabled). */
  tools: string[];
  totalTools: number;
}

export interface CompanionResolution {
  workMode: string;
  /** Final server-enforced allowlist (mode ∪ extras − revokes − denials). */
  allow: string[];
  /** Granted tools beyond the Loam-mode set — passed to registry.forMode extras. */
  extraAllow: string[];
  services: ServiceCapability[];
  requiresDevice: boolean;
}

const toolServiceIndex = (): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  for (const service of COMPANION_SERVICES) {
    for (const tool of service.tools) {
      index.set(tool, [...(index.get(tool) ?? []), service.id]);
    }
  }
  return index;
};

export function resolveCompanionCapabilities(input: CompanionResolveInput): CompanionResolution {
  const workModeDef = getWorkMode(input.workMode);
  const modeTools = new Set(getLoamMode(input.mode).tools);
  const granted = new Set(input.allowedServices && input.allowedServices.length > 0 ? input.allowedServices : COMPANION_SERVICES.map((s) => s.id));
  const revoked = new Set(workModeDef.revokes);
  if (input.memoryEnabled === false) revoked.add("companion-memory");
  const disabled = new Set(input.disabledTools ?? []);
  const registered = new Set(input.registeredTools);
  const byTool = toolServiceIndex();

  const serviceAllowed = (id: string): boolean => granted.has(id) && !revoked.has(id);
  const toolPasses = (tool: string): boolean => {
    if (disabled.has(tool) || !registered.has(tool)) return false;
    return (byTool.get(tool) ?? []).every(serviceAllowed);
  };

  const services: ServiceCapability[] = COMPANION_SERVICES.map((service) => {
    const blockedWorkmode = revoked.has(service.id);
    const blockedService = !blockedWorkmode && !granted.has(service.id);
    const status: ServiceStatus = blockedWorkmode ? "blocked_workmode" : blockedService ? "blocked_service" : "not_registered";
    const effective = service.tools.filter(toolPasses);
    return {
      id: service.id,
      labelAr: service.labelAr,
      status: effective.length > 0 ? "allowed" : status,
      tools: effective,
      totalTools: service.tools.length,
    };
  });

  // Extra tools granted by the work mode but absent from the Loam-mode set
  // (computer/screen under user-device, swarm delegation under team).
  const extraAllow = [
    ...new Set(
      workModeDef.grants
        .flatMap((id) => COMPANION_SERVICES.find((s) => s.id === id)?.tools ?? [])
        .filter((tool) => !modeTools.has(tool) && toolPasses(tool)),
    ),
  ];
  const allow = [...new Set([...modeTools, ...extraAllow])].filter(toolPasses);

  return { workMode: workModeDef.id, allow, extraAllow, services, requiresDevice: workModeDef.requiresDevice };
}

/** UI/API view of the work modes + service catalog with real availability. */
export function getWorkModesUi(registeredNames: string[] = []): { workModes: WorkModeDef[]; services: Array<CompanionService & { availableToolCount: number }> } {
  const registered = new Set(registeredNames);
  return {
    workModes: WORK_MODES,
    services: COMPANION_SERVICES.map((s) => ({ ...s, availableToolCount: s.dynamic ? s.tools.length : s.tools.filter((t) => registered.has(t)).length })),
  };
}

/** Every tool referenced by a Loam mode must belong to a service group, so the
 *  gateway intersection can never silently drop a vetted mode tool. */
export function uncoveredModeTools(): string[] {
  const byTool = toolServiceIndex();
  const out = new Set<string>();
  for (const mode of LOAM_MODES) {
    for (const tool of mode.tools) {
      if (!byTool.has(tool)) out.add(tool);
    }
  }
  return [...out];
}
