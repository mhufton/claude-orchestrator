import * as github from './client';

export interface ReviewScore {
  total: number;
  breakdown?: {
    codeQuality?: number;
    testCoverage?: number;
    security?: number;
  };
  feedback?: string;
}

/**
 * Parse review score from PR comments
 * Looks for patterns like "Score: 85/100" or "Total Score: 85"
 */
export async function parseReviewScore(prNumber: number): Promise<ReviewScore | null> {
  const comments = await github.getPRComments(prNumber);

  // Find the most recent score comment from github-actions bot
  const scoreComments = comments
    .filter(c =>
      c.user.login === 'github-actions[bot]' &&
      (c.body.includes('Score:') || c.body.includes('score:') || c.body.includes('QUALITY_SCORE'))
    )
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (scoreComments.length === 0) {
    return null;
  }

  const comment = scoreComments[0];
  const body = comment.body;

  // Try to extract total score - multiple formats supported
  // Format 1: "QUALITY_SCORE: 85" (from Claude code review)
  // Format 2: "Score: 85/100" or "Total Score: 85"
  const qualityScoreMatch = body.match(/QUALITY_SCORE:\s*(\d+)/i);
  const totalMatch = body.match(/(?:Total\s+)?Score:\s*(\d+)(?:\/100)?/i);

  const scoreMatch = qualityScoreMatch || totalMatch;
  if (!scoreMatch) {
    return null;
  }

  const total = parseInt(scoreMatch[1], 10);

  // Try to extract breakdown scores
  const codeQualityMatch = body.match(/Code\s+Quality[:\s]+(\d+)/i);
  const testCoverageMatch = body.match(/Test\s+Coverage[:\s]+(\d+)/i);
  const securityMatch = body.match(/Security[:\s]+(\d+)/i);

  const breakdown: ReviewScore['breakdown'] = {};
  if (codeQualityMatch) breakdown.codeQuality = parseInt(codeQualityMatch[1], 10);
  if (testCoverageMatch) breakdown.testCoverage = parseInt(testCoverageMatch[1], 10);
  if (securityMatch) breakdown.security = parseInt(securityMatch[1], 10);

  // Extract feedback if present (usually in a section after score)
  let feedback: string | undefined;

  // Try to extract deductions (from Claude code review format)
  // Handle both orders: Deductions before/after QUALITY_SCORE
  const deductionsMatch = body.match(/Deductions:([\s\S]*?)(?=\n\n|\n##|$)/i);
  if (deductionsMatch) {
    // Clean up the deductions - remove any trailing QUALITY_SCORE line
    let deductions = deductionsMatch[1].trim();
    deductions = deductions.replace(/\*?\*?QUALITY_SCORE.*$/im, '').trim();
    if (deductions) {
      feedback = deductions;
    }
  }

  // Fall back to Issues format
  if (!feedback) {
    const issuesMatch = body.match(/Issues?(?:\s+to\s+fix)?:([\s\S]*?)(?=\n\n|\n##|$)/i);
    if (issuesMatch) {
      feedback = issuesMatch[1].trim();
    }
  }

  // Also try "Starting score" format with deductions listed after
  if (!feedback) {
    const startingScoreMatch = body.match(/Starting score:\s*\d+[\s\S]*?Deductions?:([\s\S]*?)(?=\n\n\*?\*?QUALITY|$)/i);
    if (startingScoreMatch) {
      feedback = startingScoreMatch[1].trim();
    }
  }

  return {
    total,
    breakdown: Object.keys(breakdown).length > 0 ? breakdown : undefined,
    feedback
  };
}

/**
 * Get detailed feedback for a failed review
 */
export async function getReviewFeedback(prNumber: number): Promise<string> {
  const score = await parseReviewScore(prNumber);

  if (!score) {
    return 'No review feedback available.';
  }

  const parts: string[] = [];

  parts.push(`Previous Score: ${score.total}/100`);

  if (score.breakdown) {
    parts.push('\nBreakdown:');
    if (score.breakdown.codeQuality !== undefined) {
      parts.push(`- Code Quality: ${score.breakdown.codeQuality}/40`);
    }
    if (score.breakdown.testCoverage !== undefined) {
      parts.push(`- Test Coverage: ${score.breakdown.testCoverage}/30`);
    }
    if (score.breakdown.security !== undefined) {
      parts.push(`- Security: ${score.breakdown.security}/30`);
    }
  }

  if (score.feedback) {
    parts.push('\nIssues to address:');
    parts.push(score.feedback);
  }

  return parts.join('\n');
}
