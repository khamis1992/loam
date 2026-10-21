---
name: certutil
description: Use when a task needs a file hash (SHA-256/MD5/etc.) on Windows via shell_run using the built-in certutil tool.
---

# certutil (Windows built-in file hashing)

## When to Use
Need to compute a file hash (SHA-256, MD5, SHA1, SHA384, SHA512) on Windows via shell_run, without installing anything.

## Procedure
1. Resolve the file's absolute path first (see Pitfalls).
2. Run with cwd set to the file's folder:
   ```
   certutil -hashfile <filename> SHA256
   ```
   or with a full path: `certutil -hashfile C:\path\to\file.md SHA256`
3. Output format:
   ```
   SHA256 hash of C:\path\to\file.md:
   2fe1c6f0a79f69a624c44651d34631def00e287a4ce65c67f5143ea3b4008b9c
   CertUtil: -hashfile command completed successfully.
   ```
   The hash is the single 64-char hex line between the header and the success line.

## Pitfalls
- certutil prints the hash in UPPERCASE; PowerShell `Get-FileHash` prints lowercase. Compare hashes case-insensitively.
- `file_search` on this machine can return "no matches" for files that exist in nested workspace subfolders. If it fails, locate the file with `shell_run`: `dir /s /b <name>` from a parent folder (e.g. `C:\Users\khamis\Desktop\manus-local\workspace`), or just run certutil directly with cwd set to the known project folder.
- `dir /s /b README.md` from a folder containing node_modules returns hundreds of matches — filter the output or target the specific project subfolder.
- Algorithm name is written without a dash: `SHA256` (also accepts SHA256, SHA384, SHA512, MD5, SHA1).

## Verification
- Hash must be exactly 64 hex characters for SHA-256.
- Cross-check with PowerShell: `powershell -c "(Get-FileHash '<path>' -Algorithm SHA256).Hash"` — values must match ignoring case.
