import { TextDecoder } from 'node:util';
import { fromBuffer } from 'yauzl';
import { zipSync } from 'fflate';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { KimPosition } from '../../../shared/kim';
import { sha256 } from '../util';
import { invalid } from '../errors';
import { toReference, validateVariant, type RawReference, type RawVariant } from './loader';

const TASKS = 'tasks/variant.json';
const PLAN = 'variant_plan.json';
const TREE = 'branching_tree.json';
const REFERENCES = 'reference_materials.json';
const INSTRUCTION = 'instruction.md';
const MANIFEST = 'manifest.json';
const required = [TASKS, PLAN, TREE, REFERENCES, INSTRUCTION];
const MEDIA = /^media\/[a-z0-9_-]+\.svg$/i;
export const MAX_ZIP_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024;
const MAX_ENTRIES = 40;
const decoder = new TextDecoder('utf-8', { fatal: true });

interface Plan {
  exam_type: 'EGE';
  subject_code: '02';
  exam_duration_min: 235;
  total_tasks: 12;
  max_primary_score: 12;
  difficulty_distribution: { basic: 7; advanced: 5; high: 0 };
  positions: KimPosition[];
}

interface Tree {
  nodes: {
    position: number;
    alternatives: { topic_code: string; difficulty: string; type: string; max_score: number }[];
  }[];
}

interface Manifest {
  schemaVersion: 1;
  examCode: 'math-profile';
  version: string;
  createdAt: string;
  author: string;
  components: Record<string, string>;
}

