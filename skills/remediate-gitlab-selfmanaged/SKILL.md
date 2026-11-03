---
name: remediate-gitlab-selfmanaged
description: "GitLab self-managed remediation — تفاصيل البيئة لمسار الإصلاح المُتحقَّق (gitlab-ee/ce images, CNG, Helm charts, Omnibus, Operator)"
triggers: ["gitlab remediation", "fix gitlab"]
---

# GitLab self-managed remediation

## متى
gitlab-ee/ce images, CNG, Helm charts, Omnibus, Operator — بعد أن يبدأ المستخدم remediation_start وينتظر الجرد.

## قواعد القنوات
Image tag: gitlab/gitlab-ee:<ver>-ee.0 (or ce). Helm: bump the CHART version from the official version-mapping page — not just global.gitlabVersion; regenerate lock/render. Omnibus: pin gitlab-ee=<ver>-ee.0. Upgrade-path stops are REQUIRED (toolbox upgrade-path tool); multi-stop only with approval. Single-node: maintenance window + backup first; multi-node: zero-downtime order. Post-deploy checklist for the user (gitlab-rake checks) — Remediate NEVER runs commands against production. Runner/Agent are out of scope.

## الإسناد
Attribution: procedure derived from CognitionAI/devin-vuln-fixes (MIT, © 2026 Cognition AI, Inc.), commit 39a04007a1cb19aafd3c487d615c524479963ebf. Rewritten for Loam; no upstream prose copied.
