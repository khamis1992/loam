/**
 * Unit tests for the Loam Video engine router (src/tools/videoStudioRouter.ts).
 *
 * Task fc-07. The router decides, for every `video_studio` call, which engine
 * owns the operation — the wasm timeline engine ("film") or the wasm effects
 * engine ("effects") — and degrades an effects operation to the timeline
 * engine's own basic command when the effects engine cannot take it.
 *
 * These tests pin:
 *  - the bilingual classification table (the same operation routes identically
 *    in Arabic and English),
 *  - Arabic normalisation (harakat, tatweel, alef/yaa/taa-marbuta variants),
 *  - action-level routing and the "arguments may promote" rule,
 *  - the transition-vs-effect fallback choice and its notes,
 *  - the plan's degradation contract for both unavailable and unsupported
 *    effects engines,
 *  - the branding contract: no upstream engine name in any router text.
 *
 * No filesystem, editor, network or task stream is touched: the dist probes are
 * overridden with `effectsAvailable` / a temp root.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  DEFAULT_ROUTE,
  EFFECTS_ACTIONS,
  EFFECTS_PHRASES,
  FALLBACK_TRANSITION_PHRASES,
  FILM_PHRASES,
  HINT_ROUTABLE_ACTIONS,
  VideoStudioRouter,
  classifyVideoOperation,
  containsPhrase,
  effectcraftDistDir,
  isEffectcraftDistInstalled,
  isTransitionOperation,
  normalizeOperationText,
  resolveEffectsFallback,
  routeVideoStudioAction,
} from "../../tools/videoStudioRouter.js";
import { VIDEO_STUDIO_ACTIONS, type VideoStudioAction } from "../../tools/videoStudio.js";

/** Upstream engine names: never user-facing (docs/craft-apps.md). */
const UPSTREAM_NAMES = ["filmcraft", "effectcraft", "artcraft"];

let tmpRoot = "";

function tempRoot(): string {
  if (!tmpRoot) tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vsr-root-"));
  return tmpRoot;
}

