/**
 * Loam Video routing (fc-07).
 *
 * The user sees ONE product: "Loam Video" in the Workspace panel. Behind it sit
 * two engines — the wasm timeline editor and the wasm effects engine — and
 * `video_studio` is the only agent tool that drives them. This module is the
 * router that decides, for one requested operation, which engine owns it:
 *
 *   film    — cut, trim, arrange, reorder, speed, audio, music, volume, basic
 *             (static) text, a basic dissolve/fade, export.
 *   effects — transitions beyond a basic dissolve, visual effects, colour looks,
 *             text/motion animation, keyframed motion, animated titles.
 *
 * The classifier is keyword-based and deliberately bilingual: the user (and so
 * the model) writes either Arabic (Gulf) or English, and the same operation must
 * route identically in both. Arabic is normalised first (harakat, tatweel,
 * alef/yaa/taa-marbuta/hamza variants) so "تأثير" and "تَأثيرٌ" match.
 *
 * Routing is a *routing* decision, never a capability claim. An `effects`
 * operation never fails just because the effects engine is missing: the plan
 * degrades it to the timeline engine's own `transition_basic` / `effect_basic`
 * command and returns a note saying so, so the tool tells the user plainly that
 * the richer engine is unavailable instead of silently applying a weaker effect.
 *
 * The same tables back the "Video editing" section of the master prompt
 * (`prompts/loam-master.md` §6.12) and `src/agent/videoPrompt.ts`, so the
 * guidance and the code never disagree about which engine owns what.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config.js";
import type { VideoStudioAction } from "./videoStudio.js";

/** Engine that owns a requested operation. */
export type VideoStudioRoute = "film" | "effects";

/** Why an `effects` operation did not run on the effects engine. */
export type VideoStudioDegradeReason = "effects_backend_unavailable" | "effects_engine_unsupported";

// ---------------------------------------------------------------------------
// Backend availability
// ---------------------------------------------------------------------------

/** Absolute path of the vendored effects-engine entry point. */
export function effectcraftDistDir(root: string = ROOT): string {
  return path.join(root, "electron", "effectcraft", "dist");
}

/** True when the vendored effects engine dist is installed (index.html present). */
export function isEffectcraftDistInstalled(root: string = ROOT): boolean {
  return fs.existsSync(path.join(effectcraftDistDir(root), "index.html"));
}

// ---------------------------------------------------------------------------
// Text normalisation + phrase matching
// ---------------------------------------------------------------------------

/**
 * Normalise free text for matching: case-fold, drop Arabic diacritics and
 * tatweel, unify the alef/yaa/taa-marbuta/hamza spellings, keep only letters,
 * digits and spaces. Both languages end up in one comparable form.
 */
export function normalizeOperationText(input: string): string {
  return input
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0649/g, "\u064A")
    .replace(/\u0624/g, "\u0648")
    .replace(/\u0626/g, "\u064A")
    .replace(/\u0629/g, "\u0647")
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the normalised text contains the phrase. Latin phrases are matched
 * on word boundaries (so "grade" does not fire inside "upgrade"); Arabic phrases
 * are matched as substrings, since Arabic clitics ("و", "ال", pronoun suffixes)
 * attach directly to the word and make boundaries unreliable.
 */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalizeOperationText(phrase);
  if (!needle) return false;
  if (/^[\x20-\x7E]+$/.test(needle)) {
    return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text);
  }
  return text.includes(needle);
}

function anyPhrase(text: string, phrases: readonly string[]): boolean {
  return phrases.some((phrase) => containsPhrase(text, phrase));
}

// ---------------------------------------------------------------------------
// The routing tables
// ---------------------------------------------------------------------------

