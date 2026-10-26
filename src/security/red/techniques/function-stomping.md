# Function Stomping — T1055.012

## Concept
Overwrites a legitimately loaded function's machine code in a remote process so its entry point executes attacker shellcode when called. Because bytes live in an already-executable image, no new RWX allocation is needed.

## Detection built into Loam
- Alert on unexpected writes to executable image regions.
- Compare in-memory loaded-module code hashes with on-disk images; differences at hot function entries are high-confidence tampering.
- Correlate with unexpected remote-thread or process-write activity on owned lab hosts.

Source studied at concept level: Idov31/FunctionStomping (GPL-3.0). No code copied.
