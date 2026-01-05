import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { TicketCard } from './TicketCard';
import type { Ticket } from '../lib/types';

interface SortableTicketCardProps {
  ticket: Ticket;
  isSelected?: boolean;
  slotsAvailable?: boolean;
  onSelect?: () => void;
  onStart?: (force?: boolean) => void;
  onRetry?: () => void;
  showReviewCheckbox?: boolean;
  isInReviewQueue?: boolean;
  onToggleReviewQueue?: () => void;
  isPipelinePaused?: boolean;
  isBeingReviewed?: boolean;
  reviewResult?: { verdict: string; error?: string };
}

export function SortableTicketCard({
  ticket,
  ...props
}: SortableTicketCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: ticket.id,
    data: {
      type: 'ticket',
      ticket,
      state: ticket.state,
    },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    cursor: 'grab',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
    >
      <TicketCard
        ticket={ticket}
        {...props}
      />
    </div>
  );
}
