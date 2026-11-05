#!/usr/bin/env python3
"""Apply the Loam host bridge to an ArtCraft *-web app. Usage: apply_patch.py <app> <repo_dir>"""
import re, shutil, sys, pathlib
app, repo = sys.argv[1], pathlib.Path(sys.argv[2])
web = repo / "apps" / f"{app}-web"
src = web / "src"
here = pathlib.Path(__file__).parent
CR = {"wordcraft": "wordcraft_ui_egui", "gridcraft": "gridcraft_ui_egui", "deckcraft": "deckcraft_ui_egui",
      "photocraft": "photocraft_ui_egui", "designcraft": "designcraft_ui_egui"}[app]
# per-app: how a host-opened file enters the app (same path as a dropped file)
OPEN = {
 "wordcraft": "self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));",
 "gridcraft": "self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));",
 "photocraft": "self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push((name, bytes));",
 "deckcraft": "let id = self.app.begin_external_file(\"drop\"); push_inbox(&self.inbox, InboxEvent::File(InboxFile { id, name, bytes }));",
 "designcraft": "let request = self.app.import_request(\"drop\"); self.inbox.lock().unwrap_or_else(|e| e.into_inner()).push(ImportedFile { request, name, bytes });",
}[app]
APPVAR = {"wordcraft": "app", "gridcraft": "app", "deckcraft": "app", "photocraft": "app", "designcraft": "app"}[app]
w = (src / "web.rs").read_text()
if "loam_bridge" in w:
    print("already patched"); sys.exit(0)
shutil.copy((here / "patch" / "loam_bridge.rs") if (here / "patch" / "loam_bridge.rs").exists() else (here / "loam_bridge.rs"), src / "loam_bridge.rs")
m = (src / "main.rs").read_text()
m = m.replace("#[cfg(target_arch = \"wasm32\")]\nmod web;", "#[cfg(target_arch = \"wasm32\")]\nmod loam_bridge;\n#[cfg(target_arch = \"wasm32\")]\nmod web;", 1)
assert "mod loam_bridge" in m, "main.rs: mod web not found"
(src / "main.rs").write_text(m)
# 1. saves/exports go to the host when embedded
w, n = re.subn(r"(\nfn download\([^)]*path: &str, bytes: &\[u8\]\)[^{]*\{\n)", "\\1    if crate::loam_bridge::post_save(\"%s\", path, bytes) {\n        return Ok(());\n    }\n" % app, w, count=1)
if n == 0:
    w, n = re.subn(r"(\nfn download\(name: &str, bytes: &\[u8\]\)[^{]*\{\n)", "\\1    if crate::loam_bridge::post_save(\"%s\", name, bytes) {\n        return Ok(());\n    }\n" % app, w, count=1)
assert n == 1, "download fn not found"
# 2. struct fields
w, n = re.subn(r"(struct WebShell \{\n)", r"\1    loam: Option<crate::loam_bridge::Bridge>,\n    loam_tx: std::sync::mpsc::Sender<%s::ControlRequest>,\n" % CR, w, count=1)
assert n == 1
# 3. construction
w, n = re.subn(r"(\n(\s*)Ok\(Box::new\(WebShell \{)", lambda mo: f"\n{mo.group(2)}let (loam_tx, loam_rx) = std::sync::mpsc::channel();\n{mo.group(2)}let loam = crate::loam_bridge::Bridge::install(\"{app}\", env!(\"CARGO_PKG_VERSION\"), cc.egui_ctx.clone());\n{mo.group(2)}let mut {APPVAR} = {APPVAR};\n{mo.group(2)}if loam.is_some() {{\n{mo.group(2)}    {APPVAR} = {APPVAR}.LOAM_WITH_CONTROL;\n{mo.group(2)}}}" + mo.group(1).replace("WebShell {", "WebShell { loam, loam_tx,"), w, count=1)
assert n == 1, "WebShell construction not found"
if app == "gridcraft":
    w = w.replace(f"{APPVAR} = {APPVAR}.LOAM_WITH_CONTROL;", f"{APPVAR}.control_rx = Some(loam_rx);")
