// Apply the schema. Run once per database: `npm run migrate`.
// Idempotent (everything is IF NOT EXISTS), so re-running is safe.
import 'dotenv/config';
import { migrate, close } from '../src/db/index.js';
import { log } from '../src/logger.js';

const logger = log('migrate');

if (!process.env.DATABASE_URL) {
   logger.error('DATABASE_URL not set — nothing to migrate (PGlite dev databases migrate on npm start)');
   process.exit(1);
}

// A freshly provisioned endpoint (Neon, Supabase) can refuse the first connection
// or two while it wakes up, and the driver surfaces that as an error with no
// message. Retry briefly, and never swallow a reason.
const describe = (e) =>
   e?.message || e?.code || e?.errors?.map((x) => x.message || x.code).join('; ') || String(e);

for (let attempt = 1; attempt <= 4; attempt++) {
   try {
      await migrate();
      logger.ok('schema applied');
      break;
   } catch (e) {
      if (attempt === 4) {
         logger.error(`migrate failed after ${attempt} attempts: ${describe(e)}`);
         process.exitCode = 1;
         break;
      }
      logger.warn(`attempt ${attempt} failed (${describe(e)}) — retrying in 3s`);
      await close().catch(() => {});
      await new Promise((r) => setTimeout(r, 3000));
   }
}

await close().catch(() => {});
