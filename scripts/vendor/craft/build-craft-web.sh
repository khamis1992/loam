#!/usr/bin/env bash
# Build the Loam-bridged Craft web apps from pinned upstream sources (Linux/macOS/WSL).
# Needs: git, python3, gzip, split, rustup (stable >= 1.95) with target wasm32-unknown-unknown, trunk 0.22+.
# Usage: build-craft-web.sh <app> <out_zip_dir>   app = wordcraft|gridcraft|deckcraft|photocraft|designcraft
set -euo pipefail
APP="$1"; OUT="$(cd "$2" && pwd)"; HERE="$(cd "$(dirname "$0")" && pwd)"
REV="$(python3 -c "import json,sys;print(json.load(open('$HERE/manifest.json'))['apps']['$APP']['rev'])")"
WORK="${LOAM_CRAFT_BUILD_DIR:-$HOME/.cache/loam-craft}/$APP"
[ -d "$WORK/.git" ] || git clone "https://github.com/storytold/$APP" "$WORK"
git -C "$WORK" fetch --quiet origin && git -C "$WORK" checkout --quiet --force "$REV" && git -C "$WORK" clean -fdq
if [ "$APP" = deckcraft ]; then
  FONT_REV="$(python3 -c "import json,sys;print(json.load(open('$HERE/manifest.json'))['fonts']['rev'])")"
  FONT_WORK="${LOAM_CRAFT_BUILD_DIR:-$HOME/.cache/loam-craft}/craft-fonts"
  [ -d "$FONT_WORK/.git" ] || git clone "https://github.com/storytold/craft-fonts" "$FONT_WORK"
  git -C "$FONT_WORK" fetch --quiet origin && git -C "$FONT_WORK" checkout --quiet --force "$FONT_REV" && git -C "$FONT_WORK" clean -fdq
  export CRAFT_FONTS_DIR="$FONT_WORK" CRAFT_FONTS_REQUIRED=1
fi
python3 "$HERE/apply_patch.py" "$APP" "$WORK"
python3 "$HERE/rebrand_src.py" "$APP" "$WORK"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$WORK/target}"
(cd "$WORK/apps/$APP-web" && trunk build --release)
if [ "$APP" = photocraft ]; then
  (cd "$WORK/apps/photocraft-web-boot" && trunk build --release)
  # trunk >= 0.22 hashes the glue and the wasm separately; package.sh expects <stem>.js next to <stem>_bg.wasm
  W="$(ls "$WORK"/dist/web/*_bg.wasm | head -1)"; G="${W%_bg.wasm}.js"
  [ -f "$G" ] || cp "$(ls "$WORK"/dist/web/*.js | head -1)" "$G"
  bash "$WORK/packaging/web/package.sh" --skip-build || true   # its final `zip` step is optional for us
  SITE="$(ls -d "$CARGO_TARGET_DIR"/web-package/photocraft-web-*/ | head -1)"
else
  SITE="$WORK/dist/web"
fi
STAGE="$(mktemp -d)/$APP-web-loam"; mkdir -p "$STAGE"; cp -R "$SITE/." "$STAGE/"
rm -f "$STAGE"/LICENSE* "$STAGE"/NOTICE* "$STAGE"/ATTRIBUTION* "$STAGE"/README.md "$STAGE"/HOSTING.md "$STAGE"/_headers "$STAGE"/.htaccess "$STAGE"/.trunk-lock
if [ "$APP" = deckcraft ]; then
  mkdir -p "$STAGE/licenses"
  cp "$FONT_WORK/fonts/noto-sans-arabic/OFL.txt" "$STAGE/licenses/NotoSansArabic-OFL.txt"
  cp "$FONT_WORK/fonts/inter/OFL.txt" "$STAGE/licenses/Inter-OFL.txt"
  cp "$FONT_WORK/fonts/biz-ud-pgothic/OFL.txt" "$STAGE/licenses/BIZUDPGothic-OFL.txt"
  cp "$FONT_WORK/ATTRIBUTION.md" "$STAGE/licenses/craft-fonts-ATTRIBUTION.md"
fi
python3 -c "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], sys.argv[3])" "$OUT/$APP-web-loam-$REV" "$(dirname "$STAGE")" "$(basename "$STAGE")"
echo "$OUT/$APP-web-loam-$REV.zip"