/**
 * Effects phrases: everything the timeline engine does not own. A plain
 * "transition" is NOT listed here — the timeline engine applies a basic
 * dissolve/fade itself — only the kinds that need the effects engine (wipes,
 * zooms, glitches, morphs, ...), plus every effect, colour-look, animation and
 * keyframing word.
 *
 * Order matters only for readability; matching is a set membership test. Both
 * the English and the Arabic spelling of each concept are listed, and the Arabic
 * entries are stored in their normalised form (no hamza on alef, taa marbuta
 * written as haa) so they match after {@link normalizeOperationText}.
 */
export const EFFECTS_PHRASES: readonly string[] = [
  // --- transitions beyond a basic dissolve -------------------------------
  "zoom transition", "wipe", "whip pan", "slide transition", "spin transition",
  "glitch transition", "3d transition", "luma transition", "morph transition",
  "light leak transition", "shatter transition", "blur transition", "push transition",
  "swipe transition", "burn transition", "dip transition", "shape transition",
  "مسح ضوئي", "انتقال مسح", "انتقال سحب", "انتقال انزلاق", "انتقال دوران",
  "انتقال ثلاثي الابعاد", "انتقال ضوئي", "انتقال متحول", "انتقال متقطع",
  "انتقال زوم", "انتقال شكل",
  // --- visual effects ----------------------------------------------------
  "visual effect", "effect", "effects", "glitch", "vhs", "grain", "vignette",
  "chromatic aberration", "sharpen", "noise", "distortion", "scanlines",
  "تاثير", "تاثيرات", "مفعول بصري", "تشويش", "تشويه", "حبيبات", "انحراف لوني",
  "تظليل الحواف", "خطوط المسح", "فلتر", "فلاتر",
  // --- colour looks ------------------------------------------------------
  "color grade", "colour grade", "color grading", "colour grading", "color look",
  "colour look", "cinematic look", "color correction", "colour correction",
  "luts", "teal and orange", "film look",
  "فلتر الوان", "تصحيح الوان", "الوان", "تدرج لوني", "تشبع الوان", "درجه لونيه",
  "درجات الوان", "لوك سينمائي", "طابع سينمائي",
  // --- text / motion animation -------------------------------------------
  "text animation", "animated text", "kinetic typography", "animated typography",
  "motion text", "text motion", "animated title", "title animation",
  "animated intro", "animated outro", "lower third", "animated lower third",
  "نص متحرك", "النص المتحرك", "تحريك النص", "تحريك الكتابه", "حركة النص",
  "كتابه متحركه", "عناوين متحركه", "عنوان متحرك", "مقدمه متحركه", "خاتمه متحركه",
  "الثوالث", "تيبوغرافيا متحركه",
  // --- keyframed / custom motion -----------------------------------------
  "keyframe", "keyframed", "key frame", "key frames", "motion path", "bezier motion",
  "custom motion", "ken burns", "pan and zoom",
  "اطار مفتاحي", "اطارات مفتاحيه", "حركه مفتاحيه", "مسار الحركه", "مسار حركي",
  "تحريك مخصص", "حركه مخصصه", "تكبير وتحريك",
  // --- generic animation words (checked last, listed last for readability).
  // Bare "motion" is deliberately absent: "slow motion" is a timeline speed
  // operation and a lone "motion" is too ambiguous to claim for the effects
  // engine. The specific motion phrases above ("motion text", "motion path",
  // "custom motion", ...) already cover every effects case.
  "animate", "animation", "animated", "تحريك", "متحرك", "متحركه",
];

/**
 * Timeline-engine phrases. A basic dissolve/fade is explicitly here: it is the
 * one transition the timeline engine owns. Also here: every plain timeline,
 * audio, basic-text and export operation. These are consulted only when no
 * effects phrase matched, so "animated title" (effects) and "cut the intro"
 * (film) each classify the way the user means.
 */
