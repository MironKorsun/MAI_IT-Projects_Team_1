import type { TaskView } from '../../../../shared/types';
import { SafeHtml } from '../../lib/richtext';

export function TaskContent({ task }: { task: TaskView }) {
  return (
    <div className="stack">
      <SafeHtml html={task.condition} />
      {task.imageData && (
        <img
          src={`data:image/svg+xml;base64,${task.imageData}`}
          alt={`Чертёж к заданию № ${task.number}`}
          style={{ maxWidth: '100%', height: 'auto', justifySelf: 'start', alignSelf: 'start', background: 'white' }}
        />
      )}
      {task.question && <SafeHtml html={task.question} />}
    </div>
  );
}
