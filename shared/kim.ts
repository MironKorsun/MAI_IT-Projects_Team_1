import type { ReferenceMaterial, TaskView } from './types';

export type KimDifficulty = 'basic' | 'advanced';
export interface KimPosition {
  number: number;
  part: 1;
  type: 'short';
  difficulty: KimDifficulty;
  max_score: number;
  recommended_min: number;
  topic_options: { topic_code: string }[];
}

export interface KimEditorInfo {
  examCode: string;
  subject: string;
  duration: number;
  variants: number;
  taskCount: number;
  topics: string[];
  positions: KimPosition[];
  demo: KimSelection;
}

export interface KimSelection {
  number: number;
  version?: string;
  taskIds: string[];
}
export interface KimCandidate {
  id: string;
  topic: string;
  label: string;
}
export interface KimPreview {
  title: string;
  tasks: TaskView[];
  references: ReferenceMaterial[];
  instruction: string;
}
