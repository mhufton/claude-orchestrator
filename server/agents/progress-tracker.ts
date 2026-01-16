/**
 * Progress tracking for agent execution
 *
 * Monitors agent output to detect phase transitions and track progress.
 * Provides structured progress updates for better UI feedback.
 */

export interface ProgressMilestone {
  phase: 'analyzing' | 'planning' | 'coding' | 'testing' | 'pr_creation' | 'complete';
  progress: number; // 0-100
  message: string;
}

export class ProgressTracker {
  private currentPhase: ProgressMilestone['phase'] = 'analyzing';
  private currentProgress: number = 0;

  /**
   * Analyze agent output line to detect phase transitions.
   * Returns a milestone if a phase transition is detected, null otherwise.
   */
  detectPhase(line: string): ProgressMilestone | null {
    // Parse the line to look for tool usage patterns
    // The line is typically JSON from Claude CLI stream-json output

    // Tool usage patterns - check for specific tool names in the JSON
    // Reading files and analyzing codebase
    if (this.currentProgress < 20 && (
      line.includes('"name":"Read"') ||
      line.includes('"name": "Read"') ||
      line.includes('"name":"Grep"') ||
      line.includes('"name": "Grep"') ||
      line.includes('"name":"Glob"') ||
      line.includes('"name": "Glob"')
    )) {
      this.currentPhase = 'analyzing';
      this.currentProgress = 10;
      return {
        phase: 'analyzing',
        progress: 10,
        message: 'Reading issue and analyzing codebase'
      };
    }

    // Planning phase - TodoWrite indicates agent is planning implementation
    if (this.currentProgress < 30 && (
      line.includes('"name":"TodoWrite"') ||
      line.includes('"name": "TodoWrite"')
    )) {
      this.currentPhase = 'planning';
      this.currentProgress = 25;
      return {
        phase: 'planning',
        progress: 25,
        message: 'Planning implementation'
      };
    }

    // Coding phase - Edit/Write indicates code modifications
    if (this.currentProgress < 60 && (
      line.includes('"name":"Edit"') ||
      line.includes('"name": "Edit"') ||
      line.includes('"name":"Write"') ||
      line.includes('"name": "Write"')
    )) {
      this.currentPhase = 'coding';
      this.currentProgress = 50;
      return {
        phase: 'coding',
        progress: 50,
        message: 'Writing code'
      };
    }

    // Testing phase - queue-run test or npm test commands
    if (this.currentProgress < 80 && (
      line.includes('queue-run test') ||
      line.includes('npm test') ||
      line.includes('npm run test') ||
      line.includes('bun test')
    )) {
      this.currentPhase = 'testing';
      this.currentProgress = 70;
      return {
        phase: 'testing',
        progress: 70,
        message: 'Running tests'
      };
    }

    // PR creation phase - git commands for PR
    if (this.currentProgress < 95 && (
      line.includes('gh pr create') ||
      line.includes('git push')
    )) {
      this.currentPhase = 'pr_creation';
      this.currentProgress = 90;
      return {
        phase: 'pr_creation',
        progress: 90,
        message: 'Creating pull request'
      };
    }

    return null;
  }

  /**
   * Mark the agent as complete (called when agent exits successfully)
   */
  markComplete(): ProgressMilestone {
    this.currentPhase = 'complete';
    this.currentProgress = 100;
    return {
      phase: 'complete',
      progress: 100,
      message: 'Complete'
    };
  }

  /**
   * Get current progress for UI display
   */
  getCurrentProgress(): ProgressMilestone {
    return {
      phase: this.currentPhase,
      progress: this.currentProgress,
      message: this.getPhaseMessage(this.currentPhase)
    };
  }

  /**
   * Reset the tracker for a new agent run
   */
  reset(): void {
    this.currentPhase = 'analyzing';
    this.currentProgress = 0;
  }

  private getPhaseMessage(phase: ProgressMilestone['phase']): string {
    switch (phase) {
      case 'analyzing':
        return 'Reading issue and analyzing codebase';
      case 'planning':
        return 'Planning implementation';
      case 'coding':
        return 'Writing code';
      case 'testing':
        return 'Running tests';
      case 'pr_creation':
        return 'Creating pull request';
      case 'complete':
        return 'Complete';
      default:
        return 'Working...';
    }
  }
}
