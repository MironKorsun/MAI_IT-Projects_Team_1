import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const revision = '360b1bab95c59fcbb133dab8b71ee3fe000cc7df';
const checkout = process.argv[2];
if (!checkout) throw new Error('Укажите путь к клону razrabotkaKIMEGE');
const source = (name) => execFileSync('git', ['-C', checkout, 'show', `${revision}:package/${name}`], { maxBuffer: 10 * 1024 * 1024 });
const manifest = JSON.parse(source('manifest.json'));
function verified(name) {
  const bytes = source(name);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.components[name].sha256) {
    throw new Error(`Контрольная сумма исходника не совпала: ${name}`);
  }
  return bytes;
}

const out = new URL('../kim/math-profile-bank/', import.meta.url);
mkdirSync(new URL('media/', out), { recursive: true });
const bank = JSON.parse(verified('tasks.json'));
writeFileSync(new URL('tasks.json.gz', out), gzipSync(JSON.stringify(bank), { level: 9 }));
const plan = JSON.parse(verified('variant_plan.json'));
plan.difficulty_distribution = { basic: 7, advanced: 5, high: 0 };
const time = [5, 5, 5, 4, 7, 5, 5, 4, 7, 10, 6, 10];
plan.positions.forEach((p) => { p.recommended_min = time[p.number - 1]; });
writeFileSync(new URL('variant_plan.json', out), JSON.stringify(plan, null, 2) + '\n');
for (const name of ['reference_materials.json', 'branching_tree.json']) {
  writeFileSync(new URL(name, out), verified(name));
}
const media = new Set(bank.variants.flatMap(v => v.tasks.map(t => t.content.image)).filter(Boolean));
for (const name of media) {
  if (!/^media\/[a-z0-9_-]+\.svg$/i.test(name)) throw new Error(`Недопустимое имя файла: ${name}`);
  writeFileSync(new URL(name, out), source(name));
}

// Инструкция платформы описывает реальные кнопки и автосохранение. Формулы
// из банка остаются в справочном разделе задания.
writeFileSync(new URL('instruction.md', out), readFileSync(new URL('../kim/math-profile-2026/instruction.md', import.meta.url)));
