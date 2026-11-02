const TASHKEEL = /[\u064B-\u065F\u0670]/g;
const TATWEEL = /\u0640/g;
const ALEF = /[أإآ]/g;
const INDIC = "٠١٢٣٤٥٦٧٨٩";

/** Index-only Arabic and Latin normalisation. Stored content stays unchanged. */
export function normalizeForIndex(input: string): string {
  let text = input.normalize("NFKC");
  text = text.replace(TASHKEEL, "").replace(TATWEEL, "");
  text = text.replace(ALEF, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
  text = text.replace(/[٠-٩]/g, (digit) => String(INDIC.indexOf(digit)));
  return text.toLowerCase();
}

export function tokenize(input: string): string[] {
  const normalized = normalizeForIndex(input);
  return normalized.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

export function detectLang(input: string): "ar" | "en" | "mixed" {
  const arabic = /[\u0600-\u06FF]/.test(input);
  const latin = /[A-Za-z]/.test(input);
  if (arabic && latin) return "mixed";
  if (arabic) return "ar";
  return "en";
}

export function tokenJaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const left = new Set(a);
  const right = new Set(b);
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const GREETINGS = new Set([
  "hi", "hey", "hello", "yo", "thanks", "thank", "you", "ok", "okay",
  "مرحبا", "اهلا", "هلا", "السلام", "شكرا", "تمام", "طيب",
]);

export function isTrivialMessage(text: string): boolean {
  const tokens = tokenize(text);
  if (tokens.length < 3) return true;
  return tokens.every((token) => GREETINGS.has(token));
}
