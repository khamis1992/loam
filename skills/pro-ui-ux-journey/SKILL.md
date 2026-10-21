---
name: pro-ui-ux-journey
description: - Use when auditing a product's UI/UX or user journey and producing a prioritized, evidence-based improvement proposal (heuristics, accessibility, journeys, funnel friction, metrics) without writing code.
---

---
name: pro-ui-ux-journey
description: >-
  Use when auditing a product's UI/UX or user journey and producing a
  prioritized, evidence-based improvement proposal (heuristics, accessibility,
  journeys, funnel friction, metrics) without writing code.
---
# Professional UI/UX + journey audit
1. Gather evidence: live screenshots of every key screen, current roadmap (to avoid duplicates), brand rules/design tokens, analytics if any.
2. Map journeys with JTBD framing: first visit → sign-up → first paid conversion → daily use → renewal/churn. Per stage: user goal, actions, screens, emotion, friction, opportunity.
3. Heuristic audit (Nielsen 10): log each issue with screen, heuristic, severity 0–4 (Nielsen scale), evidence.
4. Accessibility (WCAG 2.2 AA): text contrast ≥4.5:1 (≥3:1 large/UI), compute brand colors against backgrounds; targets ≥44pt (iOS)/48dp (Material), 24px min per WCAG 2.5.8; focus, labels, dynamic type, no colour-only meaning.
5. Localization/RTL: full Arabic mirroring (icons with direction, progress, carousels), Arabic numerals choice, plural/gender-neutral copy, font line-height.
6. IA & navigation: tab count ≤5, consistent back affordance, single source for key numbers (no conflicting counts across screens).
7. Funnel friction (subscription apps): value before account wall, plan comparison clarity, price anchoring per meal/day, trust at payment, duplicate fields/cards, commitment anxiety (pause/skip/cancel visible).
8. States: design empty, loading (skeletons), error (cause + fix), success; microcopy positive, specific, action-led.
9. Motion: 150–300ms, ease-out, purposeful, respects reduce-motion.
10. Benchmark 3–5 peers (category + regional) for specific patterns, not looks.
11. Prioritize with impact × effort (RICE/ICE); each proposal: problem, evidence, solution, before/after mockup within brand, metric.
12. Metrics: task success, time on task, SUS (target ≥75), funnel conversion per step, D7/D30 retention, renewal rate; plan 5-user think-aloud test per release.
13. Verify deliverable: render every page, check text, colours against brand palette, RTL direction. Label any target or example figure as a goal, not measured data.
