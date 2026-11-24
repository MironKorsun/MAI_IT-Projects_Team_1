import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config';
import { validateVariant } from './loader';
import { buildBankSelection, kimBank } from './bank';
import { readKimArchive } from './package';

/** Автономная валидация банка КИМ (ТЗ КИМ FR-23, NFR-01, NFR-06). */
let failed = 0;
for (const pkg of readdirSync(config.kimDir, { withFileTypes: true })) {
  if (!pkg.isDirectory() || pkg.name === 'schema') continue;
  const tasksDir = resolve(config.kimDir, pkg.name, 'tasks');
  if (!existsSync(tasksDir)) continue;
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
if (existsSync(resolve(config.kimDir, 'math-profile-bank'))) {
  const bank = kimBank();
  for (let start = 0; start < bank.tasks.length; start += bank.info.positions.length) {
    const tasks = bank.tasks.slice(start, start + bank.info.positions.length);
    const errors = validateVariant({ variant: start + 1, examCode: bank.info.examCode, title: 'Учебный банк', tasks });
    if (errors.length) {
      failed++;
      console.error(tasks[0]?.id, errors);
    }
  }
  try {
    await readKimArchive(buildBankSelection(bank.info.demo).archive());
    console.log(`✓ math-profile-bank: ${bank.info.variants} вариантов, ${bank.info.taskCount} заданий, пакет № 666`);
  } catch (error) {
    failed++;
    console.error(error);
  }
}
process.exitCode = failed ? 1 : 0;
