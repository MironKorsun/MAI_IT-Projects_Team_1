import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STORAGE = 'memory';
process.env.KIM_MASTER_KEY = 'a1'.repeat(32); // 64 hex-символа
const { loadPackage, validateVariant } = await import('./loader');
const { seal, open, newVariantKey, unwrapVariantKey } = await import('./crypto');
const { isShortFormatValid } = await import('../../../shared/format');

const pkg = loadPackage('math-profile-2026');
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('манифест перечисляет варианты, все они проходят validateVariant без ошибок', () => {
  assert.ok(pkg.raws.length >= 1);
  assert.equal(pkg.raws.length, pkg.manifest.variants.length);
  for (const [i, raw] of pkg.raws.entries()) assert.deepEqual(validateVariant(raw), [], pkg.manifest.variants[i]);
});

test('каждый вариант: 12 заданий, номера 1..12 без повторов, все с кратким ответом', () => {
  for (const raw of pkg.raws) {
    assert.equal(raw.tasks.length, 12);
    assert.deepEqual(raw.tasks.map((t) => t.number).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
    assert.ok(raw.tasks.every((t) => t.type === 'short'));
  }
});

test('сумма максимальных баллов варианта равна 12', () => {
  for (const raw of pkg.raws) assert.equal(raw.tasks.reduce((s, t) => s + t.max_score, 0), 12);
});

test('эталоны допустимы по объявленному формату ответа', () => {
  for (const raw of pkg.raws)
    for (const t of raw.tasks) {
      assert.ok(t.answer.format, `${t.id}: формат`);
      assert.ok(t.answer.correct?.length, `${t.id}: эталон`);
      for (const c of t.answer.correct!) assert.ok(isShortFormatValid(t.answer.format!, c), `${t.id}: «${c}» (${t.answer.format})`);
    }
});

test('развёрнутое задание отвергается validateVariant', () => {
  const v = clone(pkg.raws[0]);
  v.tasks[11] = { ...v.tasks[11], type: 'extended', part: 2, answer: { criteria: [{ score: 1, description: 'критерий' }] } };
  const errors = validateVariant(v);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((e) => e.pointer.startsWith('/')));
});

test('сломанный вариант: нет поля или неверный формат эталона — ошибка с указателем', () => {
  const missing: any = clone(pkg.raws[0]);
  delete missing.tasks[0].max_score;
  const e1 = validateVariant(missing);
  assert.ok(e1.length > 0 && e1.every((e) => e.pointer && e.detail));

  const bad = clone(pkg.raws[0]);
  bad.tasks[1].answer = { format: 'integer', compare: 'number', correct: ['abc'] };
  const e2 = validateVariant(bad);
  assert.ok(e2.some((e) => e.pointer === '/tasks/1/answer/correct'), JSON.stringify(e2));
});

test('повтор номера задания даёт ошибку с указателем на number', () => {
  const v = clone(pkg.raws[0]);
  v.tasks[1].number = v.tasks[0].number;
  assert.ok(validateVariant(v).some((e) => e.pointer === '/tasks/1/number'));
});

test('справочные материалы, на которые ссылаются задания, есть в references.json', () => {
  const ids = new Set(pkg.references.map((r) => r.id));
  assert.ok(ids.size > 0);
  for (const raw of pkg.raws)
    for (const t of raw.tasks) for (const id of t.reference_ids ?? []) assert.ok(ids.has(id), `${t.id}: ${id}`);
});

test('криптомодуль: шифрование и расшифровка возвращают исходный текст', () => {
  const { key } = newVariantKey();
  const plain = Buffer.from('Условие задания: sin A = 0,8', 'utf8');
  assert.deepEqual(open(key, seal(key, plain)), plain);
});

test('криптомодуль: ключ варианта разворачивается мастер-ключом', () => {
  const { key, wrapped } = newVariantKey();
  assert.deepEqual(unwrapVariantKey(wrapped), key);
});

test('криптомодуль: подмена шифртекста или чужой ключ — open() бросает ошибку', () => {
  const { key } = newVariantKey();
  const s = seal(key, Buffer.from('секрет'));
  const raw = Buffer.from(s.data, 'base64');
  raw[0] ^= 0xff;
  assert.throws(() => open(key, { ...s, data: raw.toString('base64') }));
  assert.throws(() => open(newVariantKey().key, s));
});
