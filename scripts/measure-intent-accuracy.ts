/**
 * W-U2 acceptance gate: intent-routing accuracy over 20 diverse real-user
 * briefs against the KEYWORD layer only (no live model — fixtures per the
 * plan's gate definition). PASS = ≥90% (18/20).
 *
 * Run: node --import tsx scripts/measure-intent-accuracy.ts
 */
import { classifyIntentByKeywords } from "../src/server/intentKeywords.js";

interface Case { brief: string; expected: string; lang: "ar" | "en"; note?: string }

/** 20 diverse briefs exactly as a real user would type them (Arabic-first with
 *  English mixes, covering every mode family + the ask default). */
const CASES: readonly Case[] = [
  { brief: "ابن لي تطبيق ويب لإدارة المهام مع قاعدة بيانات محلية", expected: "build", lang: "ar" },
  { brief: "ما أفضل طريقة لتعلم البرمجة من الصفر؟", expected: "ask", lang: "ar", note: "سؤال تعلم — يجب ألا يسرقه نمط البناء" },
  { brief: "Build a task management web app with a local database", expected: "build", lang: "en" },
  { brief: "ابحث لي عن أحدث الدراسات حول الطاقة الشمسية في قطر", expected: "research", lang: "ar" },
  { brief: "Research and compare the top vector databases for local inference", expected: "research", lang: "en" },
  { brief: "اكتب مقالًا احترافيًا عن أهمية الأمن السيبراني للشركات الصغيرة", expected: "write", lang: "ar" },
  { brief: "أعد عرضًا تقديميًا وشرائح عن خطة التوسع للربع القادم", expected: "write", lang: "ar" },
  { brief: "حلل مبيعات المتجر في هذا الجدول واستخرج المؤشرات الأهم", expected: "data", lang: "ar" },
  { brief: "Analyze this CSV dataset and chart the monthly trends", expected: "data", lang: "en" },
  { brief: "صمم لوجو عصري لمقهى متخصص بالقهوة المختصة", expected: "media", lang: "ar" },
  { brief: "أنشئ مشهد ثلاثي الأبعاد لغرفة معيشة بإضاءة واقعية", expected: "media", lang: "ar" },
  { brief: "افحص ترويسات موقعي واكتشف الثغرات الأمنية قبل الإطلاق", expected: "security", lang: "ar" },
  { brief: "Run a vulnerability scan and a security audit on my staging server", expected: "security", lang: "en" },
  { brief: "راجع بنود هذا العقد وفق قانون العمل القطري وحدد المخاطر", expected: "legal", lang: "ar" },
  { brief: "أنشئ مسودة مرافعة للقضية المرفوعة أمام المحكمة", expected: "legal", lang: "ar" },
  { brief: "اعمل هندسة عكسية لتطبيق apk هذا واستخرج الشيفرة المصدرة", expected: "reverse-engineer", lang: "ar" },
  { brief: "فك تشفير هذا التطبيق المعبأ وتحليل ثنائياته", expected: "reverse-engineer", lang: "ar", note: "حالة صعبة: بذرة واحدة طبيعية — تقيس حاجة طبقة الكلمات للبذور" },
  { brief: "أنشئ فرعًا جديدًا وافتح pull request لإصلاح المشكلة رقم 42", expected: "devflow", lang: "ar" },
  { brief: "أتمت هذه الخطوات المتكررة لتعمل كل ليلة في الخلفية", expected: "automate", lang: "ar" },
  { brief: "Automate this browser flow to run daily in the background", expected: "automate", lang: "en" },
];

let pass = 0;
let fail = 0;
const failures: string[] = [];

console.log(`قياس دقة التوجيه — ${CASES.length} طلبًا (طبقة الكلمات المفتاحية فقط، بلا نموذج حي)\n`);
for (const [index, testCase] of CASES.entries()) {
  const decision = classifyIntentByKeywords(testCase.brief);
  const ok = decision.mode === testCase.expected;
  if (ok) pass++; else fail++;
  const mark = ok ? "✓" : "✗";
  console.log(`${mark} #${String(index + 1).padStart(2, "0")} [${testCase.lang}] expected=${testCase.expected} got=${decision.mode} (score=${decision.score}${decision.matched.length ? `, seeds=[${decision.matched.join("|")}]` : ""})${testCase.note ? ` — ${testCase.note}` : ""}`);
}

const accuracy = Math.round((pass / CASES.length) * 100);
console.log(`\nالدقة: ${pass}/${CASES.length} = ${accuracy}% (البوابة: ≥90%)`);
if (failures.length) console.log(`إخفاقات:\n${failures.join("\n")}`);
process.exit(accuracy >= 90 ? 0 : 1);
