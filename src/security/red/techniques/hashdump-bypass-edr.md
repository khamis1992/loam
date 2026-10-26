# HashDump with EDR bypass — T1003.001

## Concept
Dumps credential hashes from LSASS while detouring or unhooking EDR functions that monitor credential access.

## Detection built into Loam
- Detect unhooking: EDR DLL in-memory code hashes differ from on-disk copies.
- Alert on anomalous LSASS access patterns, duplicate handles and debug privileges, even when APIs are hooked.
- Alert on EDR service or agent stops and unexpected protection changes.

Source studied at concept level: AabyssZG/HashDump-BypassEDR (Apache-2.0). No code copied.
