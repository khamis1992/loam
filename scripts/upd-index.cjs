const fs = require('fs');
const p = process.env.USERPROFILE + '\.zcode\cli\memories\projects\manus-local-d1447920f09fcd03\memory\MEMORY.md';
let s = fs.readFileSync(p, 'utf8');
const from = '- [Rakazo comparison](rakazo-comparison.md) — rakazo repo NOT installed (only "Rakazo bubbles" CSS comment); our companions is independent; its model/voice/sandbox/Composio services not integrated; MCP exists app-wide only';
const to = '- [Rakazo comparison](rakazo-comparison.md) — rakazo NOT installed (CSS name only); 2026-10-19 update: live voice conversation EXISTS (now functionally verified, check:companions-voice) + cloudModel OpenAI-compatible/OpenRouter routing added (check:cloud-model); remaining gaps: mobile apps, cloud sandboxes, Composio breadth';
if (!s.includes(from)) { console.error('missing'); process.exit(1); }
fs.writeFileSync(p, s.replace(from, to));
console.log('index updated');
