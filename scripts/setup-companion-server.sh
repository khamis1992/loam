#!/usr/bin/env bash
# Turnkey 24/7 companion-device server (frontier section 4).
# Run ONCE on any Linux server you control; afterwards your Loam machine uses it
# for always-on companion devices by setting these two env vars on the Loam side:
#   LOAM_SSH_DEVICE=loam@<server-ip>          (add :port if not 22)
#   LOAM_SSH_BASE_DIR=/srv/loam-devices
#
# What it does:
#   1. creates a dedicated `loam` user (no sudo, unprivileged)
#   2. prepares /srv/loam-devices with per-device directories
#   3. hardens sshd for that user (key-only, no forwarding)
#   4. prints the exact Loam-side configuration to finish setup
#
# Requires: root on the server. Idempotent — safe to re-run.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0"; exit 1; }
SERVER_IP=$(hostname -I | awk '{print $1}')
SSH_PORT=$(ss -tlnp 2>/dev/null | grep -oP 'sshd.*?:\K[0-9]+' | head -1 || echo 22)
SSH_PORT=${SSH_PORT:-22}

id -u loam >/dev/null 2>&1 || useradd -m -s /bin/bash loam
mkdir -p /srv/loam-devices && chown loam:loam /srv/loam-devices && chmod 750 /srv/loam-devices

# Allow the companion user key auth only, no port/agent forwarding, no pty-abuse
LOAM_SSH_BLOCK='Match User loam
    AllowTCPForwarding no
    X11Forwarding no
    PermitTTY yes
    PasswordAuthentication no'
if ! grep -q "Match User loam" /etc/ssh/sshd_config; then
  printf '\n%s\n' "$LOAM_SSH_BLOCK" >> /etc/ssh/sshd_config
  systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true
fi

command -v sshd >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null; }

echo ""
echo "✅ Server ready at ${SERVER_IP}:${SSH_PORT}"
echo ""
echo "On your Loam machine (Windows), generate a key if you don't have one:"
echo "   ssh-keygen -t ed25519 -N \"\" -f %TEMP%\\loam-device-key"
echo ""
echo "Then authorize it here:"
echo "   sudo mkdir -p /home/loam/.ssh"
echo "   sudo bash -c 'cat /path/to/your/loam-device-key.pub >> /home/loam/.ssh/authorized_keys'"
echo "   sudo chown -R loam:loam /home/loam/.ssh && sudo chmod 700 /home/loam/.ssh && sudo chmod 600 /home/loam/.ssh/authorized_keys"
echo ""
echo "Finally set these on the Loam side (then restart Loam):"
echo "   set LOAM_SSH_DEVICE=loam@${SERVER_IP}:${SSH_PORT}"
echo "   set LOAM_SSH_BASE_DIR=/srv/loam-devices"
echo ""
echo "Companion devices created after that run on THIS server 24/7 —"
echo "they keep working when your PC is off (see docs/companions-frontier-progress.md)."
