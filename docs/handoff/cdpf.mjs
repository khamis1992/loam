import fs from 'fs';const f=process.argv[2];process.argv=[process.argv[0],'cdp.mjs','eval','--js',fs.readFileSync(f,'utf8').replace(/^\uFEFF/,'')];await import('./cdp.mjs');
