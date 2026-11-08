#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" != "Darwin" ]]; then
  printf '%s\n' 'unsupported_platform: macOS is required' >&2
  exit 2
fi
if [[ "$#" -ne 2 ]]; then
  printf '%s\n' 'usage: safari-convert.sh SOURCE_DIR NEW_OUTPUT_DIR' >&2
  exit 2
fi
SOURCE="$(cd "$1" && pwd -P)"
OUT="$2"
if [[ ! -f "$SOURCE/manifest.json" || -e "$OUT" ]]; then
  printf '%s\n' 'source manifest missing or output already exists' >&2
  exit 2
fi
xcodebuild -version
xcrun --find safari-web-extension-converter
xcrun safari-web-extension-converter --help
xcrun safari-web-extension-converter "$SOURCE" \
  --project-location "$OUT" --app-name LoamPageNotes --no-open --no-prompt
printf '%s\n' 'conversion finished; inspect project and build settings before signing'
