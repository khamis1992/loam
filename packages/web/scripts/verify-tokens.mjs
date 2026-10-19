import { readFileSync } from 'fs';

const spec = readFileSync('../../docs/BUILD_SPEC.md', 'utf8');
const css = readFileSync('src/styles/tokens.css', 'utf8');

const specBlock = spec.match(/```css\r?\n\/\* Values as observed[^`]*```/s)?.[0] || '';
const specHex = new Set((specBlock.match(/#[0-9a-fA-F]{3,8}/g) || []).map((h) => h.toLowerCase()));
const cssHex = new Set((css.match(/#[0-9a-fA-F]{3,8}/g) || []).map((h) => h.toLowerCase()));

const missing = [...specHex].filter((h) => !cssHex.has(h));
const extra = [...cssHex].filter((h) => !specHex.has(h));

console.log('Spec hex count:', specHex.size, 'CSS hex count:', cssHex.size);
console.log('Missing:', missing);
console.log('Extra:', extra);
if (missing.length > 0) process.exit(1);
