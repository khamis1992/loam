---
name: mirofish-swarm-analyst
description: Analyze any application, codebase, binary/package, or scenario using MiroFish's 5-stage Swarm Intelligence Engine (10-type Ontology & Temporal Knowledge Graph, OASIS Persona & Circadian Environment Setup, Dual-Platform Swarm Simulation with God's-eye variable injection, ReACT ReportAgent with InsightForge/PanoramaSearch/QuickSearch/InterviewAgents, and Deep Interaction).
keywords: mirofish, swarm intelligence, oasis simulation, multi-agent simulation, predict, prediction engine, graphrag, ontology, insight forge, panorama search, analyze app, application analysis, ميروفش, محاكاة السرب, ذكاء السرب, توقع, تحليل تطبيق, محاكاة متعددة الوكلاء, رسم معرفي
---

# MiroFish Swarm Intelligence & Application Analysis (`mirofish_*`)

Use this skill whenever the user asks to analyze an application, simulate user/stakeholder reactions, stress-test an architecture under future scenarios ("what if"), or run MiroFish's 5-stage Swarm Intelligence workflow.

## 1. The 5-Stage MiroFish Architecture

1. **Stage 1 — Ontology & Temporal Knowledge Graph Construction (`mirofish_graph`)**:
   - Inspects the target application directory, files, REA evidence, or scenario document (`inspectApplicationTarget`).
   - Synthesizes a strict **10-entity-type ontology** (`entity_types`: 8 domain/application-specific `PascalCase` types + 2 mandatory fallback types `Person` and `Organization` at the end) and 6–10 `UPPER_SNAKE_CASE` `edge_types`.
   - Builds the **Local Temporal Knowledge Graph** (`nodes` + `edges` with `valid_at`, `invalid_at`, `expired_at`, `episodes`) with zero cloud dependencies.
2. **Stage 2 — Environment Setup & OASIS Persona Generation (`mirofish_simulate` `action="prepare"`)**:
   - Generates rich **OASIS Agent Profiles** exporting both `reddit_profiles.json` and `twitter_profiles.csv`.
   - Generates circadian `TimeSimulationConfig`, `AgentActivityConfig`, `EventConfig`, and dual `PlatformConfig`.
3. **Stage 3 — Dual-Platform Parallel Swarm Simulation & God's-Eye Injection (`mirofish_simulate` `action="start"` / `"inject_variable"`)**:
   - Runs multi-round parallel simulations across **Twitter (World 1)** and **Reddit (World 2)** with dynamic God's-eye variable injection and Temporal Knowledge Graph memory updates.
4. **Stage 4 — ReACT ReportAgent with 4 GraphRAG Tools (`mirofish_report`)**:
   - Plans a 2–5 section report outline and runs a ReACT loop per section using `insight_forge`, `panorama_search`, `quick_search`, and `interview_agents`.
5. **Stage 5 — Deep Interaction & Live Workbench (`mirofish_interact`)**:
   - Interview any simulated agent (`action="interview_agents"`), chat with the ReportAgent (`action="chat_report"`), or launch the live MiroFish REST API & 5-Step Workbench UI server (`action="serve_start"`).
