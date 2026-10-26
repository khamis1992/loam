# Red-team tradecraft: concept and detection only

This catalogue implements RED_TEAM_BUILD_SPEC §6.12: architecture-level understanding for realistic owned-lab exercises and blue detection. It is not a how-to for evading protections on third-party systems. No upstream GPL code is copied.

| Technique | ATT&CK | Detection surface |
|---|---|---|
| Function Stomping | T1055.012 | Loaded-module image integrity |
| Venom stealth communications | T1095 | Beaconing and covert-channel heuristics |
| MrKaplan anti-forensics | T1070 | Log integrity, event 1102/104, timestamp anomalies |
| HashDump with EDR bypass | T1003.001 | EDR unhooking, LSASS access and agent tampering |

The machine-readable registry lives in `index.ts` and is exposed to the blue audit catalogue as `loam-audit/redTeamTradecraft` in `src/security/audit/blocks/domains.ts`.
