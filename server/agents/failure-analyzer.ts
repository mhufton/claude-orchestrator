import * as db from '../db';
import type { Ticket } from '../state/types';

/**
 * Categories of failure causes
 */
export type FailureCategory =
  | 'merge_conflict'
  | 'ci_failure'
  | 'low_score'
  | 'syntax_error'
  | 'runtime_error'
  | 'permission_error'
  | 'dependency_error'
  | 'test_failure'
  | 'build_failure'
  | 'timeout'
  | 'tool_usage_error'
  | 'git_error'
  | 'environment_error'
  | 'unknown';

/**
 * Error patterns to detect specific failure types
 */
interface ErrorPattern {
  category: FailureCategory;
  patterns: RegExp[];
  description: string;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    category: 'syntax_error',
    patterns: [
      /SyntaxError/i,
      /Unexpected token/i,
      /Parse error/i,
      /Invalid syntax/i,
      /Unexpected identifier/i
    ],
    description: 'Code has syntax errors that prevent execution'
  },
  {
    category: 'runtime_error',
    patterns: [
      /TypeError/i,
      /ReferenceError/i,
      /Cannot read propert(y|ies) of (null|undefined)/i,
      /is not a function/i,
      /is not defined/i
    ],
    description: 'Runtime errors occurred during execution'
  },
  {
    category: 'test_failure',
    patterns: [
      /test.*failed/i,
      /FAIL\s+/,
      /\d+\s+failing/i,
      /Expected.*but (got|received)/i,
      /Assertion.*failed/i,
      /Test suite failed/i
    ],
    description: 'Tests are failing'
  },
  {
    category: 'build_failure',
    patterns: [
      /Build failed/i,
      /Compilation error/i,
      /Cannot find module/i,
      /Module not found/i,
      /Failed to compile/i
    ],
    description: 'Build or compilation failed'
  },
  {
    category: 'permission_error',
    patterns: [
      /EACCES/i,
      /Permission denied/i,
      /EPERM/i,
      /Access denied/i
    ],
    description: 'Permission/access errors'
  },
  {
    category: 'dependency_error',
    patterns: [
      /Cannot find module ['"].*['"]/i,
      /Module ['"].*['"] not found/i,
      /ENOENT.*node_modules/i,
      /npm ERR!/,
      /yarn error/i,
      /pnpm ERR!/
    ],
    description: 'Missing or broken dependencies'
  },
  {
    category: 'git_error',
    patterns: [
      /git.*fatal/i,
      /merge conflict/i,
      /CONFLICT/,
      /failed to push/i,
      /rejected.*non-fast-forward/i,
      /Your branch is behind/i,
      /cannot rebase/i
    ],
    description: 'Git operation errors'
  },
  {
    category: 'tool_usage_error',
    patterns: [
      /Tool.*not found/i,
      /Invalid tool parameters/i,
      /Required parameter.*missing/i,
      /Edit tool.*failed/i,
      /old_string.*not found/i,
      /could not find.*in file/i
    ],
    description: 'Agent used tools incorrectly'
  },
  {
    category: 'timeout',
    patterns: [
      /timeout/i,
      /timed out/i,
      /ETIMEDOUT/i,
      /operation exceeded time limit/i
    ],
    description: 'Operations timed out'
  },
  {
    category: 'environment_error',
    patterns: [
      /ENOENT/i,
      /No such file or directory/i,
      /command not found/i,
      /not found in PATH/i
    ],
    description: 'Environment setup or missing executables'
  }
];

/**
 * Analyzed failure information
 */
export interface FailureAnalysis {
  category: FailureCategory;
  description: string;
  errorMessages: string[];
  failedTools: string[];
  failedCommands: string[];
  repeatedPatterns: string[];
  suggestions: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Analyze agent logs to determine failure cause and generate actionable feedback
 */
export function analyzeAgentFailure(ticket: Ticket): FailureAnalysis {
  // Get recent logs for this ticket (last 50 entries)
  const logs = db.getLogsForTicket(ticket.id, 50);

  const errorMessages: string[] = [];
  const failedTools: string[] = [];
  const failedCommands: string[] = [];
  const toolErrors = new Map<string, number>(); // Track repeated tool failures
  const errorTypes = new Map<FailureCategory, number>(); // Track error categories

  // Parse logs to extract errors, failed tools, and patterns
  for (const log of logs) {
    try {
      const parsed = JSON.parse(log.content);

      // Extract errors from tool results
      if (parsed.type === 'user' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'tool_result' && block.content) {
            const content = String(block.content);

            // Check if this is an error result
            const isError =
              block.is_error ||
              content.includes('Error:') ||
              content.includes('error:') ||
              content.includes('FAILED') ||
              content.includes('Exit code') && !content.includes('Exit code 0');

            if (isError) {
              // Extract tool name from tool_use_id or context
              const toolName = block.tool_use_id?.split('-')[0] || 'unknown';
              failedTools.push(toolName);

              // Count repeated failures
              toolErrors.set(toolName, (toolErrors.get(toolName) || 0) + 1);

              // Extract error message (first few lines)
              const errorLines = content.split('\n')
                .filter(line =>
                  line.includes('Error') ||
                  line.includes('error') ||
                  line.includes('FAILED') ||
                  line.includes('Cannot') ||
                  line.includes('not found') ||
                  line.includes('Exit code'))
                .slice(0, 3)
                .join('\n');

              if (errorLines) {
                errorMessages.push(errorLines.slice(0, 300));
              }

              // Categorize the error
              for (const pattern of ERROR_PATTERNS) {
                if (pattern.patterns.some(p => p.test(content))) {
                  errorTypes.set(pattern.category, (errorTypes.get(pattern.category) || 0) + 1);
                }
              }
            }
          }
        }
      }

      // Extract failed bash commands
      if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'tool_use' && block.name === 'Bash' && block.input?.command) {
            // Check next log entry to see if this command failed
            const command = String(block.input.command);
            failedCommands.push(command.slice(0, 100));
          }
        }
      }
    } catch {
      // Skip unparseable logs
    }
  }

  // Determine primary failure category
  let primaryCategory: FailureCategory = 'unknown';
  let maxCount = 0;

  for (const [category, count] of Array.from(errorTypes.entries())) {
    if (count > maxCount) {
      maxCount = count;
      primaryCategory = category;
    }
  }

  // Get description for primary category
  const patternInfo = ERROR_PATTERNS.find(p => p.category === primaryCategory);
  const description = patternInfo?.description || 'Unknown failure cause';

  // Identify repeated patterns (tools or errors that failed multiple times)
  const repeatedPatterns: string[] = [];
  for (const [tool, count] of Array.from(toolErrors.entries())) {
    if (count >= 2) {
      repeatedPatterns.push(`${tool} failed ${count} times`);
    }
  }

  // Generate actionable suggestions based on failure category
  const suggestions = generateSuggestions(
    primaryCategory,
    errorMessages,
    failedTools,
    repeatedPatterns,
    ticket
  );

  // Determine severity
  const severity = determineSeverity(primaryCategory, errorTypes, repeatedPatterns.length);

  return {
    category: primaryCategory,
    description,
    errorMessages: errorMessages.slice(0, 5), // Limit to top 5
    failedTools: [...new Set(failedTools)].slice(0, 5),
    failedCommands: failedCommands.slice(0, 3),
    repeatedPatterns,
    suggestions,
    severity
  };
}

