# Local CI/CD Pipeline - Design Document

> **Status:** Future Feature - Design Complete, Not Yet Implemented
>
> **Goal:** Replace GitHub Actions with local CI/CD running on orchestrator, featuring GitHub Actions-style UI

## Motivation

**Why build this:**
- ❌ **GitHub Actions costs** - No more paying for CI minutes
- ✅ **Full control** - Run CI on local network PC
- ✅ **Auto-healing** - CI fails → agent spawns → fixes → pushes → CI reruns
- ✅ **Unified dashboard** - See CI + agents + tickets in one place
- ✅ **Faster feedback** - Local execution, no GitHub queue
- ✅ **Reuse infrastructure** - Worktree pool, error categorization, retry logic

## Architecture Overview

```
GitHub PR Created/Updated
    ↓ (webhook)
Orchestrator receives event
    ↓
Spawn CI Job in worktree slot
    ↓
Run Pipeline: test → lint → build → deploy
    ↓
    ├─ PASS → Update GitHub status → Merge ✓
    │
    └─ FAIL → Analyze failure
              ↓
              Spawn Agent to fix
              ↓
              Agent pushes changes
              ↓
              CI reruns (loop until pass or max attempts)
```

## Core Components

### 1. CI Pipeline Engine

**File:** `server/ci/pipeline.ts`

```typescript
export interface CIPipeline {
  id: number;
  pr_number: number;
  commit_sha: string;
  commit_message: string;
  branch: string;
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled';
  stages: Stage[];
  started_at: string;
  completed_at: string | null;
  duration_ms: number;
  agent_id: number | null; // If auto-fix agent spawned
}

export interface Stage {
  name: 'test' | 'lint' | 'build' | 'deploy-dev' | 'deploy-prod';
  status: 'pending' | 'running' | 'success' | 'failure' | 'skipped';
  commands: string[];
  output: string; // Captured stdout/stderr
  duration_ms: number;
  error_count: number;
  annotations: ErrorAnnotation[]; // Parsed errors with file:line
}

export interface ErrorAnnotation {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning';
  suggestion?: string; // Auto-generated fix suggestion
}
```

**Key Functions:**

```typescript
// Spawn CI pipeline for PR
export async function runCIPipeline(prNumber: number): Promise<CIPipeline>

// Execute single stage
async function executeStage(slot: number, stage: Stage): Promise<StageResult>

// Parse errors from output (ESLint, TypeScript, Jest, etc.)
async function parseErrors(output: string, stageName: string): Promise<ErrorAnnotation[]>

// Auto-spawn agent when CI fails
async function spawnFixAgent(pipeline: CIPipeline, failedStage: Stage): Promise<void>
```

### 2. GitHub Webhook Handler

**File:** `server/github/webhooks.ts`

```typescript
// POST /github/webhook
export async function handlePRWebhook(payload: GitHubWebhookPayload) {
  const { action, pull_request } = payload;

  if (action === 'opened' || action === 'synchronize') {
    // Queue CI run
    await queueCIPipeline({
      pr_number: pull_request.number,
      commit_sha: pull_request.head.sha,
      commit_message: pull_request.head.commit.message,
      branch: pull_request.head.ref
    });
  }
}

// Setup: gh api repos/OWNER/REPO/hooks -f name=web \
//   -f config[url]=https://your-server.com/github/webhook \
//   -f config[secret]=$WEBHOOK_SECRET \
//   -F events[]=pull_request
```

### 3. CI Executor

**File:** `server/ci/executor.ts`

```typescript
export async function executeCIJob(pipeline: CIPipeline): Promise<void> {
  const slot = await acquireSlot();
  const worktreePath = getWorktreePath(slot);

  try {
    // Checkout PR
    await exec(`gh pr checkout ${pipeline.pr_number}`, { cwd: worktreePath });

    // Update status
    db.updatePipeline(pipeline.id, { status: 'running' });
    broadcastPipelineUpdate(pipeline.id, { status: 'running' });

    // Run each stage
    for (const stage of pipeline.stages) {
      const result = await executeStage(slot, stage);

      // Update stage status
      stage.status = result.success ? 'success' : 'failure';
      stage.output = result.output;
      stage.duration_ms = result.duration;

      // Parse errors
      if (!result.success) {
        stage.annotations = await parseErrors(result.output, stage.name);
        stage.error_count = stage.annotations.length;
      }

      // Broadcast real-time updates
      broadcastStageUpdate(pipeline.id, stage);

      // Post status to GitHub
      await updateGitHubStatus(pipeline.commit_sha, stage.name, stage.status);

      // Stop on failure
      if (!result.success) {
        await spawnFixAgent(pipeline, stage);
        break;
      }
    }

    // Mark pipeline complete
    db.updatePipeline(pipeline.id, {
      status: pipeline.stages.every(s => s.status === 'success') ? 'success' : 'failure',
      completed_at: new Date().toISOString()
    });

  } finally {
    releaseSlot(slot);
  }
}
```