after(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Router with the effects engine forced available/unavailable. */
function router(effectsAvailable: boolean, root: string = tempRoot()): VideoStudioRouter {
  return new VideoStudioRouter({ root, effectsAvailable });
}

// ---------------------------------------------------------------------------
// Classification table
// ---------------------------------------------------------------------------

/**
 * The acceptance table: one row per operation, in both languages. Every row must
 * classify the same way whichever language it is written in.
 */
const CLASSIFICATION_TABLE: Array<{ op: string; english: string[]; arabic: string[]; route: "film" | "effects" }> = [
  {
    op: "cut / trim / arrange",
    english: ["cut the intro", "trim from 10 to 20 seconds", "reorder the clips", "split at the beat"],
    arabic: ["اقص المقدمة", "قص من ١٠ الى ٢٠ ثانية", "أعد ترتيب المقاطع", "قسّم عند الإيقاع"],
    route: "film",
  },
  {
    op: "speed",
    english: ["slow motion at the end", "speed the clip up 2x", "freeze frame here"],
    arabic: ["حركة بطيئة في النهاية", "زد سرعة المقطع", "جمّد الإطار هنا"],
    route: "film",
  },
  {
    op: "audio / music",
    english: ["add background music", "lower the volume under the voiceover", "mute the first clip"],
    arabic: ["أضف موسيقى خلفية", "اخفض مستوى الصوت", "اكتم الصوت في أول مقطع"],
    route: "film",
  },
  {
    op: "basic transition (timeline-native)",
    english: ["fade in at the start", "a simple crossfade between the two shots", "fade to black"],
    arabic: ["تلاشي في البداية", "تلاشي تدريجي بين المشهدين", "تلاشي إلى الأسود"],
    route: "film",
  },
  {
    op: "basic (static) text",
    english: ["add a static title", "put a caption at the bottom"],
    arabic: ["أضف نص ثابت", "ضع عنوان في الأسفل"],
    route: "film",
  },
  {
    op: "export",
    english: ["export the video", "render it and save video"],
    arabic: ["صدّر الفيديو", "أنشئ الفيديو"],
    route: "film",
  },
  {
    op: "transition beyond a basic dissolve",
    english: ["a wipe between the shots", "zoom transition", "add a glitch transition"],
    arabic: ["انتقال مسح", "انتقال زوم", "انتقال متقطع"],
    route: "effects",
  },
  {
    op: "visual effect",
    english: ["add a glitch effect", "apply a vhs look", "chromatic aberration"],
    arabic: ["أضف تأثير تشويش", "طبّق فلتر", "انحراف لوني"],
    route: "effects",
  },
  {
    op: "colour look",
    english: ["colour grade it cinematic", "apply a teal and orange look", "color correction"],
    arabic: ["صحّح الألوان", "طبّق لوك سينمائي", "درجات ألوان دافئة"],
    route: "effects",
  },
  {
    op: "text / motion animation",
    english: ["animated title at the start", "kinetic typography", "an animated lower third"],
    arabic: ["عنوان متحرك في البداية", "نص متحرك", "تيبوغرافيا متحركة"],
    route: "effects",
  },
  {
    op: "keyframed / custom motion",
    english: ["keyframe the scale", "a ken burns on the photo", "custom motion path"],
    arabic: ["إطار مفتاحي للحجم", "مسار حركي مخصص", "تكبير وتحريك"],
    route: "effects",
  },
];

describe("video operation classification (Arabic + English)", () => {
  for (const row of CLASSIFICATION_TABLE) {
    it(`routes ${row.op} to ${row.route} in both languages`, () => {
      for (const text of row.english) {
        assert.equal(classifyVideoOperation(text), row.route, `English "${text}" must route to ${row.route}`);
      }
      for (const text of row.arabic) {
        assert.equal(classifyVideoOperation(text), row.route, `Arabic "${text}" must route to ${row.route}`);
      }
    });
  }

  it("defaults to the timeline engine when nothing matches", () => {
    assert.equal(DEFAULT_ROUTE, "film");
    for (const text of ["", "   ", "do something with the clip", "شيء ما"]) {
      assert.equal(classifyVideoOperation(text), "film", `"${text}" must default to film`);
    }
  });

  it("is case-insensitive and tolerant of punctuation", () => {
    assert.equal(classifyVideoOperation("Add a GLITCH Transition!"), "effects");
    assert.equal(classifyVideoOperation("EXPORT, please."), "film");
  });

  it("prefers the effects route when a phrase matches both tables", () => {
    // "animated title" is an effects operation even though "title" is basic text:
    // the harder operation must go to the richer engine.
    assert.equal(classifyVideoOperation("animated title"), "effects");
    assert.equal(classifyVideoOperation("نص متحرك"), "effects");
  });
});

// ---------------------------------------------------------------------------
// Normalisation + phrase matching
// ---------------------------------------------------------------------------

describe("Arabic normalisation", () => {
  it("strips harakat and tatweel", () => {
    assert.equal(normalizeOperationText("تَأثيرٌ"), "تاثير");
    assert.equal(normalizeOperationText("انـــتقال"), "انتقال");
  });

  it("unifies alef, yaa, taa-marbuta and hamza spellings", () => {
    assert.equal(normalizeOperationText("إنتقال"), normalizeOperationText("انتقال"));
    assert.equal(normalizeOperationText("تلاشى"), normalizeOperationText("تلاشي"));
    assert.equal(normalizeOperationText("درجة لونية"), normalizeOperationText("درجه لونيه"));
    assert.equal(normalizeOperationText("مؤثر"), normalizeOperationText("موثر"));
  });

  it("matches a diacritic-laden request against a plain table entry", () => {
    assert.equal(classifyVideoOperation("أضِف تَأثير غليتش"), "effects");
    assert.equal(classifyVideoOperation("تلاشِي"), "film");
  });

  it("drops punctuation and collapses whitespace", () => {
    assert.equal(normalizeOperationText("  cut!!  the   intro  "), "cut the intro");
  });
});

describe("phrase matching", () => {
  it("matches Latin phrases on word boundaries", () => {
    assert.equal(containsPhrase(normalizeOperationText("apply a grade"), "grade"), true);
    assert.equal(containsPhrase(normalizeOperationText("upgrade the clip"), "grade"), false);
  });

  it("matches Arabic phrases as substrings, since clitics attach", () => {
    assert.equal(containsPhrase(normalizeOperationText("والتأثير مطلوب"), "تاثير"), true);
    assert.equal(containsPhrase(normalizeOperationText("بالموسيقى"), "موسيقى"), true);
  });

  it("ignores an empty phrase", () => {
    assert.equal(containsPhrase("anything", ""), false);
    assert.equal(containsPhrase("anything", "   "), false);
  });

  it("keeps both tables free of empty entries", () => {
    for (const phrase of [...EFFECTS_PHRASES, ...FILM_PHRASES, ...FALLBACK_TRANSITION_PHRASES]) {
      assert.ok(phrase.trim().length > 0, "a routing table holds an empty phrase");
      assert.equal(normalizeOperationText(phrase).length > 0, true, `phrase "${phrase}" normalises to nothing`);
    }
  });
});

// ---------------------------------------------------------------------------
// Action routing
// ---------------------------------------------------------------------------

describe("action routing", () => {
  it("routes effect_basic to the effects engine and everything else to the timeline", () => {
    assert.deepEqual([...EFFECTS_ACTIONS], ["effect_basic"]);
    for (const action of VIDEO_STUDIO_ACTIONS) {
      const expected = action === "effect_basic" ? "effects" : "film";
      assert.equal(routeVideoStudioAction(action), expected, `${action} must route to ${expected}`);
    }
  });

  it("keeps transition_basic on the timeline engine (a basic dissolve is native)", () => {
    assert.equal(routeVideoStudioAction("transition_basic"), "film");
    assert.equal(HINT_ROUTABLE_ACTIONS.has("transition_basic"), true);
  });

  it("lets an action's arguments promote it, but only for the hint-routable actions", () => {
    const available = router(true);
    // A wipe is beyond a basic dissolve, so it goes to the effects engine.
    assert.equal(available.plan("transition_basic", "wipe").route, "effects");
    // A plain dissolve stays native even though the action is hint-routable.
    assert.equal(available.plan("transition_basic", "fade").route, "film");
    // effect_basic is an effects action by name.
    assert.equal(available.plan("effect_basic", "glitch").route, "effects");
    // An unambiguous action is never rerouted by stray prose.
    assert.equal(available.plan("cut", "make it look like a glitch wipe").route, "film");
    assert.equal(available.plan("add_text", "animated title").route, "film");
    assert.equal(available.plan("state", "add a glitch effect first").route, "film");
    assert.equal(available.plan("raw", "effects.apply").route, "film");
  });

  it("promotes every transition kind the guidance names, not just wipe and glitch", () => {
    // §6.12 and the tool description both name the kinds that need the effects
    // engine ("wipes, zooms, glitches, spins, morphs" / "a wipe/zoom/glitch and
    // similar"). Bare "wipe" and "glitch" reached the effects route only because
    // they are also visual-effect words; the other named kinds did not. Pin the
    // whole documented set so a `type` of "zoom"/"spin"/"morph" is not reported
    // as a native edit.
    const available = router(true);
    for (const type of ["wipe", "zoom", "glitch", "spin", "morph"]) {
      assert.equal(
        available.plan("transition_basic", type).route,
        "effects",
        `a ${type} transition must route to the effects engine`,
      );
    }
    // The one transition the timeline engine owns stays native.
    for (const type of ["dissolve", "fade", "crossfade", "fade to black"]) {
      assert.equal(
        available.plan("transition_basic", type).route,
        "film",
        `a ${type} transition is timeline-native and must stay on the timeline engine`,
      );
    }
  });

  it("classifies free-form text through classify()", () => {
    assert.equal(router(true).classify("wipe"), "effects");
    assert.equal(router(true).classify("cut"), "film");
  });

  it("only the hint-routable actions are consulted for their arguments", () => {
    assert.deepEqual([...HINT_ROUTABLE_ACTIONS].sort(), ["effect_basic", "transition_basic"]);
    for (const action of VIDEO_STUDIO_ACTIONS) {
      if (action === "effect_basic" || action === "transition_basic") continue;
      assert.equal(
        router(true).plan(action, "glitch wipe animated title").route,
        routeVideoStudioAction(action),
        `${action} must ignore its arguments`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Availability probes
// ---------------------------------------------------------------------------

describe("backend availability", () => {
  it("probes the effects dist entry point", () => {
    const root = tempRoot();
    assert.equal(effectcraftDistDir(root), path.join(root, "electron", "effectcraft", "dist"));
    assert.equal(isEffectcraftDistInstalled(root), false);
    assert.equal(router(false, root).isEffectsBackendAvailable(), false);

    fs.mkdirSync(path.join(root, "electron", "effectcraft", "dist"), { recursive: true });
    fs.writeFileSync(path.join(root, "electron", "effectcraft", "dist", "index.html"), "<html></html>");
    assert.equal(isEffectcraftDistInstalled(root), true);
    assert.equal(router(true, root).isEffectsBackendAvailable(), true);
  });

  it("reports the timeline engine dist through the same probe video_studio uses", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loam-vsr-film-"));
    try {
      const r = new VideoStudioRouter({ root, effectsAvailable: false });
      assert.equal(r.isFilmBackendAvailable(), false);
      fs.mkdirSync(path.join(root, "electron", "filmcraft", "dist"), { recursive: true });
      fs.writeFileSync(path.join(root, "electron", "filmcraft", "dist", "index.html"), "<html></html>");
      assert.equal(r.isFilmBackendAvailable(), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("honours the availability override so tests never depend on the dist", () => {
    // The real repo root has no effects dist in this worktree, yet the override
    // must still be able to report it as available.
    assert.equal(new VideoStudioRouter({ effectsAvailable: true }).isEffectsBackendAvailable(), true);
    assert.equal(new VideoStudioRouter({ effectsAvailable: false }).isEffectsBackendAvailable(), false);
  });
});

// ---------------------------------------------------------------------------
// Fallback
// ---------------------------------------------------------------------------

describe("effects fallback", () => {
  it("keeps an explicitly named basic action", () => {
    const transition = resolveEffectsFallback("transition_basic", "anything");
    assert.equal(transition.action, "transition_basic");
    assert.equal(transition.transition, true);

    const effect = resolveEffectsFallback("effect_basic", "wipe");
    assert.equal(effect.action, "effect_basic");
    assert.equal(effect.transition, false);
  });

  it("picks the transition command for a transition request and the effect command otherwise", () => {
    for (const text of ["a wipe between the shots", "انتقال مسح", "a slide transition", "swipe in"]) {
      const fallback = resolveEffectsFallback(undefined, text);
      assert.equal(fallback.action, "transition_basic", `"${text}" must degrade to the basic transition`);
      assert.equal(fallback.transition, true);
    }
    for (const text of ["add a glitch effect", "تأثير تشويش", "colour grade", "keyframe the scale"]) {
      const fallback = resolveEffectsFallback(undefined, text);
      assert.equal(fallback.action, "effect_basic", `"${text}" must degrade to the basic effect`);
      assert.equal(fallback.transition, false);
    }
  });

  it("treats unknown text as a generic effect", () => {
    const fallback = resolveEffectsFallback(undefined, "");
    assert.equal(fallback.action, "effect_basic");
    assert.equal(isTransitionOperation(""), false);
  });

  it("names the engine and the degraded command, and never the upstream project", () => {
    for (const reason of ["effects_backend_unavailable", "effects_engine_unsupported"] as const) {
      for (const action of ["transition_basic", "effect_basic"] as const) {
        const fallback = resolveEffectsFallback(action, "", reason);
        assert.equal(fallback.reason, reason);
        assert.match(fallback.note, /Loam Effects/);
        assert.match(fallback.note, /timeline engine/);
        assert.match(fallback.note, /instead/);
        for (const name of UPSTREAM_NAMES) {
          assert.ok(!fallback.note.toLowerCase().includes(name), `"${name}" leaked into the fallback note`);
        }
      }
    }
  });

  it("says the engine is missing when it is not installed, and unsupported when it is", () => {
    assert.match(resolveEffectsFallback("effect_basic", "").note, /is not installed/);
    assert.match(resolveEffectsFallback("effect_basic", "", "effects_engine_unsupported").note, /cannot apply/);
  });

  it("lists the transition markers used by the fallback", () => {
    for (const phrase of ["transition", "wipe", "spin", "swipe", "انتقال", "مسح", "انزلاق", "دوران"]) {
      assert.ok(FALLBACK_TRANSITION_PHRASES.includes(phrase), `missing fallback marker "${phrase}"`);
    }
    // A bare effect or motion word is not a transition marker: only the timeline
    // engine's transition command is a safe degradation for these. "slide" is
    // excluded because "slide in the text" is text/motion animation, not a wipe.
    for (const phrase of ["glitch", "zoom", "morph", "slide"]) {
      assert.equal(FALLBACK_TRANSITION_PHRASES.includes(phrase), false, `"${phrase}" must not be a fallback marker`);
    }
  });

  it("does not degrade a slide-in motion request to the transition command", () => {
    // "slide in the text" is text/motion animation: it must become effect_basic,
    // while an explicit "slide transition" stays a wipe and becomes the basic
    // transition.
    for (const text of ["slide in the text", "slide the caption up", "slide the title in"]) {
      const fallback = resolveEffectsFallback(undefined, text);
      assert.equal(fallback.action, "effect_basic", `"${text}" must degrade to the basic effect`);
      assert.equal(fallback.transition, false);
    }
    const wipe = resolveEffectsFallback(undefined, "slide transition between the shots");
    assert.equal(wipe.action, "transition_basic");
    assert.equal(wipe.transition, true);
  });
});

// ---------------------------------------------------------------------------
// Plan contract
// ---------------------------------------------------------------------------

describe("route plan", () => {
  it("leaves a timeline operation untouched", () => {
    const plan = router(true).plan("cut", "cut the intro");
    assert.deepEqual(plan, {
      route: "film",
      target: "film",
      action: "cut",
      degraded: false,
      note: "Applied on the Loam Video timeline engine.",
    });
    assert.equal(plan.reason, undefined);
  });

  it("sends an effects operation to the effects engine when it is installed", () => {
    const plan = router(true).plan("effect_basic", "glitch");
    assert.deepEqual(plan, {
      route: "effects",
      target: "effects",
      action: "effect_basic",
      degraded: false,
      note: "Applied with the Loam Effects engine.",
    });
    assert.equal(plan.reason, undefined);
  });

  it("degrades to the timeline engine when the effects engine is unavailable", () => {
    const plan = router(false).plan("effect_basic", "glitch");
    assert.equal(plan.route, "effects", "the operation still belongs to the effects engine");
    assert.equal(plan.target, "film", "but it runs on the timeline engine");
    assert.equal(plan.degraded, true);
    assert.equal(plan.reason, "effects_backend_unavailable");
    assert.equal(plan.action, "effect_basic");
    assert.match(plan.note, /is not installed/);
  });

  it("degrades a promoted transition to the basic transition, keeping the action name", () => {
    const plan = router(false).plan("transition_basic", "wipe");
    assert.equal(plan.route, "effects");
    assert.equal(plan.target, "film");
    assert.equal(plan.degraded, true);
    assert.equal(plan.action, "transition_basic");
    assert.equal(plan.reason, "effects_backend_unavailable");
  });

  it("degrades a promoted transition the effects engine cannot take, even when installed", () => {
    // transition_basic's relay steps are timeline-engine commands, so the effects
    // engine cannot run them: the plan must say so rather than dispatch the wrong
    // command to the wrong engine.
    const plan = router(true).plan("transition_basic", "wipe");
    assert.equal(plan.route, "effects");
    assert.equal(plan.target, "film");
    assert.equal(plan.degraded, true);
    assert.equal(plan.reason, "effects_engine_unsupported");
    assert.equal(plan.action, "transition_basic");
    assert.match(plan.note, /cannot apply/);
  });

  it("keeps effect_basic on the effects engine when it is installed", () => {
    const plan = router(true).plan("effect_basic", "");
    assert.equal(plan.target, "effects");
    assert.equal(plan.degraded, false);
  });

  it("always returns an action the tool can actually run", () => {
    const actions: VideoStudioAction[] = [...VIDEO_STUDIO_ACTIONS];
    for (const effectsAvailable of [true, false]) {
      const r = router(effectsAvailable);
      for (const action of actions) {
        for (const hint of ["", "wipe", "glitch", "fade"]) {
          const plan = r.plan(action, hint);
          assert.ok(actions.includes(plan.action), `${action}/${hint} produced an unknown action`);
          assert.ok(["film", "effects"].includes(plan.target));
          assert.ok(["film", "effects"].includes(plan.route));
          assert.equal(plan.note.trim().length > 0, true, `${action}/${hint} produced an empty note`);
          assert.equal(plan.degraded, plan.reason !== undefined, `${action}/${hint}: degraded and reason must agree`);
        }
      }
    }
  });

  it("never sends a timeline-only action to the effects engine", () => {
    for (const effectsAvailable of [true, false]) {
      const r = router(effectsAvailable);
      for (const action of VIDEO_STUDIO_ACTIONS) {
        if (EFFECTS_ACTIONS.has(action)) continue;
        for (const hint of ["", "glitch", "wipe"]) {
          const plan = r.plan(action, hint);
          if (plan.degraded) continue;
          assert.equal(plan.target, "film", `${action}/${hint} must not target the effects engine`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

describe("branding contract", () => {
  it("never names an upstream engine in a plan note or the tables", () => {
    const texts: string[] = [];
    for (const effectsAvailable of [true, false]) {
      const r = router(effectsAvailable);
      for (const action of VIDEO_STUDIO_ACTIONS) {
        for (const hint of ["", "wipe", "glitch", "fade", "تأثير", "انتقال"]) {
          texts.push(r.plan(action, hint).note);
        }
      }
    }
    texts.push(...EFFECTS_PHRASES, ...FILM_PHRASES, ...FALLBACK_TRANSITION_PHRASES);
    for (const text of texts) {
      for (const name of UPSTREAM_NAMES) {
        assert.ok(!text.toLowerCase().includes(name), `upstream name "${name}" leaked into: ${text}`);
      }
    }
  });

  it("names the two Loam engines in the routing notes", () => {
    assert.match(router(true).plan("cut").note, /Loam Video/);
    assert.match(router(true).plan("effect_basic").note, /Loam Effects/);
  });
});
