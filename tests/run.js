// Runs every *.test.js in this directory, each in its own process so their
// module-level database connections stay isolated.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const file of files) {
   const { status } = spawnSync(process.execPath, [path.join(dir, file)], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: { ...process.env, NO_COLOR: '1' },
   });
   if (status !== 0) failed++;
}

console.log(failed ? `\n${failed}/${files.length} suite(s) FAILED` : `\nall ${files.length} suites passed`);
process.exit(failed ? 1 : 0);
