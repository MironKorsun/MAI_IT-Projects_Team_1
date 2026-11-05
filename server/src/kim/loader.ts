import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ReferenceMaterial, TaskView, VariantContent } from '../../../shared/types';
import { FORMAT_HINT } from '../../../shared/format';
import type { KimVariant, StoredTask } from '../db';
import { config } from '../config';
import { sha256, uuid, nowIso } from '../util';
import { newVariantKey, seal } from './crypto';

export interface RawTask {
  id: string;
  number: number;
  part: 1 | 2;
  topic_code: string;
  type: 'short' | 'extended' | 'multiple_choice' | 'matching';
  difficulty: 'basic' | 'advanced' | 'high';
  max_score: number;
  content: { condition: string; question?: string; options?: string[]; image?: string };
  answer: {
    format?: 'integer' | 'decimal' | 'digits' | 'word';
    compare?: 'number' | 'sequence' | 'set';
    correct?: string[];
    criteria?: { score: number; description: string }[];
  };
  reference_ids?: string[];
  author: string;
}

export interface RawVariant { variant: number; examCode: string; title: string; tasks: RawTask[] }

interface RawReference {
  id: string;
  topic_code: string;
  kind: 'formula' | 'table' | 'constant';
  title: string;
  content: { latex?: string; rows?: string[][] };
  task_ids: string[];
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
let validator: ReturnType<typeof ajv.compile> | undefined;

function schema() {
  if (!validator) {
    validator = ajv.compile(JSON.parse(readFileSync(resolve(config.kimDir, 'schema/kim.schema.json'), 'utf8')));
  }
  return validator;
}

const ALLOWED_TAGS = /<\/?(b|i|em|strong|sub|sup|br|p|ul|ol|li|span)\s*\/?>/gi;

/**
 * Проверка варианта (ТЗ СЧ FR-28; ТЗ КИМ FR-23): схема, эталоны по формату, критерии, уникальность номеров.
 * Возвращает перечень ошибок с путём к полю.
 */
export function validateVariant(raw: unknown): { pointer: string; detail: string }[] {
  const v = schema();
  const errors: { pointer: string; detail: string }[] = [];
  if (!v(raw)) {
    for (const e of v.errors ?? []) errors.push({ pointer: e.instancePath || '/', detail: `${e.instancePath || '/'} ${e.message}` });
    return errors;
  }
  const variant = raw as RawVariant;
  const numbers = new Set<number>();
  variant.tasks.forEach((t, i) => {
    const p = `/tasks/${i}`;
    if (numbers.has(t.number)) errors.push({ pointer: `${p}/number`, detail: `Повтор номера задания ${t.number}` });
    numbers.add(t.number);
    if (t.type === 'short') {
      for (const c of t.answer.correct ?? []) {
        const okNum = /^-?\d+([.,]\d+)?$/.test(c);
        if (t.answer.format !== 'word' && !okNum)
          errors.push({ pointer: `${p}/answer/correct`, detail: `Эталон «${c}» не соответствует формату ${t.answer.format}` });
      }
    }
    // Платформа проводит экзамен только с заданиями с кратким ответом, проверяемыми автоматически (ТЗ СЧ 3.1, 3.4 п. 1)
    if (t.type !== 'short' || t.part !== 1)
      errors.push({ pointer: `${p}/type`, detail: `Задание ${t.number}: поддерживаются только задания части 1 с кратким ответом` });
    const stripped = t.content.condition.replace(ALLOWED_TAGS, '');
    if (/<[a-z/!]/i.test(stripped))
      errors.push({ pointer: `${p}/content/condition`, detail: 'Условие содержит недопустимую HTML-разметку' });
  });
  return errors;
}

function toTaskView(t: RawTask): TaskView {
  return {
    id: t.id,
    number: t.number,
    part: t.part,
    type: 'short',
    format: t.answer.format,
    formatHint: t.answer.format ? FORMAT_HINT[t.answer.format] : undefined,
    maxScore: t.max_score,
    topic: t.topic_code,
    condition: t.content.condition,
    question: t.content.question,
    image: t.content.image,
    referenceIds: t.reference_ids,
  };
}

function toStoredTask(t: RawTask): StoredTask {
  return {
    id: t.id,
    number: t.number,
    part: t.part,
    type: 'short',
    topic: t.topic_code,
    difficulty: t.difficulty,
    maxScore: t.max_score,
    condition: '',
    format: t.answer.format,
    compare: t.answer.compare,
    correct: t.answer.correct ? [{ version: 1, values: t.answer.correct, at: nowIso() }] : undefined,
    referenceIds: t.reference_ids ?? [],
    author: t.author,
  };
}

export function loadReferences(dir: string): ReferenceMaterial[] {
  const raw = JSON.parse(readFileSync(resolve(dir, 'reference_materials/references.json'), 'utf8')) as RawReference[];
  return raw.map((r) => ({ id: r.id, kind: r.kind, title: r.title, latex: r.content.latex, rows: r.content.rows }));
}

/** Импорт варианта: открытый текст шифруется ключом варианта, эталоны отделяются (ТЗ СЧ FR-28, FR-29, NFR-21). */
export function buildVariant(raw: RawVariant, references: ReferenceMaterial[]): KimVariant {
  const id = uuid();
  const content: VariantContent = {
    variantId: id,
    number: raw.variant,
    examCode: raw.examCode,
    title: raw.title,
    tasks: raw.tasks.map(toTaskView).sort((a, b) => a.number - b.number),
    references: references.filter((r) => raw.tasks.some((t) => t.reference_ids?.includes(r.id))),
  };
  const plain = Buffer.from(JSON.stringify(content), 'utf8');
  const { key, wrapped } = newVariantKey();
  return {
    id,
    examCode: raw.examCode,
    number: raw.variant,
    title: raw.title,
    encrypted: seal(key, plain),
    wrappedKey: wrapped,
    keys: raw.tasks.map(toStoredTask).sort((a, b) => a.number - b.number),
    importedAt: nowIso(),
    checksum: sha256(plain),
  };
}

export function loadPackage(name = 'math-profile-2026') {
  const dir = resolve(config.kimDir, name);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as { variants: string[] };
  const references = loadReferences(dir);
  const raws = manifest.variants.map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as RawVariant);
  return { dir, manifest, references, raws };
}