### 4. Auto-Fix Agent Integration

```typescript
async function spawnFixAgent(pipeline: CIPipeline, failedStage: Stage): Promise<void> {
  console.log(`[ci] Stage '${failedStage.name}' failed, spawning fix agent...`);

  // Create ticket for agent
  const ticket = db.createTicket({
    github_issue_number: pipeline.pr_number,
    title: `CI Failure: ${failedStage.name} failed on PR #${pipeline.pr_number}`,
    body: generateFixPrompt(pipeline, failedStage),
    state: 'in_progress',
    pr_number: pipeline.pr_number
  });

  // Use failure analyzer (from iterative feedback feature)
  const analysis = await analyzeAgentFailure(ticket, [failedStage.output], {
    ciFailures: [failedStage.name],
    errorMessages: failedStage.annotations.map(a => `${a.file}:${a.line} - ${a.message}`)
  });

  // Spawn agent with rich context
  await spawnAgent(ticket, {
    context: {
      ciFailures: [failedStage.name],
      failureAnalysis: analysis,
      errorAnnotations: failedStage.annotations
    }
  });

  // Link agent to pipeline
  db.updatePipeline(pipeline.id, { agent_id: ticket.id });
}

function generateFixPrompt(pipeline: CIPipeline, stage: Stage): string {
  return `
CI pipeline failed on PR #${pipeline.pr_number}

**Failed Stage:** ${stage.name}
**Commit:** ${pipeline.commit_sha}
**Branch:** ${pipeline.branch}

**Commands that failed:**
${stage.commands.map(c => `- ${c}`).join('\n')}

**Errors found:**
${stage.annotations.map(a => `- ${a.file}:${a.line}:${a.column} - ${a.message}`).join('\n')}

**Full output:**
\`\`\`
${stage.output}
\`\`\`

Please fix these issues and push your changes. The CI will automatically re-run.
  `;
}
```

### 5. Database Schema

```sql
-- CI Pipelines table
CREATE TABLE ci_pipelines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  commit_message TEXT,
  branch TEXT NOT NULL,
  status TEXT NOT NULL, -- pending, running, success, failure, cancelled
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  agent_id INTEGER, -- Foreign key to tickets if auto-fix spawned
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CI Stages table
CREATE TABLE ci_stages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pipeline_id INTEGER NOT NULL,
  name TEXT NOT NULL, -- test, lint, build, deploy-dev, deploy-prod
  status TEXT NOT NULL,
  commands TEXT NOT NULL, -- JSON array
  output TEXT, -- Captured stdout/stderr
  duration_ms INTEGER,
  error_count INTEGER DEFAULT 0,
  annotations TEXT, -- JSON array of ErrorAnnotation
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES ci_pipelines(id)
);

-- Index for fast lookups
CREATE INDEX idx_ci_pipelines_pr ON ci_pipelines(pr_number);
CREATE INDEX idx_ci_pipelines_status ON ci_pipelines(status);
CREATE INDEX idx_ci_stages_pipeline ON ci_stages(pipeline_id);
```

### 6. WebSocket Events

Real-time updates broadcast to dashboard:

```typescript
// server/ws/handler.ts

export function broadcastPipelineStarted(pipeline: CIPipeline): void {
  broadcast({
    type: 'ci_pipeline_started',
    pipeline
  });
}

export function broadcastStageUpdate(pipelineId: number, stage: Stage): void {
  broadcast({
    type: 'ci_stage_update',
    pipeline_id: pipelineId,
    stage
  });
}

export function broadcastLogOutput(pipelineId: number, stageName: string, line: string): void {
  broadcast({
    type: 'ci_log_output',
    pipeline_id: pipelineId,
    stage_name: stageName,
    line
  });
}

