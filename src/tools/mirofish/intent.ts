/**
 * MiroFish chat intent routing (M5).
 *
 * The old implementation kept one giant `/.../iu` alternation with literal
 * Arabic strings. That had two problems: it only matched a couple of
 * hand-picked spellings (Gulf users type «محاكاة», «لو رفعنا السعر»,
 * «ايش بيصير لو», «توقع ردة فعل العملاء» and none of them matched), and any
 * Arabic string that had been written through the Windows shell came back as
 * `???` so the pattern could never match.
 *
 * This module therefore does the opposite of a literal match:
 *   1. normalize the message (strip Arabic diacritics/tatweel, unify
 *      alef/hamza/yeh/teh-marbuta forms, strip the definite article) so every
 *      reasonable Arabic spelling collapses onto one canonical form;
 *   2. match a curated list of intent patterns (Arabic MSA + Gulf dialect and
 *      English) against that canonical form;
 *   3. classify the intent: new simulation vs. follow-up what-if on the
 *      existing session vs. interview an agent vs. unrelated;
 *   4. pull out variable changes (price/rate/traffic/...) and location
 *      mentions («في الرياض», "in Berlin") so the caller can fold them into
 *      the simulation settings.
 *
 * It is pure: no I/O, no model calls, fully unit-testable.
 */

/* -------------------------------------------------------------------------- */
/* Text normalization                                                          */
/* -------------------------------------------------------------------------- */

/** Arabic diacritics (harakat), tatweel, and superscript alef. */
const ARABIC_DIACRITICS = /[ً-ٰٟـۖ-ۭ꙼]/g;

/** Canonical replacements applied after diacritic stripping. */
const ARABIC_CHAR_MAP: Array<[RegExp, string | ((c: string) => string)]> = [
  // Alef with hamza/wasla above/below, madda, and plain alef -> plain alef.
  [/[أإآٱ]/g, 'ا'],
  // Alef maksura and yeh -> yeh (covers Egyptian/Gulf variants).
  [/[ىئي]/g, 'ي'],
  // Teh marbuta -> heh (Gulf/MSA both commonly write it either way).
  [/[ة]/g, 'ه'],
  // Latin look-alikes typed on an Arabic keyboard.
  [/[Ａ-ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)],
];

/**
 * Canonicalize a message for matching. Returns a lower-cased string where
 * Arabic diacritics are gone, alef/hamza/yeh/teh-marbuta variants are unified,
 * and runs of whitespace collapse to a single space. Non-ASCII is preserved
 * (this is only for matching, never for display).
 */
