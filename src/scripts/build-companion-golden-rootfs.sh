#!/usr/bin/env bash
# Builds the minimal REAL Linux rootfs tar used as the companion-device golden
# image (frontier stage 2). Run inside any WSL2 distro that has bash+coreutils:
#   wsl -d Ubuntu-24.04 -u root -- bash -s < src/scripts/build-companion-golden-rootfs.sh
# Output: %TEMP%/loam-golden/golden-linux.tar (~16MB) — a genuine Linux userspace
# (real bash/coreutils + libs + ELF interpreter + isolated `loam` user) that
# `wsl --import` boots as a fully separate device environment.
set -euo pipefail
R=/tmp/miniroot
OUT_DIR=/mnt/c/Users/khamis/AppData/Local/Temp/loam-golden
rm -rf "$R"
mkdir -p "$R"/{usr/bin,usr/sbin,usr/lib/x86_64-linux-gnu,usr/lib64,bin,sbin,lib/x86_64-linux-gnu,lib64,etc,root,tmp,var/tmp,proc,sys,dev,mnt,opt,usr/share} "$R/home/loam/inbox"

copy_bin() {
  local src
  src=$(command -v "$1" 2>/dev/null) || return 0
  [ -x "$src" ] || return 0
  cp -L "$src" "$R$src"
  local lib
  while IFS= read -r lib; do
    mkdir -p "$R$(dirname "$lib")"
    cp -L "$lib" "$R$lib" 2>/dev/null || true
  done < <(ldd "$src" 2>/dev/null | awk '{print $3}' | grep '^/' | sort -u)
}

for b in bash ls cat mkdir uname df free id head tail wc sleep env date cp mv rm touch grep du ps readelf tar base64 setsid nohup; do copy_bin "$b"; done

# ---- GUI viewer package (stage 2 completion): Xvfb desktop + capture + manual input.
# Requires these packages in the build distro (Ubuntu):
#   apt-get install -y --no-install-recommends xvfb fluxbox xterm xdotool wmctrl ffmpeg fonts-dejavu-core
GUI_BINS="Xvfb fluxbox xterm xdotool wmctrl ffmpeg"
GUI_MISSING=""
for b in $GUI_BINS; do command -v "$b" >/dev/null 2>&1 || GUI_MISSING="$GUI_MISSING $b"; done
if [ -n "$GUI_MISSING" ]; then
  echo "MISSING-GUI-PACKAGES:$GUI_MISSING"
  echo "hint: apt-get install -y --no-install-recommends xvfb fluxbox xterm xdotool wmctrl ffmpeg fonts-dejavu-core"
  exit 3
fi
for b in $GUI_BINS sh xkbcomp; do copy_bin "$b"; done
# Xvfb requires xkeyboard-config data; fluxbox wants its system defaults.
mkdir -p "$R/usr/share" "$R/etc/X11"
cp -r /usr/share/X11 "$R/usr/share/" 2>/dev/null || true
cp -r /etc/X11/fluxbox "$R/etc/X11/" 2>/dev/null || true
# X sockets directory with the exact permissions X expects.
mkdir -p "$R/tmp/.X11-unix"
chmod 1777 "$R/tmp" "$R/tmp/.X11-unix"
# X apps need fontconfig config + at least one real font.
mkdir -p "$R/etc/fonts" "$R/usr/share/fonts/truetype"
cp -r /etc/fonts/* "$R/etc/fonts/" 2>/dev/null || true
if [ -d /usr/share/fonts/truetype/dejavu ]; then
  mkdir -p "$R/usr/share/fonts/truetype/dejavu"
  cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf "$R/usr/share/fonts/truetype/dejavu/" 2>/dev/null || true
fi
# xterm/fluxbox look for shell and system dirs; bash already present.
printf 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n' > "$R/etc/environment"

# The ELF interpreter is never listed by ldd — without it execvpe(/bin/bash) fails.
INTERP=$(readelf -l /bin/bash | sed -n 's/.*interpreter: \(.*\)]/\1/p' | head -1)
mkdir -p "$R$(dirname "$INTERP")"
cp -L "$INTERP" "$R$INTERP"

# usrmerge layout: expose binaries/libs under /bin and /lib too.
cp -a "$R/usr/bin/." "$R/bin/"
cp -a "$R/usr/lib/x86_64-linux-gnu/." "$R/lib/x86_64-linux-gnu/" 2>/dev/null || true

printf 'root:x:0:0:root:/root:/bin/bash\nloam:x:1000:1000:Loam Companion:/home/loam:/bin/bash\n' > "$R/etc/passwd"
printf 'root:x:0:\nloam:x:1000:\n' > "$R/etc/group"
printf '[user]\ndefault=loam\n[network]\ngenerateResolvConf=true\n' > "$R/etc/wsl.conf"
: > "$R/etc/fstab"
cp /etc/os-release "$R/etc/os-release" 2>/dev/null || true

# The isolated loam user (uid 1000) must own its home, and /tmp must be sticky-writable.
chown -R 1000:1000 "$R/home/loam"
chmod 700 "$R/home/loam"
chmod 1777 "$R/tmp" "$R/var/tmp"

test -x "$R/bin/bash" && test -e "$R/lib64/ld-linux-x86-64.so.2" && test -x "$R/bin/base64"
mkdir -p "$OUT_DIR"
tar -cf "$OUT_DIR/golden-linux.tar" -C "$R" .
du -sh "$OUT_DIR/golden-linux.tar"
echo BUILT-OK