export function broadcastPipelineComplete(pipelineId: number, status: string): void {
  broadcast({
    type: 'ci_pipeline_complete',
    pipeline_id: pipelineId,
    status
  });
}
```

## UI Design

### Option 1: Dedicated "Pipelines" Tab (Recommended)

**Navigation:**
```
┌────────────────────────────────────────────────────────┐
│  Claude Orchestrator                                   │
│  ┌──────────┐  ┌────────────┐                         │
│  │🎫 Tickets│  │🔧 Pipelines│ [2]  [Settings] [⚡Auto]│
│  └──────────┘  └────────────┘                         │
└────────────────────────────────────────────────────────┘
```

**Pipelines View (GitHub Actions Clone):**

```
┌────────────────────────────────────────────────────────────────────┐
│ CI/CD Runs                  │  PR #2040: Create Reusable Components │
│                             │                                        │
│ [✓] Fix ESLint errors       │  #2040 • 9cce238 • claude/batch-20    │
│     #2040 • 2m ago          │  Duration: 1m 23s                     │
│     ●●●●                    │                                        │
│                             │  ┌────────┐    ┌────────┐    ┌────────┐│
│ [✓] Add SummaryCard         │  │ ✓ test │────│ ✓ lint │────│ ✓ build││
│     #2039 • 5m ago          │  └────────┘    └────────┘    └────────┘│
│     ●●●●                    │                                        │
│                             │  ┌─────────────────────────────────────┤
│ [✗] Update API routes       │  │ ✓ test                       (34s) ││
│     #2038 • 10m ago         │  │   ▼ npm test                       ││
│     ●●●●                    │  │   [live log output...]             ││
│                             │  │                                    ││
│ [⏳] Deploy frontend        │  │ ✗ lint                       (12s) ││
│     #2037 • running         │  │   ▼ npm run lint                   ││
│     ●●●●                    │  │   [error output with annotations]  ││
│                             │  │                                    ││
│                             │  │ 🤖 Agent Auto-Fix                  ││
│                             │  │    Status: Fixing lint errors...   ││
└─────────────────────────────┴────────────────────────────────────────┘
```

**Component Files:**

```
web/src/components/ci/
├── CIPipelineList.tsx         # Left sidebar with run history
├── PipelineDetail.tsx         # Main content area with full details
├── VisualPipeline.tsx         # Connected boxes diagram
├── StageCard.tsx              # Expandable stage with logs
├── ErrorAnnotation.tsx        # File:line error display
├── AgentFixStatus.tsx         # Auto-fix agent progress
└── LogOutput.tsx              # Live-streaming log viewer
```

### Option 2: Inline CI Status in Ticket Cards

Add mini pipeline status directly to ticket cards:

```
┌─────────────────────────────────────────────┐
│ #1982 Create PageHeader component          │
│ PR #2040                          in_review │
├─────────────────────────────────────────────┤
│ CI Pipeline                   View details →│
│ ████████ ████████ ⏳⏳⏳⏳⏳ ░░░░░░░░        │
│ test     lint     build    deploy          │
│                                             │
│ ⏳ Running build...                  1m 23s │
│                                             │
│ ┌─────────────────────────────────────────┐│
│ │ 🤖 Agent fixing previous failures       ││
│ └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

### Option 3: Side Panel

```
┌──────────────────────────────────┬─────────────────────┐
│  🎫 Tickets                      │  🔧 CI Pipeline     │
│                                  │  PR #2040           │
│  [Ticket List]                   │  ─────────────────  │
│  ┌────────────────────────────┐ │  ✓ test      (34s) │
│  │ Selected: #1982            │ │  ✓ lint      (12s) │
│  │ [details...]               │ │  ⏳ build    (...)  │
│  └────────────────────────────┘ │                     │
│                                  │  [Live logs...]     │
└──────────────────────────────────┴─────────────────────┘
```

### Hybrid Approach (Best of All)

1. **Default:** Tickets with mini CI indicators
2. **Dedicated tab:** "Pipelines" for global CI view
3. **Modal overlay:** Click any CI indicator for full details

```typescript
// Tickets view: mini indicators
<TicketCard withCIIndicator onClick={() => openPipelineModal()} />

// Pipelines tab: full GitHub Actions clone
<Route path="/pipelines">
  <CIPipelineList />
</Route>

// Modal: expandable detail view
<PipelineModal prNumber={2040} onClose={...} />
```

## Key Features

### 1. Real-Time Log Streaming

```typescript
// Server streams logs as they happen
stage.output += newLine;
broadcastLogOutput(pipeline.id, stage.name, newLine);

// Client updates UI instantly
ws.onmessage = (event) => {
  if (event.type === 'ci_log_output') {
    appendToLog(event.stage_name, event.line);
    autoScrollToBottom();
  }
};
```

### 2. Error Parsing & Annotations

Parse errors from different tools:

```typescript
function parseErrors(output: string, stageName: string): ErrorAnnotation[] {
  const annotations: ErrorAnnotation[] = [];

  // ESLint format: /path/to/file.ts:45:12 - Error message
  const eslintPattern = /(.+?):(\d+):(\d+)\s+-\s+(.+)/g;

  // TypeScript format: file.ts(45,12): error TS2304: message
  const tsPattern = /(.+?)\((\d+),(\d+)\):\s+error\s+TS\d+:\s+(.+)/g;

  // Jest format: Expected X but received Y at file.ts:45:12
  const jestPattern = /at\s+(.+?):(\d+):(\d+)/g;

  // ... parse and create annotations

  return annotations;
}
```

