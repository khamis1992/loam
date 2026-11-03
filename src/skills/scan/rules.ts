// src/skills/scan/rules.ts — Loam skill ruleset (MISSING §6.5 reference; 0 fail across 258 real skills + all 26 Loam skills on the box)
import type { ScanRule } from "./types.js";

/** Loam skill ruleset. Written for Loam; the categories follow skillkit's taxonomy (Apache-2.0), patterns are new. */
export const RULESET_VERSION = "loam-skillscan-1";

export const RULES: ScanRule[] = [
  // ---- prompt injection (prose) ----
  { id: "LS-PI01", category: "prompt_injection", severity: "critical", scope: "prose",
    patterns: [/\b(ignore|disregard|forget|override)\s+(all\s+|any\s+)?(the\s+)?(previous|prior|above|earlier|system)\s+(instructions?|prompts?|rules|directives)\b/i,
               /(تجاهل|انسَ|انس)\s+(كل|جميع)?\s*(التعليمات|الأوامر|القواعد)\s*(السابقة)?/u],
    title: "Instruction override", titleAr: "محاولة إلغاء التعليمات", remediation: "Remove text that tells the agent to discard its instructions." },
  { id: "LS-PI02", category: "prompt_injection", severity: "high", scope: "any",
    patterns: [/<\|im_start\|>\s*system/i, /\[\/?INST\]/, /<<\/?SYS>>/, /^\s*(system|assistant)\s*:\s*you\s+are\b/im, /<\/?(system|system-prompt)>/i],
    title: "Role or delimiter injection", titleAr: "حقن علامات أدوار النموذج", remediation: "Remove chat-template delimiters and fake role markers." },
  { id: "LS-PI03", category: "prompt_injection", severity: "high", scope: "prose",
    patterns: [/\b(do\s+not|don't|never)\s+(tell|inform|notify|let)\s+the\s+user\s+(know\s+)?(about\s+)?(this\s+(skill|instruction|step|file)|these\s+(instructions|steps)|that\s+you\s+(ran|run|sent|send|read|copied|uploaded|installed)|what\s+you\s+(did|are\s+doing))\b/i,
               /\b(hide|conceal|keep)\s+(this|these\s+(actions|steps|instructions)|it|the\s+(upload|transfer|request))\s+(hidden\s+)?from\s+the\s+user\b/i, /\bwithout\s+the\s+user\s+(knowing|noticing)\b/i,
               /(لا\s+تخبر\s+المستخدم\s+(بهذا|بذلك|بما)|دون\s+علم\s+المستخدم|أخفِ?\s+(هذا|ذلك)\s+عن\s+المستخدم)/u],
    title: "Concealment from the user", titleAr: "إخفاء معلومات عن المستخدم", remediation: "Skills must not ask the agent to hide actions from the user." },
  { id: "LS-PI04", category: "prompt_injection", severity: "high", scope: "prose",
    patterns: [/\b(reveal|print|output|repeat|leak|dump)\s+(your|the)\s+(full\s+)?(system\s+prompt|hidden\s+instructions|initial\s+instructions)\b/i],
    title: "System prompt extraction", titleAr: "استخراج تعليمات النظام", remediation: "Remove requests to disclose the system prompt." },
  { id: "LS-PI05", category: "prompt_injection", severity: "critical", scope: "prose",
    patterns: [/\b(disable|bypass|turn\s+off|ignore|circumvent)\s+(all\s+|the\s+|any\s+)?(safety|guardrails?|content\s+polic(y|ies)|restrictions|approval\s+gates?|sandbox)\b/i],
    title: "Safety or approval bypass", titleAr: "تعطيل الحماية أو الموافقات", remediation: "Remove instructions that disable safeguards." },
  { id: "LS-PI06", category: "prompt_injection", severity: "medium", scope: "any", htmlComments: true,
    patterns: [/\b(ignore|instruction|system\s+prompt|you\s+must|execute|run\s+this|do\s+not\s+tell)\b/i, /(تجاهل|التعليمات|نفّ?ذ|لا\s+تخبر)/u],
    title: "Instructions hidden in an HTML comment", titleAr: "تعليمات مخفية داخل تعليق HTML", remediation: "Move instructions into visible text or delete them." },
  // ---- tool / autonomy abuse (prose) ----
  { id: "LS-TA01", category: "tool_abuse", severity: "medium", scope: "prose",
    patterns: [/\b(do\s+not|don't|never)\s+ask\s+(the\s+user\s+)?(for\s+)?(confirmation|approval|permission|consent)\b/i,
               /\b(proceed|act|execute|run|install|delete|send|upload|continue|pay|purchase)\b(\s+\S+){0,3}\s+without\s+(asking|requesting|waiting\s+for|seeking)\s+(the\s+user'?s?\s+|for\s+)?(confirmation|approval|permission|consent)\b/i,
               /(نفّ?ذ|تابع|احذف|أرسل|ثبّ?ت)(\s+\S+){0,3}\s+(دون|بدون)\s+(طلب\s+)?(موافقة|إذن|تأكيد)\s+المستخدم/u],
    title: "Bypasses user confirmation", titleAr: "تجاوز موافقة المستخدم", remediation: "Keep Loam's approval flow; remove 'without confirmation' instructions." },
  { id: "LS-TA02", category: "tool_abuse", severity: "medium", scope: "prose",
    patterns: [/\b(when|while)\s+the\s+user\s+is\s+(away|idle|asleep|not\s+(looking|watching|present))\b/i],
    title: "Stealth execution", titleAr: "تنفيذ في غياب المستخدم", remediation: "Remove instructions tied to user absence." },
  { id: "LS-TA03", category: "tool_abuse", severity: "medium", scope: "prose",
    patterns: [/\b(override|replace|shadow|redefine)\s+the\s+(built-?in\s+)?[\w-]+\s+tool\b/i],
    title: "Tool shadowing", titleAr: "استبدال أداة مدمجة", remediation: "Skills should not redefine built-in tools." },
  // ---- exfiltration ----
  { id: "LS-DE01", category: "exfiltration", severity: "high", scope: "any",
    patterns: [/discord(app)?\.com\/api\/webhooks\/\d{15,}\/[\w-]{20,}/i, /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{12,}/, /api\.telegram\.org\/bot\d{6,}:[\w-]{30,}/],
    title: "Chat webhook endpoint", titleAr: "رابط Webhook لتطبيق محادثة", remediation: "Remove hard-coded webhook endpoints." },
  { id: "LS-DE02", category: "exfiltration", severity: "high", scope: "any",
    patterns: [/\b[\w-]+\.(ngrok\.io|ngrok-free\.app|ngrok\.app|trycloudflare\.com|serveo\.net|loca\.lt|pipedream\.net)\b/i, /\b(webhook\.site|requestbin\.(com|net)|interact\.sh|oast\.(fun|pro|live))\b/i],
    title: "Tunnel or capture endpoint", titleAr: "رابط نفق أو التقاط بيانات", remediation: "Remove tunnel/capture endpoints." },
  { id: "LS-DE03", category: "exfiltration", severity: "high", scope: "any",
    patterns: [/\b(cat|type|more|Get-Content|gc|readFile(Sync)?|open|cp|copy|scp|base64|xxd|tar|zip|Compress-Archive|curl|Invoke-WebRequest)\b[^\n]{0,200}(~|%USERPROFILE%|\$HOME|\$env:USERPROFILE|\/home\/\w+)[\\/]\.(ssh[\\/](id_|[\w.-]{0,40}_rsa)|aws[\\/]credentials|azure[\\/]|kube[\\/]config|docker[\\/]config\.json)/i, /\\(Google\\Chrome|Microsoft\\Edge)\\User Data\\[^\n]{0,200}(Login Data|Cookies|Local State)/i,
               /\bwallet\.dat\b/i, /\.git-credentials\b/],
    title: "Reads credential stores", titleAr: "قراءة ملفات اعتماد حساسة", remediation: "Skills must not read SSH keys, cloud credentials or browser secrets." },
  { id: "LS-DE04", category: "exfiltration", severity: "info", scope: "code",
    patterns: [/\b(fetch|axios\.(get|post)|requests\.(get|post)|Invoke-WebRequest|Invoke-RestMethod|iwr|curl|wget)\b/],
    title: "Outbound network call", titleAr: "اتصال شبكي خارجي", remediation: "Informational: confirm the destination is expected." },
  // ---- command execution / persistence (code) ----
  { id: "LS-CI01", category: "command_execution", severity: "critical", scope: "code",
    patterns: [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^\n|]{0,200}\|\s*(sh|bash|zsh|iex|Invoke-Expression|python3?|node)\b/i, /\bInvoke-Expression\b|\biex\s*\(/i,
               /\bpowershell(\.exe)?\b[^\n]{0,200}\s-(e|enc|encodedcommand)\s+[A-Za-z0-9+/=]{16,}/i, /\bcertutil(\.exe)?\b[^\n]{0,200}-urlcache\b/i, /\bmshta(\.exe)?\s+https?:/i],
    title: "Download-and-execute", titleAr: "تنزيل وتنفيذ مباشر", remediation: "Never pipe downloaded content into an interpreter." },
  { id: "LS-CI02", category: "command_execution", severity: "high", scope: "code",
    patterns: [/(?<![.\w$])eval\s*\(/, /\bnew\s+Function\s*\(/, /\bshell\s*:\s*true\b/, /\bshell\s*=\s*True\b/, /\bos\.system\s*\(/, /\bexecSync\s*\(\s*`[^`]*\$\{/],
    title: "Dynamic code or shell execution", titleAr: "تنفيذ شيفرة أو أوامر ديناميكياً", remediation: "Use argv arrays and static code paths." },
  { id: "LS-CI03", category: "command_execution", severity: "high", scope: "code",
    patterns: [/\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(\/|~|\$HOME|\*)(\s|$)/i, /\bRemove-Item\b[^\n]{0,200}-Recurse[^\n]{0,200}\b[A-Z]:\\(\s|$|\*)/i, /\bformat\s+[A-Z]:/i, /\bdel\s+\/[sq]\s+\/[sq]\s+[A-Z]:\\/i, /\breg(\.exe)?\s+delete\s+HKLM\b/i, /\bvssadmin\s+delete\s+shadows\b/i],
    title: "Destructive command", titleAr: "أمر تخريبي", remediation: "Remove destructive commands." },
  { id: "LS-CI04", category: "persistence", severity: "high", scope: "code",
    patterns: [/\bschtasks(\.exe)?\s+\/create\b/i, /\breg(\.exe)?\s+add\s+[^\n]{0,200}\\CurrentVersion\\Run(Once)?\b/i, /\\Start Menu\\Programs\\Startup\\/i, /\bNew-Service\b|\bsc(\.exe)?\s+create\b/i, /\bRegister-ScheduledTask\b/i],
    title: "Windows persistence", titleAr: "تثبيت دائم في ويندوز", remediation: "Skills must not register autoruns, services or scheduled tasks." },
  { id: "LS-CI05", category: "persistence", severity: "critical", scope: "any",
    patterns: [/\bSet-MpPreference\b[^\n]{0,200}-Disable/i, /\bAdd-MpPreference\b[^\n]{0,200}-Exclusion/i, /\bnetsh\s+advfirewall\s+set\s+[^\n]{0,200}state\s+off\b/i],
    title: "Security tooling tamper", titleAr: "العبث بأدوات الحماية", remediation: "Remove commands that weaken Defender or the firewall." },
  // ---- obfuscation ----
  { id: "LS-OB01", category: "obfuscation", severity: "medium", scope: "any",
    patterns: [/\b(atob|b64decode|FromBase64String)\s*\(\s*['"`][A-Za-z0-9+/=]{60,}['"`]/, /Buffer\.from\s*\(\s*['"`][A-Za-z0-9+/=]{60,}['"`]\s*,\s*['"`]base64/],
    title: "Encoded payload decoded at runtime", titleAr: "حمولة مشفّرة تُفك وقت التشغيل", remediation: "Ship readable content." },
  { id: "LS-OB02", category: "obfuscation", severity: "medium", scope: "any",
    patterns: [/(\\x[0-9a-fA-F]{2}){12,}/, /(\\u[0-9a-fA-F]{4}){12,}/],
    title: "Long escape sequence", titleAr: "سلسلة محارف مُرمَّزة طويلة", remediation: "Use readable strings." },
  // ---- impersonation ----
  { id: "LS-MF06", category: "manifest", severity: "medium", scope: "prose",
    patterns: [/\b(official|certified|endorsed)\s+(by\s+)?(anthropic|openai|google|microsoft|cursor|xai)\b/i],
    title: "Vendor impersonation", titleAr: "انتحال صفة جهة رسمية", remediation: "Remove unverifiable endorsement claims." },
];

/** Characters that hide or reorder text. ZWNJ (U+200C), LRM/RLM (U+200E/F) and ALM (U+061C) are allowed: Arabic/Persian text uses them. */
export const UNICODE_RULES: Array<{ id: string; severity: "high" | "medium"; re: RegExp; title: string; titleAr: string }> = [
  { id: "LS-UC01", severity: "high", re: /[\u202A-\u202E]/u, title: "Bidirectional override character", titleAr: "محرف تجاوز اتجاه النص" },
  { id: "LS-UC02", severity: "high", re: /[\u{E0000}-\u{E007F}]/u, title: "Unicode tag characters (hidden payload)", titleAr: "محارف وسوم يونيكود مخفية" },
  { id: "LS-UC03", severity: "medium", re: /[\u200B\u2060\u2061-\u2064\u180E]|(?<!^)\uFEFF/u, title: "Zero-width character", titleAr: "محرف بعرض صفري" },
  { id: "LS-UC04", severity: "medium", re: /[\u2066-\u2069]/u, title: "Bidirectional isolate character", titleAr: "محرف عزل اتجاه" },
  { id: "LS-UC05", severity: "medium", re: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u, title: "Control character", titleAr: "محرف تحكم غير مطبوع" },
];
/** U+200D (ZWJ) is legitimate inside emoji sequences; flag it only when not between two pictographs. */
export const ZWJ_OUTSIDE_EMOJI = /(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/u;
