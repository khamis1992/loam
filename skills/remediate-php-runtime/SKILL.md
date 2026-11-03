---
name: remediate-php-runtime
description: "PHP runtime remediation — تفاصيل البيئة لمسار الإصلاح المُتحقَّق (php: images, php* packages, setup-php, composer)"
triggers: ["php remediation", "fix php"]
---

# PHP runtime remediation

## متى
php: images, php* packages, setup-php, composer — بعد أن يبدأ المستخدم remediation_start وينتظر الجرد.

## قواعد القنوات
Same minor, keep variant (-fpm/-apache/-alpine/-bookworm). Distro: known backports (Debian bookworm 8.2.35-1~deb12u1, Ubuntu noble/jammy releases); record package release + changelog entry. Ansible/Chef/Puppet state=present NEVER upgrades — use latest or pin, then restart. Source: fixed tarball + verify php.net SHA-256. Temporary mitigations (NOT fixes): session.upload_progress.enabled=0 then restart workers; 8.5 fatal_error_backtraces=0; post_max_size 8M/32M; proxy limits; memory_limit=-1 with a cgroup cap. NEVER present a mitigation as a fix; RLIMIT_AS/RLIMIT_DATA trigger the bug — forbidden.

## الإسناد
Attribution: procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf. Rewritten for Loam; no upstream prose copied.
