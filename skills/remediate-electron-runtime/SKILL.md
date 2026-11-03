---
name: remediate-electron-runtime
description: "Electron bundled-Node remediation — تفاصيل البيئة لمسار الإصلاح المُتحقَّق (package.json electron dependency)"
triggers: ["electron remediation", "fix electron"]
---

# Electron bundled-Node remediation

## متى
package.json electron dependency — بعد أن يبدأ المستخدم remediation_start وينتظر الجرد.

## قواعد القنوات
Electron bundles its own Node — a host Node upgrade never fixes the app. The ONLY acceptable bump: an Electron release whose bundled Node >= the tracked pack's fixed version (verified from releases.electronjs.org), or a vendor advisory naming the CVE. A newer Electron version string alone is NOT evidence. Until then: vendor_update_required + watch releases/advisories, then bump electron, rebuild, re-sign, ship.

## الإسناد
Attribution: procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf. Rewritten for Loam; no upstream prose copied.