export const FILM_PHRASES: readonly string[] = [
  // --- basic transitions (timeline-native) -------------------------------
  "fade", "dissolve", "crossfade", "cross fade", "dip to black", "fade to black",
  "fade in", "fade out", "fade through black", "basic transition",
  "تلاشي", "ذوبان", "تلاشي تدريجي", "تلاشي الي الاسود", "انتقال بسيط",
  // --- timeline ----------------------------------------------------------
  "cut", "trim", "razor", "split", "arrange", "reorder", "move clip", "ripple",
  "speed", "slow motion", "reverse", "freeze frame", "shorten", "lengthen",
  "قص", "قطع", "تقطيع", "ترتيب", "اعاده ترتيب", "سرعه", "حركه بطيئه", "عكس",
  "تجميد", "جمد الاطار", "تقصير", "اطاله", "تمديد", "ازاحه المقطع",
  // --- audio / music -----------------------------------------------------
  "audio", "music", "volume", "gain", "silence", "mute", "remove audio",
  "background music", "sound", "voiceover", "soundtrack",
  "صوت", "موسيقى", "مستوى الصوت", "كتم", "ازاله الصوت", "موسيقى خلفيه",
  "تعليق صوتي",
  // --- basic (static) text -----------------------------------------------
  "static text", "plain text", "basic text", "title", "caption", "subtitle",
  "نص ثابت", "نص بسيط", "كتابه ثابته", "عنوان", "عناوين", "ترجمه",
  // --- export ------------------------------------------------------------
  "export", "render", "save video", "output", "download video", "share video",
  "تصدير", "اخراج", "انشاء الفيديو", "صدر الفيديو", "انشي الفيديو", "تنزيل الفيديو",
  "حفظ الفيديو", "مخرجات",
];

/** Default route when nothing matches: the timeline engine is always available. */
export const DEFAULT_ROUTE: VideoStudioRoute = "film";

/**
 * Classify one requested operation into the engine that owns it.
 *
 * Effects phrases win: an "animated title" is an effects operation even though
 * it also puts text on the timeline, and the router's job is to send the harder
 * operation to the richer engine (which degrades it to the timeline engine's own
 * command when that engine cannot take it).
 */
export function classifyVideoOperation(input: string): VideoStudioRoute {
  const text = normalizeOperationText(input ?? "");
  if (!text) return DEFAULT_ROUTE;
  if (anyPhrase(text, EFFECTS_PHRASES)) return "effects";
  if (anyPhrase(text, FILM_PHRASES)) return "film";
  return DEFAULT_ROUTE;
}

// ---------------------------------------------------------------------------
// Action routing
// ---------------------------------------------------------------------------

/**
 * `video_studio` actions the effects engine owns.
 *
 * Only `effect_basic` is here: its relay steps are effects-engine commands, so
 * with the effects dist installed it runs on that engine. `transition_basic` is
 * the timeline engine's own basic dissolve and `add_text` is a static graphics
 * layer, so both are timeline-native *unless* their arguments ask for something
 * richer — which is what {@link HINT_ROUTABLE_ACTIONS} covers.
 */
export const EFFECTS_ACTIONS: ReadonlySet<VideoStudioAction> = new Set<VideoStudioAction>(["effect_basic"]);

/**
 * Actions whose *arguments* can carry an effects request, so the operation text
 * is allowed to promote them to the effects route:
 *  - `transition_basic` with `type` naming a wipe/zoom/glitch/... (anything but
 *    a plain dissolve),
 *  - `effect_basic` with an effects `name`.
 *
 * Every other action is unambiguous and keeps its timeline route no matter what
 * words accompany it: `cut`, `trim`, `speed`, `add_text`, `add_audio`, `export`,
 * ... are timeline work even when the sentence around them mentions an effect,
 * and `raw` executes a command id validated against the timeline engine's own
 * catalog, so its arguments cannot move it to another engine.
 */
export const HINT_ROUTABLE_ACTIONS: ReadonlySet<VideoStudioAction> = new Set<VideoStudioAction>([
  "transition_basic",
  "effect_basic",
]);

/**
 * Route a `video_studio` action to its engine, ignoring its arguments.
 *
 * `transition_basic` is deliberately `film`: the timeline engine applies a basic
 * dissolve natively, and only its `type` argument can make it an effects
 * operation (see {@link HINT_ROUTABLE_ACTIONS}).
 */
