import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalLabel, foldDigits, legalTerms, orthographicForm, parseLabel, parseOrdinal, presentationForm, renderLabelAr } from "../normalize.js";

test("foldDigits maps Arabic-Indic and Persian digits one-to-one", () => {
  assert.equal(foldDigits("المادة ١٧١ و۱۲"), "المادة 171 و12");
  assert.equal(foldDigits("١٢٣").length, 3);
});

test("presentationForm removes harakat/tatweel, unifies quotes and bracketed numbers, keeps letters", () => {
  assert.equal(presentationForm("«العَقْدُ» شريعـة المادة (٣)"), presentationForm("\"العقد\" شريعة المادة 3"));
  assert.equal(presentationForm("طبقاً"), presentationForm("طبقا"), "tanween is a mark, not a letter");
  assert.notEqual(presentationForm("النية"), presentationForm("النيه"), "ta marbuta vs ha is a letter difference at presentation tier");
});

test("orthographicForm folds hamza, alef maqsura and ta marbuta", () => {
  assert.equal(orthographicForm("المسؤولية الأولى"), orthographicForm("المسوولية الاولي"));
  assert.equal(orthographicForm("النية"), orthographicForm("النيه"));
});

test("parseOrdinal handles feminine ordinals and compounds", () => {
  assert.equal(parseOrdinal("الأولى"), 1);
  assert.equal(parseOrdinal("الخمسون"), 50);
  assert.equal(parseOrdinal("الحادية والخمسون"), 51);
  assert.equal(parseOrdinal("السابقة"), null);
});

test("parseLabel canonicalizes digits, bis forms and ordinal words", () => {
  assert.deepEqual(parseLabel("١٧١"), { label: "171", ordinal: 171 });
  assert.equal(parseLabel("115 مكرراً")?.label, "115bis");
  assert.equal(parseLabel("115 مكرراً (4)")?.label, "115bis4");
  assert.equal(parseLabel("الخمسون")?.label, "50");
  assert.equal(parseLabel("abc"), null);
  assert.equal(canonicalLabel(3, true), "3bis");
  assert.equal(renderLabelAr("115bis4"), "115 مكرراً (4)");
});

test("legalTerms strips light prefixes and drops stop words", () => {
  const terms = legalTerms("والتعويض الاتفاقي في العقد");
  assert.ok(terms.includes(legalTerms("تعويض")[0] ?? "x"));
  assert.ok(!terms.includes("في"));
});
