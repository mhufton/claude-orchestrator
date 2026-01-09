/**
 * Respawn Coordinator
 *
 * Prevents race conditions between pr-watcher, stale-detector, and spawner
 * when trying to respawn agents for the same ticket.
 *
 * Uses an in-memory map to track recent respawn actions per ticket.
 */

// Map of ticketId -> timestamp of last respawn action
const recentRespawns = new Map<number, number>();

// How long to consider a respawn "recent" (prevents duplicate actions)
const RESPAWN_COOLDOWN_MS = 60000; // 60 seconds

/**
 * Check if a respawn action was recently triggered for this ticket.
 * If not, marks it as respawning and returns true (OK to proceed).
 * If yes, returns false (skip, another component is handling it).
 */
export function tryAcquireRespawnLock(ticketId: number, source: string): boolean {
  const now = Date.now();
  const lastRespawn = recentRespawns.get(ticketId);

  if (lastRespawn && (now - lastRespawn) < RESPAWN_COOLDOWN_MS) {
    const secondsAgo = Math.round((now - lastRespawn) / 1000);
    console.log(`[respawn-coordinator] Skipping respawn for ticket ${ticketId} from ${source} - respawn triggered ${secondsAgo}s ago`);
    return false;
  }

  // Acquire the lock
  recentRespawns.set(ticketId, now);
  console.log(`[respawn-coordinator] Respawn lock acquired for ticket ${ticketId} by ${source}`);
  return true;
}

/**
 * Release the respawn lock for a ticket (e.g., if respawn failed or completed).
 * Note: Lock auto-expires after RESPAWN_COOLDOWN_MS, so this is optional.
 */
export function releaseRespawnLock(ticketId: number): void {
  recentRespawns.delete(ticketId);
}

/**
 * Check if a ticket has a recent respawn pending (without acquiring lock).
 */
export function hasRecentRespawn(ticketId: number): boolean {
  const lastRespawn = recentRespawns.get(ticketId);
  if (!lastRespawn) return false;
  return (Date.now() - lastRespawn) < RESPAWN_COOLDOWN_MS;
}

/**
 * Clean up expired entries (optional, for memory management in long-running processes)
 */
export function cleanupExpiredLocks(): void {
  const now = Date.now();
  for (const [ticketId, timestamp] of recentRespawns.entries()) {
    if (now - timestamp > RESPAWN_COOLDOWN_MS * 2) {
      recentRespawns.delete(ticketId);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredLocks, 5 * 60 * 1000);
