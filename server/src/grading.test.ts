import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.STORAGE = 'memory';
const { normalizeShort, compareShort, validateScale } = await import('./grading');
const { audit, verifyChain } = await import('./audit');
const { db } = await import('./db');
import type { StoredTask } from './db';

const task = (values: string[], compare: StoredTask['compare'] = 'number'): StoredTask => ({
  id: 't', number: 1, part: 1, type: 'short', topic: '1', difficulty: 'basic', maxScore: 1, condition: '', compare,
  correct: [{ version: 1, values, at: '' }], referenceIds: [], author: '',
});

test('нормализация краткого ответа: разделитель, минус, пробелы, ведущие нули (ДП-11)', () => {
  assert.equal(normalizeShort(' 0,50 '), '0.5');
  assert.equal(normalizeShort('−4'), '-4');
  assert.equal(normalizeShort('007'), '7');
  assert.equal(normalizeShort('-0'), '0');
  assert.equal(normalizeShort('Ёлка'), 'елка');
});

test('сравнение с эталоном: число, последовательность, набор (ТЗ СЧ FR-32)', () => {
  assert.equal(compareShort(task(['0.8']), '0,8').score, 1);
  assert.equal(compareShort(task(['0.8']), '0,80').score, 1);
  assert.equal(compareShort(task(['0.8']), '8').score, 0);
  assert.equal(compareShort(task(['0.8']), '').score, 0);
  assert.equal(compareShort(task(['123'], 'sequence'), '321').score, 0);
  assert.equal(compareShort(task(['123'], 'set'), '321').score, 1);
  assert.match(compareShort(task(['5']), '5').protocol, /эталон/);
});

test('проверка шкалы: неубывание, диапазон, полнота (ТЗ АО ТС-02)', () => {
  assert.equal(validateScale('test', [0, 10, 20], 10, 2).length, 0);
  assert.ok(validateScale('test', [0, 30, 20], 10, 2).some((e) => /неубывание/.test(e.detail)));
  assert.ok(validateScale('test', [0, 10, 120], 10, 2).some((e) => /диапазона/.test(e.detail)));
  assert.ok(validateScale('test', [0, 10], 10, 2).length > 0);
  assert.ok(validateScale('grade', [2, 3, 6], 3, 2).length > 0);
});

test('журнал событий: цепочка хэшей обнаруживает изменение записи (ТЗ СЧ NFR-25)', () => {
  db.audit = [];
  for (let i = 0; i < 5; i++) audit({ type: 'test', category: 'Тест', actorRole: 'system', object: String(i) });
  assert.equal(verifyChain().ok, true);
  db.audit[2].object = 'подмена';
  const r = verifyChain();
  assert.equal(r.ok, false);
  assert.equal(r.brokenAt, 2);
});

test('импорт КИМ: задания с развёрнутым ответом отклоняются (ТЗ СЧ 3.1)', async () => {
  const { validateVariant } = await import('./kim/loader');
  const variant = {
    variant: 9,
    examCode: 'math-profile',
    title: 'Тест',
    tasks: [
      { id: 'x1', number: 1, part: 1, topic_code: '1.1', type: 'short', difficulty: 'basic', max_score: 1, content: { condition: '2+2' }, answer: { format: 'integer', compare: 'number', correct: ['4'] }, author: 'т' },
      { id: 'x2', number: 2, part: 2, topic_code: '2.1', type: 'extended', difficulty: 'high', max_score: 2, content: { condition: 'Решите' }, answer: { criteria: [{ score: 0, description: '-' }, { score: 2, description: '+' }] }, author: 'т' },
    ],
  };
  const errors = validateVariant(variant);
  assert.equal(errors.length, 1);
  assert.match(errors[0].detail, /кратким ответом/);
});
