import { CheckCircle2, Circle, Loader2 } from 'lucide-react';
import type { AgentTodo } from '../lib/types';

interface TodosViewProps {
  todos: AgentTodo[];
  compact?: boolean;
}

export function TodosView({ todos, compact = false }: TodosViewProps) {
  if (todos.length === 0) {
    return (
      <div className="text-gray-500 text-sm italic">
        No tasks yet
      </div>
    );
  }

  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;
  const progress = Math.round((completed / total) * 100);

  // Find the current active task
  const activeTask = todos.find(t => t.status === 'in_progress');

  if (compact) {
    return (
      <div className="space-y-2">
        {/* Progress bar */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-gray-500">{completed}/{total}</span>
        </div>

        {/* Current task */}
        {activeTask && (
          <div className="flex items-center gap-2 text-sm">
            <Loader2 size={14} className="text-blue-400 animate-spin shrink-0" />
            <span className="text-blue-300 truncate">{activeTask.activeForm}</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header with progress */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-300">Agent Tasks</span>
        <span className="text-xs text-gray-500">{completed}/{total} complete</span>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-green-500 transition-all duration-300"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Task list */}
      <div className="space-y-1.5">
        {todos.map((todo, i) => {
          const isCompleted = todo.status === 'completed';
          const isInProgress = todo.status === 'in_progress';

          return (
            <div
              key={i}
              className={`flex items-start gap-2 py-1.5 px-2 rounded ${
                isInProgress ? 'bg-blue-900/30 border border-blue-800/50' : ''
              }`}
            >
              {/* Status icon */}
              {isCompleted ? (
                <CheckCircle2 size={16} className="text-green-500 shrink-0 mt-0.5" />
              ) : isInProgress ? (
                <Loader2 size={16} className="text-blue-400 animate-spin shrink-0 mt-0.5" />
              ) : (
                <Circle size={16} className="text-gray-600 shrink-0 mt-0.5" />
              )}

              {/* Task content */}
              <span className={`text-sm ${
                isCompleted ? 'text-gray-500 line-through' :
                isInProgress ? 'text-blue-300' :
                'text-gray-400'
              }`}>
                {isInProgress ? todo.activeForm : todo.content}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