export function routeVideoStudioAction(action: VideoStudioAction): VideoStudioRoute {
  return EFFECTS_ACTIONS.has(action) ? "effects" : "film";
}

// ---------------------------------------------------------------------------
// Degradation to the timeline engine's own commands
// ---------------------------------------------------------------------------

/** An `effects` operation rewritten as a timeline-engine command. */
export interface VideoStudioFallback {
  /** The timeline-engine action to run instead. */
  action: VideoStudioAction;
  /** True when the operation is a transition rather than a generic effect. */
  transition: boolean;
  reason: VideoStudioDegradeReason;
  /** One-line note for the model and the user, in English. */
  note: string;
}

/**
 * Phrases that mark a degraded operation as a transition rather than a generic
 * effect, so the fallback picks the timeline engine's transition command.
 *
 * Only genuine transition markers are listed. A bare "glitch", "zoom" or
 * "morph" is NOT one: "glitch effect" and "zoom in" are effects, whereas
 * "glitch transition" and "zoom transition" already contain "transition" and
 * match here anyway. A bare "slide" is not one either: "slide in the text" is
 * text/motion animation, so it must degrade to `effect_basic` (the model names
 * the command explicitly with "slide transition" when it means a wipe).
 */
export const FALLBACK_TRANSITION_PHRASES: readonly string[] = [
  "transition", "wipe", "spin", "swipe",
  "انتقال", "مسح", "انزلاق", "دوران",
];

/** True when the operation text describes a transition. */
export function isTransitionOperation(input: string): boolean {
  return anyPhrase(normalizeOperationText(input ?? ""), FALLBACK_TRANSITION_PHRASES);
}

/** The note shown when the effects engine is not installed at all. */
function unavailableNote(transition: boolean): string {
  return (
    "Loam Effects is not installed in this build, so this was applied with the " +
    (transition ? "timeline engine's basic transition" : "timeline engine's basic effect") +
    " instead. Install the Loam Effects engine to get the full effect."
  );
}

/** The note shown when the effects engine is installed but cannot apply this. */
function unsupportedNote(transition: boolean): string {
  return (
    "The requested effect needs the Loam Effects engine, which cannot apply this operation through this action yet, " +
    "so it was applied with the " +
    (transition ? "timeline engine's basic transition" : "timeline engine's basic effect") +
    " instead. Use effect_basic (or raw with an effects command) to reach the full effect."
  );
}

/**
 * Rewrite an `effects` operation as the closest timeline-engine command.
 *
 * The model's explicit choice wins when it already named a basic command:
 * `transition_basic` stays a transition, `effect_basic` stays an effect. Any
 * other action is treated as a free-form effects request and classified by
 * {@link isTransitionOperation}: a transition becomes `transition_basic`,
 * everything else becomes `effect_basic` (`effects.apply`). The tool only ever
 * passes the two basic actions, which map to themselves, so this general branch
 * exists for callers that route an operation they have not named yet.
 *
 * The note states plainly why the richer engine did not run the operation, so
 * the tool never presents a degraded edit as the full effect the user asked for.
 */
