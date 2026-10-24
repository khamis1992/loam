/**
 * Red-team tradecraft registry (RED_TEAM_BUILD_SPEC §6.12).
 *
 * FunctionStomping / Venom / MrKaplan / HashDump-BypassEDR are covered at
 * architecture / how-it-works / detection level ONLY, so that (a) red-team
 * exercises on Khamis's own isolated lab are realistic, and (b) Loam's blue
 * core can detect the technique on its own hosts. Nothing here is a how-to
 * against third-party systems; no upstream GPL code is copied.
 */

export interface DetectionSignature {
  /** Where the detection lives (blue blocks catalogue surface). */
  surface: string;
  /** What to look for; structured as a blue detection rule description. */
  signature: string;
}

export interface RedTechnique {
  id: string;
  name: string;
  /** MITRE ATT&CK technique id. */
  attackId: string;
  /** How it works — concept level only (no weaponization steps). */
  concept: string;
  detection: DetectionSignature;
  /** Upstream project studied for the concept. */
  source: string;
}

export const TECHNIQUES: RedTechnique[] = [
  {
    id: "function-stomping",
    name: "Function Stomping (shellcode injection)",
    attackId: "T1055.012",
    concept:
      "Overwrites the machine code of a legitimately loaded function inside a remote process, so the modified function's entry point executes attacker shellcode when called. Because the bytes live in an already-executable, already-mapped image, no new RWX allocation is needed.",
    detection: {
      surface: "host/edr:image-integrity",
      signature: "Unexpected writes to executable image regions of loaded modules; compare in-memory module code hashes (integrity check) against on-disk images; alert when a hot function's bytes differ from the file on disk.",
    },
    source: "Idov31/FunctionStomping (GPL-3.0; concept only)",
  },
  {
    id: "venom-stealth-comms",
    name: "Venom (stealthy communications)",
    attackId: "T1095",
    concept:
      "Carries C2 traffic over covert, low-volume channels with evasion-oriented behaviours, so the beacon blends into normal host traffic instead of standing out as a new connection pattern.",
    detection: {
      surface: "network/blue:c2-beacon",
      signature: "Anomalous periodic beaconing (low jitter, fixed interval) from lab hosts; covert-channel heuristics: unusually small/padded payloads, regular intervals, or DNS/ICMP-only flows from processes without a browser context.",
    },
    source: "Idov31/Venom (GPL-3.0; concept only)",
  },
  {
    id: "mrkaplan-anti-forensics",
    name: "MrKaplan (anti-forensics cleanup)",
    attackId: "T1070",
    concept:
      "Removes red-team artifacts on Windows after an engagement: clearing logs, deleting dropped files and timestomping, so post-incident forensics sees a clean host.",
    detection: {
      surface: "host/blue:log-integrity",
      signature: "Windows Security event 1102 (log cleared) and 104 (log file cleared) alerts; timestomping: $Standard_Information timestamps older than $File_Name timestamps on the same file; append-only audit ledgers that never shrink.",
    },
    source: "Idov31/MrKaplan (GPL-3.0; concept only)",
  },
  {
    id: "hashdump-bypass-edr",
    name: "HashDump with EDR bypass",
    attackId: "T1003.001",
    concept:
      "Dumps credential hashes from LSASS while detouring or unhooking the EDR functions that watch LSASS access, so the credential access does not trip real-time protection.",
    detection: {
      surface: "host/edr:tamper",
      signature: "Detect unhooking: EDR DLL in-memory code hashes differ from on-disk; detect anomalous LSASS access patterns (duplicate handles, debug privileges) even when APIs are hooked; alert on EDR service/agent stops.",
    },
    source: "AabyssZG/HashDump-BypassEDR (Apache-2.0; concept only)",
  },
];

export function listTechniques(): RedTechnique[] {
  return [...TECHNIQUES];
}

export function getTechnique(id: string): RedTechnique | undefined {
  return TECHNIQUES.find((t) => t.id === id);
}

/** Detection signatures for every technique — the blue blocks hand-off. */
export function detectionSignatures(): Array<DetectionSignature & { techniqueId: string; attackId: string }> {
  return TECHNIQUES.map((t) => ({ techniqueId: t.id, attackId: t.attackId, ...t.detection }));
}
