import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { KimEditorInfo, KimPosition, KimSelection } from '../../../shared/kim';
import { config } from '../config';
import { invalid } from '../errors';
import { toReference, toTaskView, type RawReference, type RawTask, type RawVariant } from './loader';
import { isKimMediaPath, makeKimArchive } from './package';

function loadBank() {
  const dir = resolve(config.kimDir, 'math-profile-bank');
  const read = (name: string) => readFileSync(resolve(dir, name));
  const json = (name: string) => JSON.parse(read(name).toString('utf8'));
  const source = JSON.parse(gunzipSync(read('tasks.json.gz')).toString('utf8')) as {
    variants: Omit<RawVariant, 'examCode'>[];
  };
  const plan = json('variant_plan.json') as { positions: KimPosition[]; subject: string; exam_duration_min: number };
  const tree = json('branching_tree.json') as {
    nodes: { position: number; alternatives: { topic_code: string }[] }[];
  };
  const references = (json('reference_materials.json') as { materials: RawReference[] }).materials;
  const tasks = source.variants.flatMap(v => v.tasks);
  const byId = new Map(tasks.map(t => [t.id, t]));
  const instruction = read('instruction.md').toString('utf8');
  const info: KimEditorInfo = {
    examCode: 'math-profile',
    subject: plan.subject,
    duration: plan.exam_duration_min,
    variants: source.variants.length,
    taskCount: tasks.length,
    topics: [...new Set(tasks.map(t => t.topic_code))].sort(),
    positions: plan.positions,
    demo: json('demo-666.json') as KimSelection,
  };
  const media = new Map<string, Buffer>();
  for (const task of tasks) {
    const name = task.content.image;
    if (name && isKimMediaPath(name) && !media.has(name)) media.set(name, read(name));
  }
  return { tasks, byId, plan, tree, references, instruction, info, media };
}

let cached: ReturnType<typeof loadBank> | undefined;
export function kimBank() {
  return (cached ??= loadBank());
}

function fits(task: RawTask, position: KimPosition) {
  return task.number === position.number && task.type === position.type && task.part === position.part
    && task.max_score === position.max_score && task.difficulty === position.difficulty
    && position.topic_options.some(t => t.topic_code === task.topic_code);
}

export function buildBankSelection(selection: KimSelection) {
  const bank = kimBank();
  const tasks: RawTask[] = [];
  const errors: { pointer: string; detail: string }[] = [];
  bank.plan.positions.forEach((p, index) => {
    const task = bank.byId.get(selection.taskIds[index]);
    const node = bank.tree.nodes.find(n => n.position === p.number);
    if (!task || !fits(task, p) || !node?.alternatives.some(a => a.topic_code === task.topic_code)) {
      errors.push({ pointer: `/taskIds/${index}`, detail: `Позиция ${p.number}: выберите задание, соответствующее плану и дереву` });
    } else tasks.push(task);
  });
  if (errors.length) throw invalid(errors, 'IMPORT_INVALID', 422);
  const images = new Map<string, Buffer>();
  for (const t of tasks) {
    const path = t.content.image;
    if (path) {
      const bytes = bank.media.get(path);
      if (!bytes) throw new Error(`В банке отсутствует ${path}`);
      images.set(path, bytes);
    }
  }
  const references = bank.references.flatMap(ref => {
    const taskIds = tasks.filter(t => t.reference_ids?.includes(ref.id)).map(t => t.id);
    return taskIds.length ? [{ ...ref, task_ids: taskIds }] : [];
  });
  const variant: RawVariant = {
    variant: selection.number,
    examCode: bank.info.examCode,
    title: `${bank.info.subject}. Вариант № ${selection.number}`,
    tasks,
  };
  return {
    preview: { title: variant.title, tasks: tasks.map(t => toTaskView(t, images)), references: references.map(toReference), instruction: bank.instruction },
    archive: () => makeKimArchive(variant, bank.plan, bank.tree, references, bank.instruction, images, selection.version),
  };
}