export function normalizeArabicForMatch(input: string): string {
  let text = (input ?? '').replace(ARABIC_DIACRITICS, '');
  for (const [re, to] of ARABIC_CHAR_MAP) {
    text = typeof to === 'function' ? text.replace(re, to) : text.replace(re, to);
  }
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Remove the Arabic definite article so «محاكاة السرب» and «محاكاة سرب» match. */
function stripArabicDefiniteArticle(text: string): string {
  return text.replace(/ال(?=[اأإآبتثجحخدذرزسشصضطظعغفقكلمنهوي])/g, '');
}

/** Build the single canonical form used for every pattern match. */
function canonical(input: string): string {
  return stripArabicDefiniteArticle(normalizeArabicForMatch(input));
}

/**
 * Build a regex source that matches `phrase` as a whole word in both Arabic
 * and English. JavaScript `\b` only works on ASCII, so Arabic phrases need an
 * explicit boundary. The pattern is anchored with lookarounds instead of `\b`
 * so it works uniformly for both scripts.
 */
function wholeWord(phrase: string): string {
  return '(?:(?<![\\p{L}\\p{N}])' + escapeRe(phrase) + '(?![\\p{L}\\p{N}]))';
}

/**
 * Like `wholeWord` but tolerant of the Arabic conjunction/prefix letters
 * (و ف ب ك ل) that attach directly onto a noun: «والسعر», «بالترافيك».
 * Used for variable extraction, where a name is often glued to a prefix.
 */
function varWord(phrase: string): string {
  return '(?:^|\\s|[وفبكلك])' + escapeRe(phrase) + '(?!\\p{L})';
}

/** True when `phrase` occurs as a whole word (Arabic- or Latin-safe). */
function hasWholeWord(text: string, phrase: string): boolean {
  return new RegExp(wholeWord(canonical(phrase)), 'iu').test(text);
}

/* -------------------------------------------------------------------------- */
/* Intent classification                                                      */
/* -------------------------------------------------------------------------- */

export type MirofishIntentKind =
  | 'full_application_analysis'
  | 'what_if_injection'
  | 'agent_interview'
  | 'follow_up'
  | 'unrelated';

export interface MirofishTriggerMatch {
  kind: MirofishIntentKind;
  /** Human-readable label of the matched pattern family (diagnostics/tests). */
  matched: string;
  /** The canonical text the pattern matched against. */
  text: string;
}

interface TriggerRule {
  /** Stable family name used for diagnostics. */
  family: string;
  kind: MirofishIntentKind;
  /** Whole-word phrases matched against the canonical Arabic/English text. */
  phrases: string[];
  /** Additional regex predicates for shapes a phrase list cannot express. */
  patterns?: RegExp[];
  /**
   * Optional guard. A rule only fires when the guard returns true, which lets
   * a positive phrase stay negative when the message is clearly about
   * something else (e.g. «محاكاة» used in a coding context).
   */
  when?: (text: string) => boolean;
}

/* ------------------------- Negative context guards ------------------------- */

/**
 * Software/engineering vocabulary. When this is present the message is about
 * code, not a market simulation, so simulation triggers must not fire. This is
 * what keeps «محاكاة» from matching inside a coding request.
 */
const CODING_TERMS = [
  'برمج', 'برمجه', 'برمجة', 'كود', 'سيرفر', 'خادم', 'قاعده البيانات', 'قاعدة البيانات',
  'بيئه التطوير', 'بيئة التطوير', 'اختبار وحدات', 'اختبارات وحدات', 'وحده', 'وحدة',
  'خطا', 'خطأ', 'تصحيح', 'اصلح', 'أصلح', 'build', 'deploy', 'server', 'api', 'endpoint',
  'database', 'refactor', 'debug', 'compile', 'runtime', 'test suite', 'unit test', 'jest',
  'vitest', 'typescript', 'javascript', 'python', 'function', 'class', 'commit', 'branch',
  'pull request', 'migration', 'schema', 'query', 'sql', 'docker', 'kubernetes', 'npm',
  'node', 'react', 'component', 'css', 'html',
];

/**
 * Video-editing vocabulary. A request to «حاكي» a video or run a «مونتاج» is
 * not a market simulation.
 */
const VIDEO_TERMS = [
  'فيديو', 'فيديوهات', 'مونتاج', 'قص', 'قطع', 'دمج', 'تشغيل', 'مقطع', 'مقاطع',
  'video', 'videos', 'montage', 'clip', 'clips', 'subtitle', 'subtitles', 'trim', 'render',
];

function containsTerm(text: string, term: string): boolean {
  // Arabic roots are matched by substring on purpose («برمج» inside «برمجة»),
  // but Latin terms must be whole words or «react» would match inside
  // «reaction» and make a market question look like a coding request.
  if (/[\u0600-\u06FF]/.test(term)) return text.includes(term);
  return hasWholeWord(text, term);
}

function notCodingContext(text: string): boolean {
  return !CODING_TERMS.some((term) => containsTerm(text, term));
}

function notVideoContext(text: string): boolean {
  return !VIDEO_TERMS.some((term) => containsTerm(text, term));
}

function notCodingOrVideoContext(text: string): boolean {
  return notCodingContext(text) && notVideoContext(text);
}

/* ------------------------------ Trigger table ------------------------------ */

/**
 * Ordered trigger table. Order matters only for diagnostics (first match
 * wins); classification happens separately so that intent precedence is
 * explicit rather than accidental.
 */
const TRIGGERS: TriggerRule[] = [
  /* ------------- New simulation / explicit analysis request ------------- */
  {
    family: 'explicit_analysis',
    kind: 'full_application_analysis',
    when: notCodingOrVideoContext,
    phrases: [
      // MSA: "simulate", "run a simulation", "start a simulation".
      'محاكاة', 'حاكي', 'اعمل محاكاة', 'اقم بمحاكاة', 'ابدأ محاكاة', 'ابدا محاكاة',
      'شغل محاكاة', 'افتح محاكاة', 'نفذ محاكاة', 'نفيذ محاكاة', 'اجراء محاكاة',
      'اجرا محاكاة', 'محاكاة السوق', 'محاكاة العملاء', 'محاكاة المستخدمين',
      // Swarm intelligence phrasing.
      'ذكاء السرب', 'ذكاء سرب', 'تحليل السرب', 'تحليل سرب',
      'تحليل التطبيق', 'تحليل تطبيق', 'تحليل المنتج', 'تحليل السوق', 'حلل التطبيق',
      'حلل تطبيق', 'حلل المنتج', 'حلل السوق', 'احلل التطبيق', 'ادرس السوق', 'افحص السوق',
      'اعمل تحليل', 'اقم بتحليل', 'شغل تحليل', 'حلل السوق والعملاء',
      // Gulf: "simulate the market / customers / their reaction".
      'حاكي السوق', 'حاكي العملاء', 'حاكي رده فعل العملاء', 'حاكي رد فعل العملاء',
      'حاكي السوق والعملاء', 'حاكي المستخدمين', 'حاكي سلوك العملاء',
      // Gulf/MSA: "predict the customers' reaction".
      'توقع رده فعل العملاء', 'توقع ردة فعل العملاء', 'توقع رد فعل العملاء',
      'توقع رده فعل المستخدمين', 'توقع ردة فعل المستخدمين', 'توقع سلوك العملاء',
      'توقع قرارات العملاء', 'نوقع رده فعل العملاء', 'نوقع ردة فعل العملاء',
      // Market testing / stress-testing the offer.
      'اختبر السوق', 'اختبر السوق', 'اختبار السوق', 'اختبر خطه التسويق',
      'اختبر فكره المنتج', 'اختبر المنتج', 'جرب السوق', 'دراسه السوق', 'دراسة السوق',
      'فهم السوق', 'استكشف السوق', 'ادرس المنافسين', 'حلل المنافسين',
      'شوف رده فعل السوق', 'شوف رد فعل السوق', 'ورني رده فعل العملاء',
      // English.
      'mirofish', 'swarm simulation', 'swarm intelligence', 'simulate the market',
      'simulate customers', 'simulate users', 'simulate the audience', 'simulate the product',
      'simulate the app', 'simulate the application', 'market simulation', 'market test',
      'market testing', 'predict customer reaction', 'predict customer response',
      'predict user reaction', 'predict market reaction', 'predict reaction of customers',
      'predict reaction of users', 'predict reaction', 'forecast customer reaction',
      'analyze the market', 'analyze the app', 'analyze the application',
      'study the market', 'stress test the market',
    ],
    patterns: [
      /\bswarm\s+(?:simulation|intelligence|analysis)\b/i,
      /\bsimulate\s+(?:the\s+)?(?:market|customers|users|audience|product|app|application)\b/i,
      /\bpredict\s+(?:the\s+)?(?:market|customer|user|audience)\s+(?:reaction|response|behavior|behaviour)\b/i,
      /\bforecast\s+(?:the\s+)?(?:market|customer|user)\b/i,
      /\bwhat\s+will\s+happen\s+(?:if|when)\b/i,
    ],
  },

  /* ------------------------- What-if / counterfactual ------------------------- */
  {
    family: 'what_if',
    kind: 'what_if_injection',
    when: notCodingOrVideoContext,
    phrases: [
      // Gulf / MSA: "what if we raise the price".
      'ماذا لو', 'وش بيصير لو', 'ايش بيصير لو', 'وش صار لو', 'ايش صار لو', 'ماذا حصل لو',
      'وش بيحصل لو', 'ايش بيحصل لو', 'ماذا سيحدث لو', 'لو حصل', 'لو رفع', 'لو رفعنا',
      'لو ارتفع', 'لو انخفض', 'لو زاد', 'لو قل', 'لو تغي', 'لو غي', 'لو اضف', 'لو اضفنا',
      'لو اضفت', 'لو طرح', 'لو طرحنا', 'لو اوقف', 'لو وقف', 'لو وقفنا', 'لو انطلق',
      'لو انطلقنا', 'لو افتتح', 'لو افتتحنا', 'لو قللت', 'لو زدت', 'لو غيرنا', 'لو ضرب',
      'لو خفضا', 'لو اقفلنا', 'لو طلعنا', 'لو قلبنا',
      // MSA: "suppose that", "imagine if".
      'افترض ان', 'افترض انه', 'لو افترضنا', 'بفرض ان', 'تخيل لو', 'تخيل ان',
      'ماذا لو تغير', 'ماذا لو تغيير',
    ],
    patterns: [
      /\bwhat\s+if\b/i,
      /\bwhat\s+would\s+happen\s+if\b/i,
      /\bwhat\s+will\s+happen\s+if\b/i,
      /\bwhat\s+happens\s+if\b/i,
      /\bsuppose\s+(?:that|we)\b/i,
      /\bin\s+the\s+event\s+(?:that|of)\b/i,
      /\bcounterfactual\b/i,
      /\binject\s+(?:a\s+)?variable\b/i,
      /\bif\s+we\s+(?:raise|lower|change|add|remove|launch|stop|double|halve|increase|decrease|drop)\b/i,
      /\bchange\s+(?:the\s+)?(?:price|rate|traffic|plan|feature|variable)\b/i,
    ],
  },

  /* ----------------------------- Agent interview ----------------------------- */
  {
    family: 'agent_interview',
    kind: 'agent_interview',
    when: notCodingOrVideoContext,
    phrases: [
      // Arabic: "interview the agents", "ask the security agent".
      'قابل الوكلاء', 'قابل وكلاء', 'قابل الوكيل', 'قابل وكيل', 'اسأل الوكلاء', 'اسال الوكلاء',
      'اسأل الوكيل', 'اسال الوكيل', 'اسأل وكيل الأمان', 'اسال وكيل الامان', 'اسأل وكيل الامان',
      'اسأل مستخدم', 'اسال مستخدم', 'اسأل المستخدمين', 'اسال المستخدمين', 'اسأل العميل',
      'اسال العميل', 'ما رأي الوكلاء', 'ما راي الوكلاء', 'رأي الوكلاء', 'راي الوكلاء',
      'اراء الوكلاء', 'اسأل الفريق', 'اسال الفريق', 'حاور الوكلاء', 'حاور وكلاء',
      'كلمني الوكلاء', 'اسأل المشتري', 'اسال المشتري', 'اسأل جمهور التطبيق',
      'اسال جمهور التطبيق', 'اسأل جمهور التطبيق', 'شوف راي الوكلاء', 'شوف رأي الوكلاء',
      'اختبر وكيل', 'حاكي وكيل', 'اسأل العميل المحتمل', 'اسال العميل المحتمل',
    ],
    patterns: [
      /\binterview\s+(?:the\s+)?(?:agent|agents|user|users|security|auditor|developer|power\s+user)\b/i,
      /\bask\s+(?:the\s+)?(?:agent|agents|security|auditor|developer|user)\b/i,
      /\bwhat\s+(?:do|does)\s+(?:the\s+)?agents?\s+think\b/i,
      /\btalk\s+to\s+(?:the\s+)?agents?\b/i,
    ],
  },

  /* -------------------------------- Follow-up -------------------------------- */
  {
    family: 'session_follow_up',
    kind: 'follow_up',
    when: notCodingOrVideoContext,
    phrases: [
      // Arabic session continuations.
      'طبق توصيات السرب', 'طبق توصيات سرب', 'طبق توصيه', 'اعقد جلسه نقاش', 'اعقد جلسة نقاش',
      'جلسه نقاش', 'جلسة نقاش', 'طاوله مستديره', 'طاولة مستديرة', 'حول نتائج المحاكاة',
      'حول نتائج المحاكاه', 'اعمل برزنتيشن', 'حول التقرير', 'اختبر صمود', 'سيناريو الكارثه',
      'سيناريو الكارثة', 'وضع الفوضى', 'وضع الفوضي', 'حاكي دخول منافس', 'دخول منافس',
      'ولد اختبارات', 'ارجع الي جوله', 'ارجع الى جولة', 'ارجع ل جولة', 'عد الي جولة',
      'افضل خطه تسعير', 'أفضل خطة تسعير', 'محاكاة التسعير', 'محاكاه التسعير', 'ذاكرة السرب',
      'بمشاريعي السابقه', 'بمشاريعي السابقة', 'قارن بين مسارين', 'فرع الف', 'فرع A',
      'قارن مسارين', 'اختبر الفريق الاحمر', 'فريق احمر وازرق', 'حملة اطلاق', 'انتشار فيروسي',
      'ملخص صوتي', 'بودكاست', 'توام رقمي', 'انذار مبكر',
      // Export/report conversion (the verb «حول» is required so this does not
      // collide with a plain new-simulation request).
      'حول النتائج الي عرض', 'حول النتائج إلى عرض', 'حول التقرير الي عرض', 'حول التقرير إلى عرض',
      'حول النتائج الي برزنتيشن', 'حول النتائج إلى برزنتيشن', 'حول التقرير الي برزنتيشن',
      'حول التقرير إلى برزنتيشن', 'حول النتائج الي شرائح', 'حول النتائج إلى شرائح',
      'حول التقرير الي شرائح', 'حول التقرير إلى شرائح', 'حول النتائج الي سلايدات',
      'حول النتائج إلى سلايدات', 'حول التقرير الي سلايدات', 'حول التقرير إلى سلايدات',
      'حول النتائج الي pdf', 'حول النتائج إلى pdf', 'حول التقرير الي pdf', 'حول التقرير إلى pdf',
      'اعمل برزنتيشن من التقرير', 'اعمل برزنتيشن من المحاكاة', 'اعمل عرض من التقرير',
      'اعمل عرض من المحاكاة', 'صدر التقرير الي عرض', 'صدر التقرير إلى عرض', 'صدر النتائج الي عرض',
      'صدر النتائج إلى عرض', 'صدر التقرير الي شرائح', 'صدر التقرير إلى شرائح',
      'اصنع عرض من التقرير', 'اصنع عرض من المحاكاة',
      // Multi-region / cultural fit.
      'تعدد الثقافات', 'توافق الاسواق', 'توافق الأسواق', 'محاكاة الاسواق العالميه',
      'محاكاة الأسواق العالمية', 'multi region', 'cultural fit', 'localization simulat',
      // Compliance / regulatory.
      'امتثال التطبيق', 'امتثال تطبيق', 'الامتثال القانوني', 'قوانين الخصوصيه',
      'قوانين الخصوصية', 'حماية البيانات الشخصيه', 'حماية البيانات الشخصية',
      'regulatory compliance', 'app store compliance',
      // Viral / GTM.
      'حملة اطلاق', 'حملة إطلاق', 'حملة تسويقيه', 'حملة تسويقية', 'انتشار فيروسي',
      'viral campaign', 'viral launch', 'go to market', 'influencer cascade',
      // Red/blue wargame.
      'فريق احمر', 'فريق أحمر', 'فريق ازرق', 'فريق أزرق', 'مواجهه امنيه', 'مواجهة أمنية',
      'red team', 'blue team', 'cyber wargame',
      // Swarm-guided app synthesis.
      'ابن التطبيق بناء', 'ابن تطبيق بناء', 'ابني التطبيق بناء', 'ابني تطبيق بناء',
      'build app from swarm', 'swarm guided app',
      // Podcast / voice briefing.
      'ملخص صوتي', 'بودكاست', 'تقرير صوتي', 'اذاعي', 'إذاعي',
      'swarm podcast', 'voice briefing', 'audio summary',
      // MCTS / causal.
      'شجره الاحتمالات', 'شجرة الاحتمالات', 'مونت كارلو', 'الاستدلال السببي',
      'احتمالات المستقبل', 'mcts', 'monte carlo', 'causal bayesian', 'causal swarm',
      // Digital twin / early warning.
      'التوام الرقمي', 'التوأم الرقمي', 'توام رقمي', 'توأم رقمي', 'تنبؤ بالاعطال',
      'تنبؤ بالأعطال', 'انذار مبكر', 'إنذار مبكر', 'digital twin', 'anomaly predictor',
      'early warning',
      // Darwinian / NAS.
      'التطور الجيني', 'البحث المعماري التطوري', 'دارويني', 'افضل بنيه معماريه بالتطور',
      'أفضل بنية معمارية بالتطور', 'swarm nas', 'evolutionary architecture',
      'darwinian search', 'genetic architecture',
      // Formal verification.
      'الاثبات الرياضي', 'الإثبات الرياضي', 'الفحص الرمزي', 'براهين رسميه', 'براهين رسمية',
      'سلامة منطق الاعمال', 'سلامة منطق الأعمال', 'formal verification',
      'symbolic invariant', 'formal proof',
      // SLA negotiation.
      'سرب التفاوض', 'عقود مستوى الخدمة', 'تفاوض sla', 'sla negotiation', 'contract negotiation',
      // 3D command center.
      'غرفة القياده ثلاثيه', 'غرفة القيادة ثلاثية', 'مركز القياده الفضائي',
      'مركز القيادة الفضائي', 'شبكة السرب ثلاثيه', 'شبكة السرب ثلاثية',
      '3d spatial swarm', '3d command center', 'spatial swarm',
    ],
    patterns: [
      /\bapply\s+swarm\s+recommendations\b/i,
      /\broundtable\s+debate\b/i,
      /\bagent\s+debate\b/i,
      /\bexport\s+(?:swarm|simulation|report)\s+to\s+(?:slides|presentation|deck|pdf)\b/i,
      /\bchaos\s*(?:mode|monkey|simulation)\b/i,
      /\bcascading\s+failure\b/i,
      /\bfault\s+injection\b/i,
      /\bgenerate\s+tests\s+from\s+swarm\b/i,
      /\bswarm\s+test\s+suite\b/i,
      /\brewind\s+to\s+round\b/i,
      /\btime[- ]?travel\b/i,
      /\bcounterfactual\s+replay\b/i,
      /\bpricing\s+simulation\b/i,
      /\btokenomics\b/i,
      /\bcross[- ]?project\s+swarm\s+memory\b/i,
      /\bcompare\s+with\s+previous\s+projects\b/i,
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Public API: trigger matching                                              */
/* -------------------------------------------------------------------------- */

/**
 * Return the first matching trigger family for a message, or null when the
 * message is unrelated to MiroFish. Matching happens on the canonical form so
 * Arabic spelling variants and diacritics do not matter.
 */
export function matchMirofishTrigger(raw: string): MirofishTriggerMatch | null {
  const text = canonical(raw);
  if (!text) return null;
  for (const rule of TRIGGERS) {
    if (rule.when && !rule.when(text)) continue;
    for (const phrase of rule.phrases) {
      if (hasWholeWord(text, phrase)) return { kind: rule.kind, matched: rule.family, text };
    }
    for (const pattern of rule.patterns ?? []) {
      if (pattern.test(text)) return { kind: rule.kind, matched: rule.family, text };
    }
  }
  return null;
}

/** True when a conversational chat message should route into MiroFish. */
export function shouldTriggerMirofishIntent(raw: string): boolean {
  return matchMirofishTrigger(raw) !== null;
}

/** Classify a message into one of the routing intents (never null). */
export function classifyMirofishIntent(raw: string): MirofishIntentKind {
  return matchMirofishTrigger(raw)?.kind ?? 'unrelated';
}

/**
 * Classify with an explicit "is there an active session" flag so the caller can
 * tell a follow-up what-if from a brand-new simulation. Without an active
 * session, a what-if or interview request is treated as a fresh simulation.
 */
export function classifyWithSession(
  raw: string,
  hasActiveSession: boolean,
): MirofishIntentKind {
  const kind = classifyMirofishIntent(raw);
  if (!hasActiveSession && (kind === 'what_if_injection' || kind === 'agent_interview')) {
    return 'full_application_analysis';
  }
  return kind;
}

/* -------------------------------------------------------------------------- */
/* Variable + location extraction                                             */
/* -------------------------------------------------------------------------- */

export interface ExtractedVariable {
  /** The variable the user changed, e.g. "price", "rate", "traffic". */
  name: string;
  /** Free-form value as the user wrote it, e.g. "1300", "10x", "twice". */
  value: string;
}

export interface ExtractedLocation {
  city: string | null;
  country: string | null;
  region: string | null;
}

export interface ExtractedSettings {
  variables: ExtractedVariable[];
  location: ExtractedLocation;
}

/**
 * Map an Arabic or English variable noun to a canonical knob name. Longer
 * phrases are listed first so «سعر المنتج» wins over «سعر».
 */
const VARIABLE_NAME_GROUPS: Array<{ name: string; phrases: string[] }> = [
  { name: 'price', phrases: ['سعر المنتج', 'سعر الخدمه', 'سعر الخدمة', 'سعر الباقه', 'سعر الباقة', 'الاسعار', 'الأسعار', 'التسعير', 'سعر', 'price', 'pricing'] },
  { name: 'rate', phrases: ['العموله', 'العمولة', 'الرسوم', 'رسوم', 'نسبه', 'نسبة', 'معدل', 'rate', 'fee'] },
  { name: 'traffic', phrases: ['الترافيك', 'الترافك', 'الزيارات', 'زيارات', 'الحمل', 'ضغط', 'traffic', 'visits'] },
  { name: 'plan', phrases: ['الباقه', 'الباقة', 'الاشتراكات', 'الاشتراك', 'خطه', 'خطّة', 'خطة', 'plan', 'subscription'] },
  { name: 'budget', phrases: ['المصاريف', 'ميزانيه', 'ميزانية', 'التكلفه', 'التكلفة', 'budget', 'cost'] },
  { name: 'customers', phrases: ['العملاء', 'عملاء', 'زبائن', 'العميل', 'عميل', 'customers', 'customer'] },
  { name: 'conversion', phrases: ['معدل التحويل', 'معدل التحول', 'التحويل', 'conversion'] },
  { name: 'duration', phrases: ['المده', 'مدة', 'الزمن', 'زمن', 'duration'] },
  { name: 'agents', phrases: ['عدد الوكلاء', 'الوكلاء', 'وكلاء', 'agents', 'agent'] },
  { name: 'rounds', phrases: ['عدد الجولات', 'الجولات', 'جولات', 'rounds', 'round'] },
];

/** Known cities / countries / regions. Data-driven; not tied to any locale. */
const KNOWN_PLACES: Array<{ name: string; kind: 'city' | 'country' | 'region' }> = [
  // Gulf / MENA
  { name: 'الرياض', kind: 'city' }, { name: 'جده', kind: 'city' }, { name: 'جدة', kind: 'city' },
  { name: 'الدمام', kind: 'city' }, { name: 'مكه', kind: 'city' }, { name: 'مكة', kind: 'city' },
  { name: 'المدينه', kind: 'city' }, { name: 'المدينة', kind: 'city' }, { name: 'الخبر', kind: 'city' },
  { name: 'الدوحه', kind: 'city' }, { name: 'الدوحة', kind: 'city' }, { name: 'دبي', kind: 'city' },
  { name: 'ابوظبي', kind: 'city' }, { name: 'أبوظبي', kind: 'city' }, { name: 'الشارقه', kind: 'city' },
  { name: 'الشارقة', kind: 'city' }, { name: 'المنامه', kind: 'city' }, { name: 'المنامة', kind: 'city' },
  { name: 'مسقط', kind: 'city' }, { name: 'الكويت', kind: 'city' }, { name: 'عمان', kind: 'city' },
  { name: 'السعوديه', kind: 'country' }, { name: 'السعودية', kind: 'country' },
  { name: 'قطر', kind: 'country' }, { name: 'الامارات', kind: 'country' }, { name: 'الإمارات', kind: 'country' },
  { name: 'البحرين', kind: 'country' }, { name: 'عمان', kind: 'country' }, { name: 'الكويت', kind: 'country' },
  { name: 'مصر', kind: 'country' }, { name: 'الاردن', kind: 'country' }, { name: 'الأردن', kind: 'country' },
  { name: 'العراق', kind: 'country' }, { name: 'المغرب', kind: 'country' }, { name: 'تونس', kind: 'country' },
  { name: 'لبنان', kind: 'country' }, { name: 'سوريا', kind: 'country' }, { name: 'اليمن', kind: 'country' },
  { name: 'ليبيا', kind: 'country' }, { name: 'الجزائر', kind: 'country' }, { name: 'السودان', kind: 'country' },
  { name: 'الخليج', kind: 'region' }, { name: 'الخليج العربي', kind: 'region' },
  // Europe
  { name: 'berlin', kind: 'city' }, { name: 'munich', kind: 'city' }, { name: 'paris', kind: 'city' },
  { name: 'london', kind: 'city' }, { name: 'amsterdam', kind: 'city' }, { name: 'madrid', kind: 'city' },
  { name: 'rome', kind: 'city' }, { name: 'istanbul', kind: 'city' }, { name: 'lisbon', kind: 'city' },
  { name: 'germany', kind: 'country' }, { name: 'france', kind: 'country' },
  { name: 'united kingdom', kind: 'country' }, { name: 'uk', kind: 'country' },
  { name: 'spain', kind: 'country' }, { name: 'italy', kind: 'country' },
  { name: 'turkiye', kind: 'country' }, { name: 'turkey', kind: 'country' },
  { name: 'netherlands', kind: 'country' }, { name: 'portugal', kind: 'country' },
  // Americas / Asia
  { name: 'new york', kind: 'city' }, { name: 'san francisco', kind: 'city' }, { name: 'tokyo', kind: 'city' },
  { name: 'singapore', kind: 'city' }, { name: 'mumbai', kind: 'city' }, { name: 'shanghai', kind: 'city' },
  { name: 'sao paulo', kind: 'city' }, { name: 'dubai', kind: 'city' },
  { name: 'united states', kind: 'country' }, { name: 'usa', kind: 'country' }, { name: 'us', kind: 'country' },
  { name: 'canada', kind: 'country' }, { name: 'japan', kind: 'country' }, { name: 'india', kind: 'country' },
  { name: 'brazil', kind: 'country' }, { name: 'china', kind: 'country' },
];

/** Prepositions that introduce a location in Arabic and English. */
const LOCATION_PREFIXES = ['في', 'داخل', 'حول', 'عند', 'من', 'الي', 'الى', 'ب', 'في', 'in', 'inside', 'around', 'at', 'for', 'from', 'of'];

/**
 * Extract variable changes from a message. Handles «لو رفعنا السعر 1300»,
 * "if we raise the price to 1300", "price 1300", and a bare «سعر 1300».
 */
export function extractVariables(raw: string): ExtractedVariable[] {
  const text = canonical(raw);
  if (!text) return [];
  const variables: ExtractedVariable[] = [];
  const seen = new Set<string>();

  // Quantity token: digits with optional decimal, optionally followed by a
  // multiplier/percent suffix ("10x", "50%", "2 الف", "1.5k").
  const QUANTITY = '[0-9]+(?:[.,][0-9]+)?(?:\\s*(?:x|ضعف|اضعاف|أضعاف|%|k|m|thousand|million|مليون|ألف|الف))?';

  for (const group of VARIABLE_NAME_GROUPS) {
    for (const phrase of group.phrases) {
      const nameRe = new RegExp(varWord(canonical(phrase)), 'iu');
      if (!nameRe.test(text)) continue;
      // 1) name ... quantity, with optional connector words between them.
      const after = new RegExp(varWord(canonical(phrase)) + '(?:\\s*(?:الي|الى|على|كان|كانت|صبح|صار|لي|ل|ب|بـ|من|to|at|of|=|:|to)\\s*)?\\s*(' + QUANTITY + ')', 'iu');
      let m = text.match(after);
      // 2) quantity ... name (Arabic often puts the number first).
      if (!m) {
        const before = new RegExp('(' + QUANTITY + ')\\s*' + varWord(canonical(phrase)), 'iu');
        m = text.match(before);
        if (m) {
          if (!seen.has(group.name)) {
            seen.add(group.name);
            variables.push({ name: group.name, value: m[1]! });
          }
          break;
        }
        continue;
      }
      if (!seen.has(group.name)) {
        seen.add(group.name);
        variables.push({ name: group.name, value: m[1]! });
      }
      break;
    }
  }
  return variables;
}

/**
 * Extract a location mention from a message. Handles «في الرياض», "in Berlin",
 * "around Dubai", and bare mentions. Returns nulls when nothing matches.
 */
export function extractLocation(raw: string): ExtractedLocation {
  const result: ExtractedLocation = { city: null, country: null, region: null };
  const text = canonical(raw);
  if (!text) return result;

  // Prefer a location introduced by a preposition, then fall back to a bare
  // known place. Longer names first so "united states" beats "us". Patterns
  // are built from the canonical place name («الرياض» -> «رياض») because the
  // text is canonicalized here too, so both spellings collapse to one form.
  const sorted = [...KNOWN_PLACES].sort((a, b) => b.name.length - a.name.length);
  const names = sorted.map((p) => escapeRe(canonical(p.name))).join('|');

  let found: string | null = null;
  for (const prefix of LOCATION_PREFIXES) {
    const re = new RegExp(wholeWord(canonical(prefix)) + '\\s*(' + names + ')', 'iu');
    const m = text.match(re);
    if (m) {
      found = m[1]!.toLowerCase();
      break;
    }
  }
  if (!found) {
    // Note: `names` is inserted raw (not through escapeRe) so the `|`
    // alternation survives; place names contain no regex metacharacters.
    const bare = new RegExp('(?:(?<![\\p{L}\\p{N}])(' + names + ')(?![\\p{L}\\p{N}]))', 'iu');
    const m = text.match(bare);
    if (m) found = m[1]!.toLowerCase();
  }

  if (!found) return result;
  const place = sorted.find(
    (p) =>
      p.name.toLowerCase() === found ||
      // «الرياض» canonicalizes to «رياض», so also compare article-stripped
      // place names («السعر» -> «سعر» is the same rule used for variables).
      stripArabicDefiniteArticle(p.name).toLowerCase() === found,
  );
  if (!place) return result;
  // Regions («الخليج») are meaningful without a preposition, but cities and
  // countries are far too common as ordinary nouns, so only accept them when
  // a preposition explicitly introduced the location.
  if (place.kind === 'city' || place.kind === 'country') {
    const introduced = LOCATION_PREFIXES.some((prefix) =>
      new RegExp(wholeWord(canonical(prefix)) + '\\s*' + escapeRe(canonical(place.name)), 'iu').test(
        canonical(raw),
      ),
    );
    if (!introduced) return result;
  }
  if (place.kind === 'city') result.city = place.name;
  else if (place.kind === 'country') result.country = place.name;
  else result.region = place.name;
  return result;
}

/** Extract both variables and location from a message in one pass. */
export function extractMirofishSettings(raw: string): ExtractedSettings {
  return { variables: extractVariables(raw), location: extractLocation(raw) };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The canonical searchable text for a trigger pattern (exported for tests). */
export function canonicalText(raw: string): string {
  return canonical(raw);
}
