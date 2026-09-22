import { test, expect, mock } from 'bun:test';

const state: any = {
  threads: [], commits: [], filesBySha: {}, resolved: [] as string[],
  throwCommits: false, throwFiles: false,
};

mock.module('./client.ts', () => ({
  getUnresolvedReviewThreads: async () => state.threads,
  getAuthenticatedLogin: async () => 'bot-we-push-as',
  getPRCommits: async () => { if (state.throwCommits) throw new Error('boom'); return state.commits; },
  getCommitFiles: async (sha: string) => { if (state.throwFiles) throw new Error('boom'); state.fileCalls = (state.fileCalls||0)+1; return state.filesBySha[sha] ?? []; },
  resolveReviewThread: async (id: string) => { state.resolved.push(id); return true; },
}));

const { resolveAddressedThreads } = await import('./thread-resolver');

const REVIEW = '2026-09-20T10:00:00Z';
function thread(over: any = {}) {
  return {
    id: 'T1', path: 'a.ts', line: 3, isOutdated: false,
    firstComment: 'leaks', lastAuthor: 'bot-we-push-as', replyCount: 1, commentIds: [1, 2],
    comments: [
      { id: 1, author: 'github-actions[bot]', createdAt: REVIEW, body: 'leaks' },
      { id: 2, author: 'bot-we-push-as', createdAt: '2026-09-20T11:00:00Z', body: 'fixed' },
    ],
    ...over,
  };
}
function reset() { state.threads=[]; state.commits=[]; state.filesBySha={}; state.resolved=[]; state.throwCommits=false; state.throwFiles=false; state.fileCalls=0; }

test('resolves when a post-review commit touches the path', async () => {
  reset();
  state.threads = [thread()];
  state.commits = [{ sha: 'old', date: '2026-09-20T09:00:00Z' }, { sha: 'new', date: '2026-09-20T10:30:00Z' }];
  state.filesBySha = { old: ['a.ts'], new: ['a.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.resolved.map(v => v.threadId)).toEqual(['T1']);
  expect(state.resolved).toEqual(['T1']);
});

test('pre-review work is not evidence', async () => {
  reset();
  state.threads = [thread()];
  state.commits = [{ sha: 'old', date: '2026-09-20T09:00:00Z' }];
  state.filesBySha = { old: ['a.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.unbackedClaims.length).toBe(1);
  expect(state.resolved).toEqual([]);
  expect(r.unbackedClaims[0].reason).toContain('nothing was pushed');
});

test('post-review commit touching a different file is not evidence', async () => {
  reset();
  state.threads = [thread()];
  state.commits = [{ sha: 'new', date: '2026-09-20T12:00:00Z' }];
  state.filesBySha = { new: ['other.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.unbackedClaims.length).toBe(1);
  expect(r.unbackedClaims[0].reason).toContain('none of the 1 commit');
});

test('uses the LAST reviewer comment, not the first', async () => {
  reset();
  state.threads = [thread({ comments: [
    { id: 1, author: 'github-actions[bot]', createdAt: '2026-09-19T10:00:00Z', body: 'round 1' },
    { id: 2, author: 'bot-we-push-as', createdAt: '2026-09-19T11:00:00Z', body: 'fixed' },
    { id: 3, author: 'github-actions[bot]', createdAt: '2026-09-20T10:00:00Z', body: 're-raised' },
    { id: 4, author: 'bot-we-push-as', createdAt: '2026-09-20T10:05:00Z', body: 'fixed again' },
  ], replyCount: 3 })];
  state.commits = [{ sha: 'round1', date: '2026-09-19T10:30:00Z' }];
  state.filesBySha = { round1: ['a.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.unbackedClaims.length).toBe(1);  // round-1 work must not clear round 2
});

test('commit stamped exactly at the comment counts as after', async () => {
  reset();
  state.threads = [thread()];
  state.commits = [{ sha: 'same', date: REVIEW }];
  state.filesBySha = { same: ['a.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.resolved.length).toBe(1);
});

test('no reply is never resolved', async () => {
  reset();
  state.threads = [thread({ lastAuthor: 'github-actions[bot]', replyCount: 0, comments: [
    { id: 1, author: 'github-actions[bot]', createdAt: REVIEW, body: 'leaks' },
  ] })];
  state.commits = [{ sha: 'new', date: '2026-09-20T12:00:00Z' }];
  state.filesBySha = { new: ['a.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.stillOpen[0].decision).toBe('no_reply');
  expect(state.resolved).toEqual([]);
});

test('null path is unverifiable, not resolved', async () => {
  reset();
  state.threads = [thread({ path: null })];
  state.commits = [{ sha: 'new', date: '2026-09-20T12:00:00Z' }];
  state.filesBySha = { new: ['a.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(r.unverifiable.length).toBe(1);
  expect(state.resolved).toEqual([]);
});

test('commit API failure resolves nothing', async () => {
  reset();
  state.threads = [thread()];
  state.throwCommits = true;
  const r = await resolveAddressedThreads(1);
  expect(r.unverifiable.length).toBe(1);
  expect(state.resolved).toEqual([]);
});

test('getCommitFiles failure resolves nothing', async () => {
  reset();
  state.threads = [thread()];
  state.commits = [{ sha: 'new', date: '2026-09-20T12:00:00Z' }];
  state.throwFiles = true;
  const r = await resolveAddressedThreads(1);
  expect(r.unverifiable.length).toBe(1);
  expect(state.resolved).toEqual([]);
});

test('per-commit file lists are cached across threads', async () => {
  reset();
  state.threads = [thread({ id: 'T1' }), thread({ id: 'T2', path: 'b.ts' }), thread({ id: 'T3', path: 'c.ts' })];
  state.commits = [{ sha: 'new', date: '2026-09-20T12:00:00Z' }];
  state.filesBySha = { new: ['a.ts', 'b.ts'] };
  const r = await resolveAddressedThreads(1);
  expect(state.fileCalls).toBe(1);           // 3 threads, same window, 1 API call
  expect(r.resolved.map(v => v.threadId).sort()).toEqual(['T1', 'T2']);
  expect(r.unbackedClaims.map(v => v.threadId)).toEqual(['T3']);
});