### 3. Auto-Fix Agent Integration

When CI fails, automatically spawn agent with rich context:

- ❌ **Stage failed:** lint
- 📝 **Error annotations:** ESLint found 3 errors
- 🔍 **Failure analysis:** Uses iterative feedback feature (#2)
- 🎯 **Suggestions:** Category-specific fix guidance
- 🤖 **Agent spawned:** With full error context
- 🔄 **Auto-retry:** Pushes fix → CI reruns

### 4. GitHub Status Updates

Post status back to GitHub so PR still shows check status:

```typescript
await exec(`gh api repos/{owner}/{repo}/statuses/${commit_sha} \
  -f state=${status} \
  -f context="CI / ${stage.name}" \
  -f description="${description}" \
  -f target_url="${dashboard_url}"`);
```

## Implementation Phases

### Phase 1: Core Pipeline Engine
- [ ] Database schema for pipelines/stages
- [ ] CI executor with worktree integration
- [ ] Basic stages (test, lint, build)
- [ ] WebSocket events for real-time updates

### Phase 2: GitHub Integration
- [ ] Webhook handler for PR events
- [ ] Status updates back to GitHub
- [ ] Parse commit messages and metadata

### Phase 3: Basic UI
- [ ] "Pipelines" tab in dashboard
- [ ] Pipeline list view (sidebar)
- [ ] Pipeline detail view (main content)
- [ ] Stage cards with expandable logs

### Phase 4: Error Parsing
- [ ] ESLint error parser
- [ ] TypeScript error parser
- [ ] Jest test failure parser
- [ ] Error annotation UI

### Phase 5: Auto-Fix Integration
- [ ] Spawn agent on CI failure
- [ ] Pass failure analysis context
- [ ] Link agent to pipeline in DB/UI
- [ ] Agent progress display

### Phase 6: Advanced Features
- [ ] Pipeline templates (dev vs prod)
- [ ] Manual stage triggers
- [ ] Pipeline artifacts/caching
- [ ] Deploy stages with approvals

## Benefits Over GitHub Actions

| Feature | GitHub Actions | Local CI/CD |
|---------|----------------|-------------|
| Cost | $$ per minute | Free |
| Speed | Queue delays | Instant |
| Debugging | Scattered logs | Unified dashboard |
| Auto-fix | Manual | Automatic agent |
| Control | Limited | Full |
| Integration | External | Native |
| Error context | Basic | Rich (failure analysis) |

## Security Considerations

1. **Webhook authentication:** Validate GitHub webhook signatures
2. **Sandbox execution:** Consider Docker containers for untrusted PRs
3. **Resource limits:** Timeout stages, limit CPU/memory
4. **Secret management:** Don't expose secrets in logs
5. **Fork PRs:** Extra caution when running CI on fork PRs

## Configuration

```typescript
// server/config/ci.ts
export const CI_CONFIG = {
  // Stages to run for each PR
  stages: [
    {
      name: 'test',
      commands: ['npm test'],
      timeout: 300000, // 5 min
      required: true
    },
    {
      name: 'lint',
      commands: ['npm run lint'],
      timeout: 60000, // 1 min
      required: true
    },
    {
      name: 'build',
      commands: ['npm run build'],
      timeout: 180000, // 3 min
      required: true
    },
    {
      name: 'deploy-dev',
      commands: ['./scripts/deploy-dev.sh'],
      timeout: 600000, // 10 min
      required: false,
      branch: 'dev' // Only run on dev branch
    }
  ],

  // Auto-fix settings
  autoFix: {
    enabled: true,
    maxAttempts: 3,
    cooldownMs: 30000 // Wait 30s before spawning agent
  },

  // Concurrency
  maxConcurrentPipelines: 3, // Reuse worktree pool

  // Retention
  retentionDays: 30 // Keep pipeline data for 30 days
};
```

## Future Enhancements

- **Deploy previews:** Spin up preview environments for PRs
- **Visual regression testing:** Screenshot diffing
- **Performance budgets:** Fail if bundle size exceeds threshold
- **Dependency scanning:** Security vulnerability checks
- **Code coverage tracking:** Trend over time
- **Parallel stages:** Run test/lint concurrently
- **Matrix builds:** Test multiple Node versions
- **Scheduled pipelines:** Nightly builds

## References

- GitHub Actions UI inspiration
- Existing orchestrator features (worktree pool, error categorization, iterative feedback)
- PR #6: Progress tracking (can reuse for CI progress)
- PR #7: Error categorization & failure analysis (perfect for CI)
- PR #8: Exponential backoff (for CI retries)

---

**Status:** Ready for implementation when needed
**Estimated Effort:** 2-3 weeks full-time development
**Dependencies:** Current orchestrator infrastructure (worktrees, agents, WebSocket, db)
