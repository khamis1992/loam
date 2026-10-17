import io, os, glob, sys

ROOT = r"C:\Users\khamis\Desktop\manus-local"

# .NET/Windows PowerShell reads BOM-less UTF-8 files using the ANSI code page (1252 here).
# .NET's 1252 decoder passes undefined bytes through as their code point (0x81 -> U+0081 ...),
# unlike Python's cp1252 codec. Build the exact byte<->char tables.
b2c = {}
for b in range(256):
    try:
        b2c[b] = bytes([b]).decode("cp1252")
    except UnicodeDecodeError:
        b2c[b] = chr(b)
c2b = {ch: b for b, ch in b2c.items()}

def repair(text: str):
    """Return (repaired_text or None, reason)."""
    out = bytearray()
    for ch in text:
        if ch in c2b:
            out.append(c2b[ch])
        elif ord(ch) < 128:
            out.append(ord(ch))
        else:
            return None, f"unmappable char U+{ord(ch):04X}"
    try:
        decoded = out.decode("utf-8")
    except UnicodeDecodeError as e:
        return None, f"not valid utf-8 after reverse: {e}"
    # sanity: repaired text should introduce Arabic characters
    had_ascii_d8 = "\u00d8" in text or "\u00c3" in text
    has_arabic = any("\u0600" <= c <= "\u06FF" for c in decoded)
    if had_ascii_d8 and not has_arabic:
        return None, "reverse produced no Arabic"
    return decoded, "ok"

paths = []
for pat in [r"ui\*.html", r"ui\*.js", r"ui\*.css", r"electron\*.cjs", r"*.bat", r"README.md"]:
    paths += glob.glob(os.path.join(ROOT, pat))

apply = "--apply" in sys.argv
for path in sorted(set(paths)):
    with io.open(path, "r", encoding="utf-8", errors="surrogateescape") as f:
        raw = f.read()
    has_bom = raw.startswith("\ufeff")
    text = raw[1:] if has_bom else raw
    needs = ("\u00d8" in text or "\u00c3" in text)
    if not needs:
        print(f"skip  {os.path.basename(path)} (no mojibake markers)")
        continue
    fixed, reason = repair(text)
    if fixed is None:
        print(f"FAIL  {os.path.basename(path)}: {reason}")
        continue
    sample = next((l.strip() for l in fixed.splitlines() if any("\u0600" <= c <= "\u06FF" for c in l)), "")
    print(f"FIX   {os.path.basename(path)}  sample={sample[:70]}")
    if apply:
        with io.open(path, "w", encoding="utf-8", newline="") as f:
            f.write(fixed)
        print(f"      written (bom_removed={has_bom})")
