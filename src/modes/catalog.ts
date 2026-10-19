/** Loam's first-party modes. Tool access is enforced by ToolRegistry.forMode. */
export interface LoamMode {
  id: string; label: string; labelAr: string; icon: string; hue: number; hue2: number;
  tagline: string; description: string; outputHint: string; readOnly: boolean;
  tools: string[]; panels: string[];
  fields: Array<{ id: string; label: string; placeholder: string; multiline?: boolean }>;
  starters: Array<{ label: string; prompt: string }>;
}

const READ = ["file_read", "file_list", "file_search", "file_stat", "file_extract_text", "file_view_image"];
const WRITE = ["file_write", "file_edit", "file_mkdir", "file_move", "file_delete"];
const BROWSER = ["browser_open", "browser_goto", "browser_snapshot", "browser_click", "browser_type", "browser_press", "browser_screenshot", "browser_table", "browser_act", "browser_pages", "browser_close", "browser_eval"];
const PREVIEW = ["preview_serve", "preview_status", "preview_stop"];

export const LOAM_MODES: LoamMode[] = [
  { id: "ask", label: "Loam Explore", labelAr: "استكشف", icon: "◌", hue: 155, hue2: 135,
    tagline: "وضوح قبل التنفيذ", description: "افهم أفكارك وملفات هذه المهمة واسأل دون تعديل الملفات أو تشغيل أوامر.", outputHint: "إجابة واضحة وخطوات مقترحة", readOnly: true,
    tools: [...READ, "code_symbols", "code_outline"], panels: ["files"],
    fields: [{ id: "question", label: "ما الذي تريد فهمه؟", placeholder: "اشرح الفكرة أو أرفق ملفًا", multiline: true }, { id: "audience", label: "مستوى التفاصيل", placeholder: "مختصر، تفصيلي، أو مناسب للمبتدئين" }],
    starters: [{ label: "اشرح مستندًا", prompt: "اقرأ المستند المرفق واشرح أهم النقاط والمصطلحات." }, { label: "قارن فكرتين", prompt: "ساعدني في مقارنة خيارين وتحديد أسئلة القرار." }] },
  { id: "research", label: "Loam Research", labelAr: "ابحث", icon: "⌕", hue: 195, hue2: 170,
    tagline: "مصادر تقود إلى فهم", description: "اجمع مصادر الويب واقرأها وقارن الأدلة في تقرير موثق داخل المهمة.", outputHint: "تقرير بمصادر وروابط", readOnly: false,
    tools: ["integration_list", "integration_call", ...READ, "file_write", "file_edit", "file_mkdir", "web_search", "web_fetch"], panels: ["files"],
    fields: [{ id: "topic", label: "موضوع البحث", placeholder: "السؤال الذي تبحث عن إجابته", multiline: true }, { id: "sources", label: "المصادر والنطاق", placeholder: "روابط البداية والفترة الزمنية المطلوبة" }],
    starters: [{ label: "قارن مصادر", prompt: "قارن المصادر التي سأرفقها، وافصل الحقائق عن الاستنتاجات مع روابط الأدلة." }, { label: "راجع موضوعًا", prompt: "أعد تقرير بحث حول الموضوع التالي، مع توضيح الثغرات وحدود المصادر المتاحة." }] },
  { id: "build", label: "Loam Build", labelAr: "ابنِ", icon: "⌘", hue: 100, hue2: 140,
    tagline: "من الفكرة إلى تجربة تعمل", description: "طوّر ملفات التطبيق وشغّل الاختبارات ومعاينة المشروع في مساحة المهمة.", outputHint: "ملفات مشروع ومعاينة ونتائج اختبارات", readOnly: false,
    tools: ["integration_list", "integration_call", ...READ, ...WRITE, "loam_mobile", "code_symbols", "code_outline", "shell_run", "web_fetch", ...PREVIEW], panels: ["files", "preview"],
    fields: [{ id: "brief", label: "ماذا سنبني؟", placeholder: "المستخدمون والوظائف المطلوبة", multiline: true }, { id: "acceptance", label: "معايير الإنجاز", placeholder: "ما السلوك الذي يجب اختباره قبل التسليم؟", multiline: true }],
    starters: [{ label: "صفحة تعريفية", prompt: "ابنِ صفحة تعريفية عربية متجاوبة مع معاينة محلية واختبر عرض الهاتف." }, { label: "أصلح مشروعًا", prompt: "افحص ملفات المشروع المرفقة، حدد العطل وأصلحه ثم شغّل الاختبارات المناسبة." }] },
  { id: "write", label: "Loam Write", labelAr: "اكتب", icon: "✎", hue: 55, hue2: 75,
    tagline: "أفكار تجد صياغتها", description: "اكتب المستندات وأنشئ العروض شريحة بشريحة في محرر حي قابل للتعديل مباشرة.", outputHint: "مستند منسق قابل للتنزيل", readOnly: false,
    tools: ["integration_list", "integration_call", ...READ, "file_write", "file_edit", "file_mkdir", "loam_document", "loam_studio"], panels: ["studio", "files"],
    fields: [{ id: "brief", label: "نوع المستند ومحتواه", placeholder: "تقرير، رسالة، مقترح أو قصة", multiline: true }, { id: "tone", label: "الجمهور والنبرة", placeholder: "لمن نكتب؟ وما الطول والأسلوب المطلوبان؟" }],
    starters: [{ label: "مقترح عمل", prompt: "صغ مقترح عمل منظمًا بالأهداف والنطاق والجدول والمخرجات، واحفظه مستندًا." }, { label: "حرر مسودة", prompt: "راجع المسودة المرفقة وحسّن وضوحها مع المحافظة على المعنى." }] },
  { id: "data", label: "Loam Data", labelAr: "حلّل", icon: "▥", hue: 175, hue2: 150,
    tagline: "أرقام تشرح ما يحدث", description: "أنشئ الجداول وحرّر الخلايا مباشرة، وافحص بياناتك في مساحة عمل خاصة بالمهمة.", outputHint: "ملخص بيانات ونتائج قابلة للتدقيق", readOnly: false,
    tools: ["integration_list", "integration_call", ...READ, "file_write", "file_edit", "file_mkdir", "loam_dataset", "loam_studio"], panels: ["studio", "files"],
    fields: [{ id: "question", label: "سؤال التحليل", placeholder: "ما القرار الذي تريد أن تدعمه البيانات؟", multiline: true }, { id: "columns", label: "المقاييس والأعمدة", placeholder: "حدّد الأعمدة أو الفترة أو قواعد جودة البيانات" }],
    starters: [{ label: "افحص جودة البيانات", prompt: "افحص ملف CSV المرفق ولخص عدد الصفوف والقيم المفقودة والأعمدة الرقمية دون اختلاق بيانات." }, { label: "استخرج مؤشرات", prompt: "استخرج المؤشرات الرئيسية من البيانات المرفقة واحفظ تقريرًا يشرح الحسابات وحدودها." }] },
  { id: "media", label: "Loam Studio", labelAr: "صمّم", icon: "◇", hue: 25, hue2: 45,
    tagline: "من الفكرة إلى مشهد حي", description: "حرّر المجسّمات والخامات والإضاءة والحركة، واستورد ملفات GLB وصدّر المشهد والصور من مساحة المهمة.", outputHint: "مشهد ثلاثي الأبعاد وصور وملفات GLB", readOnly: false,
    tools: ["integration_list", "integration_call", ...READ, "file_write", "file_edit", "file_mkdir", "loam_canvas", "loam_creative", ...PREVIEW], panels: ["creative", "files", "preview"],
    fields: [{ id: "brief", label: "الفكرة البصرية", placeholder: "صف المشهد والمجسّمات التي تريد إنشاءها", multiline: true }, { id: "style", label: "الخامات والإخراج", placeholder: "الألوان والإضاءة وزاوية الكاميرا والحركة" }],
    starters: [{ label: "مشهد منتج", prompt: "أنشئ مشهد منتج من المجسّمات الأساسية مع قاعدة وخامات معدنية وإضاءة مناسبة باستخدام loam_creative." }, { label: "تكوين متحرك", prompt: "أنشئ تكوينًا من حلقات وكرات متناسقة الألوان مع حركة دوران باستخدام loam_creative." }] },
  { id: "automate", label: "Loam Flow", labelAr: "أنجز", icon: "↗", hue: 220, hue2: 195,
    tagline: "خطوات متكررة، عمل أوضح", description: "نفّذ خطوات تفاعل المتصفح وسجّل الأدلة. راجع تفاصيل الإجراءات الخارجية قبل طلبها.", outputHint: "سجل إجراءات ولقطات توثيق", readOnly: false,
    tools: ["integration_list", "integration_call", ...READ, "file_write", "file_mkdir", ...BROWSER, "task_create", "task_list", "task_get", "task_cancel", "schedule_create", "schedule_list", "schedule_delete"], panels: ["files", "browser"],
    fields: [{ id: "workflow", label: "خطوات العمل", placeholder: "الرابط والخطوات المطلوبة والنتيجة المتوقعة", multiline: true }, { id: "limits", label: "حدود التنفيذ", placeholder: "الإجراءات المسموحة وما يتطلب الرجوع إليك" }],
    starters: [{ label: "تحقق من صفحة", prompt: "افتح الرابط الذي سأقدمه وافحص العناصر المرئية وسجّل لقطة ودليلًا على النتيجة." }, { label: "نفّذ إجراء متكرر", prompt: "ساعدني في تنفيذ خطوات المتصفح التالية، وتحقق من نتيجة كل خطوة قبل المتابعة." }] },
];

