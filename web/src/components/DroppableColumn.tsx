import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { TicketState } from '../lib/types';
import type { ReactNode } from 'react';

interface DroppableColumnProps {
  state: TicketState;
  title: string;
  count: number;
  color: string;
  ticketIds: number[];
  children: ReactNode;
  headerContent?: ReactNode;
}

export function DroppableColumn({
  state,
  title,
  count,
  color,
  ticketIds,
  children,
  headerContent,
}: DroppableColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column-${state}`,
    data: {
      type: 'column',
      state,
    },
  });

  return (
    <div
      ref={setNodeRef}
      className={`
        flex flex-col flex-1 min-w-0 h-full rounded-lg transition-all duration-150
        ${isOver
          ? 'ring-2 ring-purple-400 bg-purple-900/20'
          : 'bg-transparent'}
      `}
    >
      {/* Header */}
      <div className="flex items-center gap-2 mb-3 px-1 min-w-0">
        <div className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
        <h2 className="font-semibold text-gray-200 truncate">{title}</h2>
        <span className="ml-auto text-sm text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full shrink-0">
          {count}
        </span>
      </div>

      {/* Header content (e.g., batch review UI) */}
      {headerContent}

      {/* Cards container - this is the droppable area */}
      <div className="flex-1 space-y-2 overflow-y-auto pr-1 min-h-[100px]">
        <SortableContext items={ticketIds} strategy={verticalListSortingStrategy}>
          {children}
        </SortableContext>
      </div>
    </div>
  );
}
