import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config';
import { validateVariant } from './loader';

/** Автономная валидация банка КИМ (ТЗ КИМ FR-23, NFR-01, NFR-06). */
let failed = 0;
for (const pkg of readdirSync(config.kimDir, { withFileTypes: true })) {
  if (!pkg.isDirectory() || pkg.name === 'schema') continue;
  const tasksDir = resolve(config.kimDir, pkg.name, 'tasks');
  for (const f of readdirSync(tasksDir).filter((x) => x.endsWith('.json'))) {
    const t0 = performance.now();
    const errors = validateVariant(JSON.parse(readFileSync(resolve(tasksDir, f), 'utf8')));
    const ms = (performance.now() - t0).toFixed(1);
    if (errors.length) {
      failed++;
      console.log(`✗ ${pkg.name}/${f} (${ms} мс)`);
      for (const e of errors) console.log(`   ${e.pointer}: ${e.detail}`);
    } else console.log(`✓ ${pkg.name}/${f} (${ms} мс)`);
  }
}
process.exit(failed ? 1 : 0);