const aliases: Record<string, string> = {
  full: "build", general: "build", discuss: "ask", plan: "ask", agent: "build",
  "app-build": "build", "mobile-dev": "build", "game-dev": "build", "testing-qa": "build",
  "security-pentest": "build", "reverse-engineer": "build", "devops-cloud": "build",
  "ecommerce-fintech": "build", "i18n-localization": "write", "performance-load": "build",
  "iot-embedded": "build", "web3-blockchain": "build", "ai-rag-studio": "research",
  "document-editor": "write", presentation: "write", "presentation-editor": "write",
  "excel-editor": "data", "data-science": "data", "media-studio": "media",
  "desktop-automation": "automate", "voice-live-assistant": "ask", "legal-compliance": "research",
  "network-protocol-inspector": "research", "digital-twin-sim": "data",
};
export function normalizeModeId(value?: string): string {
  const id = (value ?? "").trim() || "build";
  return aliases[id] ?? id;
}
export function getLoamMode(value?: string): LoamMode {
  const id = normalizeModeId(value);
  const mode = LOAM_MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`Unknown Loam mode: ${id}`);
  return mode;
}
export function getLoamModesUi(registeredNames: string[] = []): { available: boolean; activeMode: string; modes: Array<LoamMode & { availableTools: string[]; unavailableTools: string[]; activeToolCount: number }> } {
  const registered = new Set(registeredNames);
  return { available: true, activeMode: "build", modes: LOAM_MODES.map((mode) => {
    const availableTools = mode.tools.filter((name) => registered.has(name));
    return { ...mode, availableTools, unavailableTools: mode.tools.filter((name) => !registered.has(name)), activeToolCount: availableTools.length };
  }) };
}
