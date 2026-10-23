#!/usr/bin/env python3
"""Source-level rebrand of an ArtCraft app before building: user-visible names become Loam names.
Only .rs, .ftl, .json, .html, .toml-free text resources under crates/ and apps/ are touched (never Cargo.toml / docs)."""
import sys, pathlib
app, repo = sys.argv[1], pathlib.Path(sys.argv[2])
NAMES = {"wordcraft": ("WordCraft", "Loam Docs"), "gridcraft": ("GridCraft", "Loam Sheets"), "deckcraft": ("DeckCraft", "Loam Slides"),
         "photocraft": ("PhotoCraft", "Loam Photo"), "designcraft": ("DesignCraft", "Loam Design")}
old, new = NAMES[app]
PAIRS = [(old, new), ("ArtCraft", "Loam")]
EXTS = {".rs", ".ftl", ".json", ".html", ".po", ".properties", ".txt", ".yaml", ".yml"}
n = 0
for base in ("crates", "apps"):
    for f in (repo / base).rglob("*"):
        if not f.is_file() or f.suffix not in EXTS or "/tests/" in str(f) or f.name.endswith("_tests.rs"):
            continue
        try:
            t = f.read_text()
        except UnicodeDecodeError:
            continue
        u = t
        for a, b in PAIRS:
            u = u.replace(a, b)
        if u != t:
            f.write_text(u); n += 1
print(f"rebranded {n} files in {app}")
