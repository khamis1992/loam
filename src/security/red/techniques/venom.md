# Venom stealth communications — T1095

## Concept
Carries C2 traffic through low-volume covert channels and evasion-oriented behaviors so beaconing blends into ordinary host traffic.

## Detection built into Loam
- Periodic low-jitter beaconing from lab hosts, especially from processes without a browser context.
- Covert-channel heuristics: unusually small or padded payloads, fixed intervals, DNS/ICMP-only flows.
- Correlate with newly created processes and atypical destination profiles.

Source studied at concept level: Idov31/Venom (GPL-3.0). No code copied.