/**
 * Generate actionable suggestions based on failure analysis
 */
function generateSuggestions(
  category: FailureCategory,
  errorMessages: string[],
  failedTools: string[],
  repeatedPatterns: string[],
  ticket: Ticket
): string[] {
  const suggestions: string[] = [];

  switch (category) {
    case 'syntax_error':
      suggestions.push('Review the syntax errors carefully - they must be fixed before tests can run');
      suggestions.push('Check for missing brackets, quotes, or semicolons');
      suggestions.push('Use Read tool to verify file syntax before pushing');
      break;

    case 'runtime_error':
      suggestions.push('Add null/undefined checks before accessing properties');
      suggestions.push('Verify variable names and function calls are correct');
      suggestions.push('Check if imports and dependencies are properly loaded');
      break;

    case 'test_failure':
      suggestions.push('Read the failing test files to understand what behavior is expected');
      suggestions.push('Run tests locally with queue-run to see detailed output');
      suggestions.push('Fix the actual behavior to match test expectations, not the tests themselves');
      break;

    case 'build_failure':
      suggestions.push('Check for TypeScript type errors or missing dependencies');
      suggestions.push('Run queue-run build locally to see detailed error messages');
      suggestions.push('Verify all imports are correct and modules exist');
      break;

    case 'git_error':
      suggestions.push('Use git status to understand current state');
      suggestions.push('For merge conflicts: git fetch origin dev && git rebase origin/dev');
      suggestions.push('Read conflict markers carefully and resolve both sides');
      break;

    case 'tool_usage_error':
      suggestions.push('Review tool parameters - make sure old_string matches exactly');
      suggestions.push('Use Read tool first to see current file contents');
      suggestions.push('For Edit tool, ensure old_string appears exactly once in the file');
      break;

    case 'dependency_error':
      suggestions.push('Check if package.json has the required dependencies');
      suggestions.push('Run npm install or verify node_modules exists');
      suggestions.push('Check import paths are correct');
      break;

    default:
      suggestions.push('Review recent error messages carefully');
      suggestions.push('Try a different approach if previous attempts failed the same way');
      suggestions.push('Break down the problem into smaller steps');
  }

  // Add suggestions for repeated patterns
  if (repeatedPatterns.length > 0) {
    suggestions.push(`⚠️ Avoid repeating: ${repeatedPatterns.join(', ')}`);
    suggestions.push('This approach is not working - try a fundamentally different strategy');
  }

  // Add suggestion based on attempt count
  if (ticket.attempt_count >= 2) {
    suggestions.push('Previous attempts failed - review handoff notes to avoid repeating mistakes');
  }

  return suggestions;
}

