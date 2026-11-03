---
name: nutrio-team-skill-upgrade
description: Run once per day to upgrade the Neterio fleet team's skill set and record the upgrade: fetch Nutrio fleet metrics, compute the skill areas (dispatch, GPS freshness, zone coverage, access readiness), and record the upgrade with a timestamp.
---

# nutrio-team-skill-upgrade — v1
<!-- learned-by: agent_mvi9iy9x4de88b | learned-at: 2026-10-24T23:12:42.737Z -->
<!-- version: 1 -->

**متى:** Run once per day to upgrade the Neterio fleet team's skill set and record the upgrade: fetch Nutrio fleet metrics, compute the skill areas (dispatch, GPS freshness, zone coverage, access readiness), and record the upgrade with a timestamp.

## الخطوات
1) Read the previous run marker/state (nutrio_last_run.json or companion memory) to know which skill areas were already upgraded.
2) Fetch the current Neterio fleet state: online_now, online_gps_fresh_15m, online_with_zones (via integration if enabled, else browser/DB, else record as unavailable).
3) For each skill area, upgrade the team skill set: dispatch-readiness, gps-freshness, zone-coverage, access-readiness, monitoring-hygiene. Bump the skill version and record the current date.
4) Write the skill definition to a reusable artifact in the task workspace (nutrio_team_skill.md / .json) with the version, the current date, and the per-area upgrade note.
5) Save the upgrade to companion memory as a durable fact (kind=inference, shared=true) naming the skill and the date.
6) Report the upgraded areas, the new version and the date.
