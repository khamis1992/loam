import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { auditComponentSource } from './audit.mjs';

const COMPONENTS_DIR = new URL('../../src/components', import.meta.url);

function* walkDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(path);
    } else if (entry.isFile() && extname(path) === '.tsx') {
      yield path;
    }
  }
}

let exitCode = 0;
let checked = 0;

try {
  if (!statSync(COMPONENTS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    console.log('No packages/web/src/components directory yet; nothing to lint.');
    process.exit(0);
  }

  for (const file of walkDir(COMPONENTS_DIR)) {
    checked++;
    const source = readFileSync(file, 'utf-8');
    const findings = auditComponentSource(source, file);
    if (findings.length) {
      exitCode = 1;
      console.log(`\n${file}`);
      for (const f of findings) {
        console.log(`  line ${f.line}, col ${f.column}: "${f.text}"`);
      }
    }
  }
} catch (err) {
  console.error(`Lint failed: ${err.message}`);
  process.exit(1);
}

if (exitCode === 0) {
  console.log(`i18n lint passed (${checked} component files checked).`);
} else {
  console.log('\nHard-coded UI strings found. Wrap user-visible text with t().');
}

process.exit(exitCode);