export function resolveEffectsFallback(
  requestedAction: VideoStudioAction | undefined,
  hint = "",
  reason: VideoStudioDegradeReason = "effects_backend_unavailable",
): VideoStudioFallback {
  let action: VideoStudioAction;
  let transition: boolean;
  if (requestedAction === "transition_basic") {
    action = "transition_basic";
    transition = true;
  } else if (requestedAction === "effect_basic") {
    action = "effect_basic";
    transition = false;
  } else {
    transition = isTransitionOperation(hint);
    action = transition ? "transition_basic" : "effect_basic";
  }
  return {
    action,
    transition,
    reason,
    note: reason === "effects_backend_unavailable" ? unavailableNote(transition) : unsupportedNote(transition),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface VideoStudioRouterOptions {
  /** Repo root used for the dist probes; defaults to ROOT. */
  root?: string;
  /**
   * Override the effects-backend availability probe, for tests and for callers
   * that already know the engine state. When omitted,
   * {@link isEffectcraftDistInstalled} is used.
   */
  effectsAvailable?: boolean;
}

export interface VideoStudioRoutePlan {
  /** The engine that owns the operation. */
  route: VideoStudioRoute;
  /** The engine the operation will actually run on after degradation. */
  target: VideoStudioRoute;
  /** True when an `effects` operation was degraded to a timeline-engine command. */
  degraded: boolean;
  /** Why it degraded; undefined when nothing was degraded. */
  reason?: VideoStudioDegradeReason;
  /** The `video_studio` action to run (unchanged when the plan did not degrade). */
  action: VideoStudioAction;
  /** One-line note about the routing decision, for the tool result. */
  note: string;
}

const FILM_NOTE = "Applied on the Loam Video timeline engine.";
const EFFECTS_NOTE = "Applied with the Loam Effects engine.";

/**
 * The router `video_studio` uses for every call: it picks the engine, and when
 * the effects engine cannot take the operation it rewrites the call as a
 * timeline-engine command instead of failing.
 */
export class VideoStudioRouter {
  private readonly root: string;
  private readonly effectsAvailableOverride: boolean | undefined;

  constructor(options: VideoStudioRouterOptions = {}) {
    this.root = options.root ?? ROOT;
    this.effectsAvailableOverride = options.effectsAvailable;
  }

  /** True when the timeline-engine dist is installed. */
  isFilmBackendAvailable(): boolean {
    return fs.existsSync(path.join(this.root, "electron", "filmcraft", "dist", "index.html"));
  }

  /** True when the effects-engine dist is installed. */
  isEffectsBackendAvailable(): boolean {
    return this.effectsAvailableOverride ?? isEffectcraftDistInstalled(this.root);
  }

  /** Classify free-form operation text (Arabic or English). */
  classify(input: string): VideoStudioRoute {
    return classifyVideoOperation(input);
  }

  /**
   * Plan one call.
   *
   * @param action the `video_studio` action the model chose.
   * @param hint   the operation in the user's own words plus the action's own
   *               discriminating arguments (`type` on a transition, `name` on an
   *               effect). Only {@link HINT_ROUTABLE_ACTIONS} consult it, so an
   *               unambiguous action can never be rerouted by stray prose.
   */
  plan(action: VideoStudioAction, hint = ""): VideoStudioRoutePlan {
    const byAction = routeVideoStudioAction(action);
    const byHint = HINT_ROUTABLE_ACTIONS.has(action) ? classifyVideoOperation(hint) : "film";
    const route: VideoStudioRoute = byAction === "effects" || byHint === "effects" ? "effects" : "film";

    if (route === "film") {
      return { route, target: "film", action, degraded: false, note: FILM_NOTE };
    }
    if (!this.isEffectsBackendAvailable()) {
      const fallback = resolveEffectsFallback(action, hint, "effects_backend_unavailable");
      return {
        route,
        target: "film",
        action: fallback.action,
        degraded: true,
        reason: fallback.reason,
        note: fallback.note,
      };
    }
    if (!EFFECTS_ACTIONS.has(action)) {
      // The effects engine is installed, but this action's relay steps are
      // timeline-engine commands: sending them to the effects engine would run
      // the wrong command, so apply the timeline engine's basic equivalent and
      // say so.
      const fallback = resolveEffectsFallback(action, hint, "effects_engine_unsupported");
      return {
        route,
        target: "film",
        action: fallback.action,
        degraded: true,
        reason: fallback.reason,
        note: fallback.note,
      };
    }
    return { route, target: "effects", action, degraded: false, note: EFFECTS_NOTE };
  }
}

/** Shared router for the running server (one per process). */
export const videoStudioRouter = new VideoStudioRouter();
