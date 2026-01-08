import * as db from '../db';
import { createWorktree, removeWorktree, getWorktreePath } from './manager';
import { broadcastSlotStatus } from '../ws/handler';

export interface SlotAllocation {
  slot: number;
  worktreePath: string;
}

export async function acquireSlot(ticketId: number, branchName: string): Promise<SlotAllocation | null> {
  const availableSlot = db.getAvailableSlot();

  if (!availableSlot) {
    console.log('No available slots');
    return null;
  }

  try {
    // Create the worktree
    await createWorktree(availableSlot, branchName);

    // Update ticket with slot assignment
    db.updateTicket(ticketId, {
      worktree_slot: availableSlot,
      branch_name: branchName
    });

    broadcastSlotStatus();

    return {
      slot: availableSlot,
      worktreePath: getWorktreePath(availableSlot)
    };
  } catch (error) {
    console.error(`Failed to acquire slot ${availableSlot}:`, error);
    return null;
  }
}

export async function releaseSlot(slot: number): Promise<void> {
  const maxSlots = db.getSettings().maxAgentSlots;
  if (slot < 1 || slot > maxSlots) {
    console.warn(`Invalid slot number: ${slot}`);
    return;
  }

  try {
    await removeWorktree(slot);
  } catch (error) {
    console.warn(`Failed to cleanup worktree for slot ${slot}:`, error);
  }

  // Find and update the ticket that was using this slot
  const ticket = db.getTicketBySlot(slot);
  if (ticket) {
    db.updateTicket(ticket.id, { worktree_slot: null });
  }

  broadcastSlotStatus();
}

export function getSlotStatus(): Array<{ slot: number; available: boolean; ticketId: number | null }> {
  return db.getSlotStatus();
}

export function getAvailableSlotCount(): number {
  const status = db.getSlotStatus();
  return status.filter(s => s.available).length;
}
