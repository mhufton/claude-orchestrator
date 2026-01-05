import type { ReactNode } from 'react';
import type { TicketState } from '../lib/types';

interface ColumnProps {
  title: string;
  state: TicketState;
  count: number;
  children: ReactNode;
  color: string;
}

export function Column({ title, count, children, color }: ColumnProps) {
  return (
    <div className="flex flex-col flex-1 min-w-0">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 px-1 min-w-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
        <h2 className="font-semibold text-gray-200 truncate">{title}</h2>
        <span className="ml-auto text-sm text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full shrink-0">
          {count}
        </span>
      </div>

      {/* Cards container */}
      <div className="flex-1 space-y-2 overflow-y-auto pr-1">
        {children}
      </div>
    </div>
  );
}
