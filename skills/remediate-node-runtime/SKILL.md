---
name: remediate-node-runtime
description: "Node.js runtime remediation — تفاصيل البيئة لمسار الإصلاح المُتحقَّق (Node images, .nvmrc, setup-node, Lambda nodejs runtimes)"
triggers: ["node remediation", "fix node"]
---

# Node.js runtime remediation

## متى
Node images, .nvmrc, setup-node, Lambda nodejs runtimes — بعد أن يبدأ المستخدم remediation_start وينتظر الجرد.

## قواعد القنوات
Bump the same major's fixed patch, keep the variant suffix (-alpine/-slim/-bookworm). Version files (.nvmrc/.node-version/.tool-versions/Volta) all move together. setup-node floating: add check-latest or pin. Floating tags: do NOT change the tag; require --pull --no-cache rebuild + record the new digest. Digest pins: resolve and pin the new digest; multi-arch records the index digest. Distro packages: vendor changelog numbers, never upstream version strings. engines.node is a constraint — leave it. EOL lines (20/18) need a major upgrade: report separately, only with explicit approval. Electron apps bundle their own Node — flag vendor_update_required, never patch the host Node and claim the app fixed.

## الإسناد
Attribution: procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf. Rewritten for Loam; no upstream prose copied.