/**
 * Determine severity of the failure
 */
function determineSeverity(
  category: FailureCategory,
  errorTypes: Map<FailureCategory, number>,
  repeatedCount: number
): 'low' | 'medium' | 'high' | 'critical' {
  // Critical: repeated patterns (agent is stuck in a loop)
  if (repeatedCount >= 3) {
    return 'critical';
  }

  // High: multiple error types or specific severe categories
  const errorTypeCount = Array.from(errorTypes.keys()).length;

  if (errorTypeCount >= 3) {
    return 'high';
  }

  const severeCategories: FailureCategory[] = [
    'merge_conflict',
    'build_failure',
    'dependency_error'
  ];

  if (severeCategories.includes(category)) {
    return 'high';
  }

  // Medium: single error type, some complexity
  if (errorTypeCount >= 2) {
    return 'medium';
  }

  // Low: simple, single error
  return 'low';
}

/**
 * Format failure analysis for display or logging
 */
export function formatFailureAnalysis(analysis: FailureAnalysis): string {
  const lines: string[] = [];

  lines.push(`Failure Category: ${analysis.category}`);
  lines.push(`Severity: ${analysis.severity}`);
  lines.push(`Description: ${analysis.description}`);

  if (analysis.errorMessages.length > 0) {
    lines.push('\nRecent Errors:');
    analysis.errorMessages.forEach((err, i) => {
      lines.push(`  ${i + 1}. ${err.split('\n')[0]}`);
    });
  }

  if (analysis.repeatedPatterns.length > 0) {
    lines.push('\n⚠️ Repeated Patterns (agent may be stuck):');
    analysis.repeatedPatterns.forEach(pattern => {
      lines.push(`  - ${pattern}`);
    });
  }

  if (analysis.suggestions.length > 0) {
    lines.push('\nSuggestions:');
    analysis.suggestions.forEach(suggestion => {
      lines.push(`  • ${suggestion}`);
    });
  }

  return lines.join('\n');
}