const ajv = new Ajv2020();
const topic = { type: 'string', pattern: '^\\d+\\.\\d+$' };
const difficulty = { enum: ['basic', 'advanced'] };
const number = { type: 'integer', minimum: 1, maximum: 12 };
const array = (items: object, minItems = 1) => ({ type: 'array', items, minItems });
const object = (properties: Record<string, object>) => ({ type: 'object', required: Object.keys(properties), properties });
const string = { type: 'string', minLength: 1 };
const planShape = ajv.compile<Plan>(object({
  exam_type: { const: 'EGE' },
  subject_code: { const: '02' },
  exam_duration_min: { const: 235 },
  total_tasks: { const: 12 },
  max_primary_score: { const: 12 },
  difficulty_distribution: object({ basic: { const: 7 }, advanced: { const: 5 }, high: { const: 0 } }),
  positions: {
    ...array(object({
      number, part: { const: 1 }, type: { const: 'short' }, difficulty, max_score: { const: 1 },
      recommended_min: { type: 'integer', minimum: 1, maximum: 235 },
      topic_options: array(object({ topic_code: topic })),
    }), 12),
    maxItems: 12,
  },
}));
const treeShape = ajv.compile<Tree>(object({
  nodes: {
    ...array(object({
      position: number,
      alternatives: array(object({ topic_code: topic, type: { const: 'short' }, difficulty, max_score: { const: 1 } })),
    }), 12),
    maxItems: 12,
  },
}));
const referenceShape = ajv.compile<{ materials: RawReference[] }>(object({
  materials: array({
    type: 'object',
    required: ['id', 'topic_code', 'kind', 'title', 'task_ids', 'content'],
    properties: {
      id: string, topic_code: topic, kind: { enum: ['formula', 'table', 'constant'] }, title: string, task_ids: array(string, 0),
      content: {
        type: 'object',
        properties: { latex: { anyOf: [string, array(string)] }, rows: array(array({ type: 'string' })) },
        anyOf: [{ required: ['latex'] }, { required: ['rows'] }],
      },
    },
  }, 0),
}));
const manifestShape = ajv.compile<Manifest>(object({
  schemaVersion: { const: 1 },
  examCode: { const: 'math-profile' },
  version: { type: 'string', maxLength: 24, pattern: '^\\d+\\.\\d+\\.\\d+$' },
  createdAt: string,
  author: string,
  components: { type: 'object', additionalProperties: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
}));

function fail(pointer: string, detail: string): never {
  throw invalid([{ pointer: `/${pointer}`, detail }], 'IMPORT_INVALID', 422);
}

function readZip(archive: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    fromBuffer(archive, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      const badZip = () => reject(invalid([{ pointer: '/archive', detail: 'Повреждённый ZIP-архив' }], 'IMPORT_INVALID', 422));
      if (error || !zip) return badZip();
      const files = new Map<string, Buffer>();
      let total = 0;
      zip.on('error', badZip);
      zip.on('end', () => resolve(files));
      if (zip.entryCount > MAX_ENTRIES) {
        zip.close();
        reject(invalid([{ pointer: '/archive', detail: 'Слишком много файлов в пакете' }], 'IMPORT_INVALID', 422));
        return;
      }
      zip.on('entry', (entry) => {
        const name = entry.fileName;
        if (['tasks/', 'media/'].includes(name) && !entry.uncompressedSize) {
          zip.readEntry();
          return;
        }
        total += entry.uncompressedSize;
        if ((!required.includes(name) && name !== MANIFEST && !MEDIA.test(name)) || files.has(name) || total > MAX_EXTRACTED_BYTES) {
          zip.close();
          reject(invalid([{ pointer: `/${name}`, detail: 'Лишний файл, повтор имени или превышение размера пакета' }], 'IMPORT_INVALID', 422));
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            zip.close();
            badZip();
            return;
          }
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('error', () => { zip.close(); badZip(); });
          stream.on('end', () => {
            files.set(name, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

function fileText(files: Map<string, Buffer>, name: string): string {
  const bytes = files.get(name);
  if (!bytes) fail(name, 'Обязательный файл отсутствует');
  try {
    return decoder.decode(bytes);
  } catch {
    return fail(name, 'Ожидается текст в UTF-8');
  }
}

function jsonFile(files: Map<string, Buffer>, name: string): unknown {
  const text = fileText(files, name);
  try {
    return JSON.parse(text);
  } catch {
    return fail(name, 'Неверный JSON');
  }
}

export function isKimMediaPath(name: string) {
  return MEDIA.test(name);
}

function validatePlan(variant: RawVariant, plan: Plan, tree: Tree) {
  if (variant.tasks.length !== plan.total_tasks) fail(TASKS, 'Нужно ровно 12 заданий');
  const positions = new Map(plan.positions.map(p => [p.number, p]));
  const nodes = new Map(tree.nodes.map(n => [n.position, n]));
  if (positions.size !== 12 || nodes.size !== 12) fail(PLAN, 'Позиции плана и дерева должны быть уникальными');
  if (plan.positions.filter(p => p.difficulty === 'basic').length !== 7) fail(PLAN, 'Ожидается 7 базовых и 5 повышенных позиций');
  if (plan.positions.reduce((sum, p) => sum + p.recommended_min, 0) > plan.exam_duration_min)
    fail(PLAN, 'Сумма нормативов превышает длительность экзамена');
  for (const task of variant.tasks) {
    const position = positions.get(task.number);
    const node = nodes.get(task.number);
    if (!position || task.part !== position.part || task.type !== position.type || task.max_score !== position.max_score
      || task.difficulty !== position.difficulty || !position.topic_options.some(t => t.topic_code === task.topic_code)) {
      fail(`${TASKS}/${task.number}`, 'Задание не соответствует позиции плана');
    }
    const topics = new Set(position.topic_options.map(t => t.topic_code));
    if (!node || node.alternatives.length !== topics.size || new Set(node.alternatives.map(n => n.topic_code)).size !== topics.size
      || node.alternatives.some(n => !topics.has(n.topic_code) || n.difficulty !== position.difficulty)) {
      fail(`${TREE}/${task.number}`, 'Темы или сложность узла не соответствуют плану');
    }
  }
}

export async function readKimArchive(archive: Buffer) {
  if (!archive.length || archive.length > MAX_ZIP_BYTES) fail('archive', 'Выберите ZIP размером до 2 МиБ');
  const files = await readZip(archive);
  const rawManifest = jsonFile(files, MANIFEST);
  if (!manifestShape(rawManifest)) fail(MANIFEST, 'Ожидается манифест версии схемы 1. Соберите пакет заново в редакторе');
  const manifest = rawManifest;
  for (const name of required) {
    if (!files.has(name)) fail(name, 'Обязательный файл отсутствует');
  }
  if (Object.keys(manifest.components).length !== files.size - 1) fail(MANIFEST, 'Состав манифеста не совпадает с архивом');
  for (const [name, bytes] of files) {
    if (name !== MANIFEST && sha256(bytes) !== manifest.components[name]) fail(name, 'Контрольная сумма SHA-256 не совпадает');
  }
  const rawVariant = jsonFile(files, TASKS);
  const errors = validateVariant(rawVariant);
  if (errors.length) throw invalid(errors.map(e => ({ ...e, pointer: `/${TASKS}${e.pointer}` })), 'IMPORT_INVALID', 422);
  const variant = rawVariant as RawVariant;
  if (variant.examCode !== manifest.examCode) fail(TASKS, 'Код экзамена не совпадает с манифестом');
  const plan = jsonFile(files, PLAN);
  if (!planShape(plan)) fail(PLAN, 'Неверный формат плана профильной математики');
  const tree = jsonFile(files, TREE);
  if (!treeShape(tree)) fail(TREE, 'Неверный формат дерева ветвления');
  validatePlan(variant, plan, tree);
  const referenceFile = jsonFile(files, REFERENCES);
  if (!referenceShape(referenceFile)) fail(REFERENCES, 'Неверный формат справочных материалов');
  const { materials } = referenceFile;
  const byRef = new Map(materials.map(r => [r.id, r]));
  if (byRef.size !== materials.length) fail(REFERENCES, 'Идентификаторы материалов повторяются');
  const tasks = new Map(variant.tasks.map(t => [t.id, t]));
  for (const ref of materials) {
    if (ref.task_ids.some(id => !tasks.get(id)?.reference_ids?.includes(ref.id))) fail(REFERENCES, 'Справка ссылается на неизвестное задание');
  }
  const images = new Map<string, Buffer>();
  for (const task of variant.tasks) {
    for (const id of task.reference_ids ?? []) {
      if (!byRef.get(id)?.task_ids.includes(task.id)) fail(REFERENCES, 'Задание ссылается на отсутствующий справочный материал');
    }
    const path = task.content.image;
    if (!path) continue;
    if (!isKimMediaPath(path)) fail(TASKS, 'Чертёж должен ссылаться на SVG в каталоге media');
    const image = fileText(files, path);
    if (!/^\s*(?:<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(image) || /<!\s*(?:doctype|entity)/i.test(image)) fail(path, 'Ожидается SVG без внешних сущностей');
    images.set(path, files.get(path)!);
  }
  for (const name of files.keys()) {
    if (isKimMediaPath(name) && !images.has(name)) fail(name, 'Чертёж не используется в варианте');
  }
  const byteCount = Array.from(files).reduce((sum, [name, value]) => sum + (isKimMediaPath(name) ? 0 : value.length), 0);
  if (byteCount > 500_000) fail('archive', 'Размер пакета без медиа превышает 500 КБ');
  const instruction = fileText(files, INSTRUCTION).replace(/\r\n/g, '\n').trim();
  if (!instruction || instruction.length > 32_000) fail(INSTRUCTION, 'Инструкция должна содержать от 1 до 32 000 символов');
  const digest = sha256(JSON.stringify([manifest.version, Object.entries(manifest.components).sort()]));
  return { variant, references: materials.map(toReference), images, instruction, digest, version: manifest.version };
}

export function makeKimArchive(variant: RawVariant, plan: object, tree: object, references: RawReference[], instruction: string, images: ReadonlyMap<string, Buffer>, version = '1.0.0') {
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const files = new Map<string, Buffer>([
    [TASKS, json(variant)],
    [PLAN, json(plan)],
    [TREE, json(tree)],
    [REFERENCES, json({ materials: references })],
    [INSTRUCTION, Buffer.from(instruction)],
    ...images,
  ]);
  const manifest: Manifest = {
    schemaVersion: 1,
    examCode: 'math-profile',
    version,
    createdAt: new Date().toISOString(),
    author: 'Отдел разработки КИМ · учебный стенд',
    components: Object.fromEntries(Array.from(files, ([name, bytes]) => [name, sha256(bytes)])),
  };
  files.set(MANIFEST, json(manifest));
  return Buffer.from(zipSync(Object.fromEntries(files), { level: 6 }));
}
