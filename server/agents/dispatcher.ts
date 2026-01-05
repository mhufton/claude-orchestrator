import { spawn } from 'bun';
import { loadConfig } from '../config';

const DISPATCHER_TIMEOUT_MS = 600000; // 10 minute timeout (user can stop manually if needed)

// Track which sessions have been initialized with the system prompt
const initializedSessions = new Set<string>();

// Track the currently running dispatcher process so it can be stopped
let currentDispatcherProcess: ReturnType<typeof spawn> | null = null;

/**
 * Stop the currently running dispatcher process
 */
export function stopDispatcher(): boolean {
  if (currentDispatcherProcess) {
    console.log('[Dispatcher] Stopping current process');
    try {
      currentDispatcherProcess.kill();
      currentDispatcherProcess = null;
      return true;
    } catch (err) {
      console.error('[Dispatcher] Error stopping process:', err);
      return false;
    }
  }
  return false;
}

/**
 * Chat with the dispatcher using Claude CLI (uses Max plan)
 * @param userMessage - The user's message
 * @param sessionId - Optional session ID for conversation continuity
 */
export async function chat(userMessage: string, sessionId?: string): Promise<string> {
  console.log('[Dispatcher] chat() called with message:', userMessage.slice(0, 100));
  console.log('[Dispatcher] Session ID:', sessionId || 'none (new session)');

  const config = loadConfig();
  console.log('[Dispatcher] Config loaded, repo:', config.github.owner + '/' + config.github.repo);

  const systemPrompt = `You are the Dispatcher, a helpful assistant for managing the Claude Orchestrator system.

The Orchestrator manages autonomous Claude agents working on GitHub issues. You're chatting with the user to help them:
- Check status of GitHub issues and PRs
- Answer questions about the repository
- Create issues and manage labels
- Look up information using the gh CLI

Current repository: ${config.github.owner}/${config.github.repo}

You have access to the gh CLI tool. Use it to answer questions about issues, PRs, labels, etc.

IMPORTANT: When creating any new issue, ALWAYS add the "claude-review" label so it appears in the review queue.
Use: gh issue create --title "..." --body "..." --label "claude-review"

Examples of useful commands:
- gh issue list --label "claude-review" --json number,title,state
- gh issue list --state open --json number,title,labels
- gh pr list --json number,title,state,headRefName
- gh issue view 123 --json title,body,labels,state
- gh issue create --title "Title" --body "Description" --label "claude-review"

Be concise and helpful. When asked about issues or PRs, use the gh CLI to get current information.`;

  // Build the CLI arguments - use Sonnet for dispatcher (conversational, lighter task)
  const args = ['claude', '--print', '--model', 'sonnet', '--dangerously-skip-permissions'];

  // If we have a session ID and it's been initialized, use --resume
  // Otherwise, start fresh with the system prompt
  const isResuming = sessionId && initializedSessions.has(sessionId);

  if (isResuming) {
    // Resume existing session - just send the user message
    args.push('--resume', sessionId, '-p', userMessage);
    console.log('[Dispatcher] Resuming session:', sessionId);
  } else {
    // New session - include system prompt
    const fullPrompt = `${systemPrompt}\n\nUser message: ${userMessage}`;
    args.push('-p', fullPrompt);

    // If we have a session ID, use it for the new conversation
    if (sessionId) {
      args.push('--session-id', sessionId);
      console.log('[Dispatcher] Starting new session with ID:', sessionId);
    } else {
      console.log('[Dispatcher] Starting ephemeral session (no ID)');
    }
  }

  console.log('[Dispatcher] Spawning claude CLI...');
  console.log('[Dispatcher] CWD:', process.cwd());
  console.log('[Dispatcher] Args:', args.slice(0, 4).join(' '), '...');

  const proc = spawn(args, {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env
    }
  });

  // Track the process so it can be stopped
  currentDispatcherProcess = proc;

  console.log('[Dispatcher] Process spawned, PID:', proc.pid);

  // Collect output
  let output = '';
  let errorOutput = '';

  const stdoutReader = proc.stdout.getReader();
  const stderrReader = proc.stderr.getReader();
  const decoder = new TextDecoder();

  // Read stdout
  const readStdout = async () => {
    console.log('[Dispatcher] Starting stdout reader...');
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) {
          console.log('[Dispatcher] Stdout done, total length:', output.length);
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        output += chunk;
        console.log('[Dispatcher] Stdout chunk received, length:', chunk.length);
      }
    } catch (err) {
      console.error('[Dispatcher] Error reading stdout:', err);
    }
  };

  // Read stderr
  const readStderr = async () => {
    console.log('[Dispatcher] Starting stderr reader...');
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) {
          console.log('[Dispatcher] Stderr done, total length:', errorOutput.length);
          break;
        }
        const chunk = decoder.decode(value, { stream: true });
        errorOutput += chunk;
        console.log('[Dispatcher] Stderr chunk:', chunk.slice(0, 200));
      }
    } catch (err) {
      console.error('[Dispatcher] Error reading stderr:', err);
    }
  };

  // Create timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      proc.kill();
      reject(new Error('Dispatcher timed out after 10 minutes'));
    }, DISPATCHER_TIMEOUT_MS);
  });

  try {
    console.log('[Dispatcher] Waiting for process to complete...');

    // Wait for process to complete or timeout
    await Promise.race([
      Promise.all([readStdout(), readStderr(), proc.exited]),
      timeoutPromise
    ]);

    const exitCode = proc.exitCode;
    console.log('[Dispatcher] Process completed, exitCode:', exitCode);

    // Exit code 143 = SIGTERM (killed), 137 = SIGKILL - these are expected when stopped
    if (exitCode === 143 || exitCode === 137) {
      console.log('[Dispatcher] Process was stopped by user');
      currentDispatcherProcess = null;
      return '(Request cancelled)';
    }

    if (exitCode !== 0) {
      console.error(`[Dispatcher] Exited with code ${exitCode}`);
      console.error('[Dispatcher] Stderr:', errorOutput);

      // If session is "already in use", mark it as initialized so next call uses --resume
      if (errorOutput.includes('already in use') && sessionId) {
        console.log('[Dispatcher] Session already exists in Claude, marking as initialized for --resume');
        initializedSessions.add(sessionId);
        currentDispatcherProcess = null;
        // Return a helpful message instead of throwing
        return 'Session conflict detected. Please try your request again.';
      }

      throw new Error(`Dispatcher failed: ${errorOutput || 'Unknown error'}`);
    }

    const result = output.trim() || 'I processed your request but have no response to show.';
    console.log('[Dispatcher] Returning response, length:', result.length);
    console.log('[Dispatcher] Response preview:', result.slice(0, 200));

    // Mark session as initialized for future --resume calls
    if (sessionId) {
      initializedSessions.add(sessionId);
      console.log('[Dispatcher] Session marked as initialized:', sessionId);
    }

    // Clear the process tracker
    currentDispatcherProcess = null;

    return result;
  } catch (error) {
    // Clear the process tracker
    currentDispatcherProcess = null;
    console.error('[Dispatcher] Error:', error);
    throw error;
  }
}
