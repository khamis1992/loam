# MrKaplan anti-forensics — T1070

## Concept
Removes engagement artifacts on Windows: clearing logs, deleting dropped files and timestomping so the host appears clean during forensics.

## Detection built into Loam
- Windows Security events 1102 (log cleared) and 104 (log file cleared).
- Timestomping heuristic: `$Standard_Information` timestamps older than `$File_Name` timestamps on the same file.
- Append-only, hash-chained Loam audit history makes silent truncation visible.

Source studied at concept level: Idov31/MrKaplan (GPL-3.0). No code copied.