else:
    w = w.replace("LOAM_WITH_CONTROL", "with_control(loam_rx)")
# 4. per-frame
w, n = re.subn(r"(\n(\s*)self\.app\.logic\(ctx)", lambda mo: f"\n{mo.group(2)}if let Some(mut loam) = self.loam.take() {{\n{mo.group(2)}    for (name, bytes) in loam.take_opens() {{\n{mo.group(2)}        {OPEN}\n{mo.group(2)}    }}\n{mo.group(2)}    loam.poll(&self.loam_tx, {CR}::ControlRequest::new, ctx);\n{mo.group(2)}    self.loam = Some(loam);\n{mo.group(2)}}}" + mo.group(1), w, count=1)
assert n == 1, "app.logic not found"
(src / "web.rs").write_text(w)
c = (web / "Cargo.toml").read_text()
if '"MessageEvent"' not in c:
    c, n = re.subn(r'(web-sys = \{[^}]*features = \[)', r'\1"MessageEvent", ', c, count=1)
    assert n == 1, "web-sys features not found"
if not re.search(r"^serde_json\s*=", c, re.M):
    c = c.replace("[dependencies]\n", "[dependencies]\nserde_json = { workspace = true }\n", 1)
for dep in ["js-sys", "wasm-bindgen"]:
    if not re.search(rf"^{dep}\s*=", c, re.M):
        print("WARN missing dep", dep)
(web / "Cargo.toml").write_text(c)
# upstream wasm fixups (std::process::id() panics on wasm32 with current std)
if app == "deckcraft":
    f = repo / "crates/fonts/build.rs"; t = f.read_text()
    old = 'if wasm && !matches!((*family, *style), ("BIZ UDPGothic", "Regular") | ("Inter", "Regular" | "Bold" | "Variable")) {'
    new = 'if wasm && !matches!((*family, *style), ("BIZ UDPGothic", "Regular") | ("Inter", "Regular" | "Bold" | "Variable") | ("Noto Sans Arabic", "Regular")) {'
    assert old in t, "deckcraft wasm font allowlist not found"
    f.write_text(t.replace(old, new, 1))
    f = repo / "crates/fonts/src/fallback.rs"; t = f.read_text()
    test = r'''
    #[test]
    fn loam_arabic_face_is_required_for_web_documents() {
        assert!(CRAFT_FONTS.iter().any(|f| f.family == "Noto Sans Arabic" && f.scripts.contains(&"Arab")));
        let db = FontDb::with_font_dirs(Vec::new());
        db.set_system_fallback(false);
        let inter = db.face(crate::DEFAULT_FAMILY, "Regular");
        let cluster = ['\u{0628}', '\u{064E}'];
        let face = db.cascade(&cluster, std::slice::from_ref(&inter), "Regular");
        assert_eq!(face.family, "Noto Sans Arabic");
        assert!(covers_cluster(&face, &cluster));
        let glyphs = crate::shape(&face, "مَتَحُ الفَنِّ الإِسْلَامِيُّ 2008", &[], |c| c);
        assert!(!glyphs.is_empty() && glyphs.iter().all(|g| g.gid != 0));
    }
'''
    t = t[:t.rfind("\n}")] + test + "\n}\n"
    f.write_text(t)
    f = repo / "crates/engine/src/recovery.rs"; t = f.read_text()
    t = t.replace("        h.write_u32(std::process::id());\n", "        #[cfg(not(target_arch = \"wasm32\"))]\n        h.write_u32(std::process::id());\n", 1)
    f.write_text(t)
    # let agents save/download as .pptx from the browser: app.saveAsDialog {format?: "pptx"|"deckcraft"}
    f = repo / "crates/ui-egui/src/lib.rs"; t = f.read_text()
    t = t.replace('"app.saveAsDialog" => self.save_as_dialog("deckcraft"),', '"app.saveAsDialog" => self.save_as_dialog(p.get("format").and_then(Value::as_str).unwrap_or("deckcraft")),', 1)
    f.write_text(t)
print("patched", app)
