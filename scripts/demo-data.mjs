#!/usr/bin/env node
// 화면 예시용 가짜 세션 기록을 만든다. 실제 기록 대신 이것으로 띄워 README 스크린샷을 찍는다
// (실제 기록에는 프롬프트·폴더 경로가 들어 있어 공개하면 안 된다).
//
//   node scripts/demo-data.mjs <출력 폴더>
//   node server.mjs --dir <출력 폴더> --no-open
//
// 시각은 실행한 순간 기준이라, 만들고 곧바로 띄워야 '작업 중'·'실행 중'으로 보인다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/demo-data.mjs <output dir>'); process.exit(2); }
fs.rmSync(out, { recursive: true, force: true });

const NOW = Date.now();
const iso = (secAgo) => new Date(NOW - secAgo * 1000).toISOString();
const home = os.homedir();   // 화면은 홈 폴더를 ~ 로 줄여 보여 주므로, 홈 아래 경로로 만든다
let seq = 0;
const id = (p) => `${p}_${(++seq).toString(36).padStart(6, '0')}`;

const MODEL = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' };

/** 기록 한 파일을 쌓는 도우미. t 는 '몇 초 전'으로 흐른다 (큰 값 → 작은 값). */
function transcript({ model, effort = 'high', advisor = null, cwd, branch }) {
  const lines = [];
  let ctx = 18_000;
  const assistant = (t, content, stop = 'tool_use') => {
    ctx += 2_000 + Math.round(Math.random() * 3_000);
    lines.push({
      type: 'assistant', timestamp: iso(t), effort, ...(advisor ? { advisorModel: advisor } : {}), cwd, gitBranch: branch,
      message: { id: id('msg'), model, role: 'assistant', content, stop_reason: stop,
        usage: { input_tokens: 3, cache_creation_input_tokens: 1_800, cache_read_input_tokens: ctx, output_tokens: 300 + Math.round(Math.random() * 900) } },
    });
  };
  const api = {
    lines,
    title(text) { lines.push({ type: 'custom-title', customTitle: text }); return api; },
    aiTitle(text) { lines.push({ type: 'ai-title', aiTitle: text }); return api; },
    prompt(t, text) { lines.push({ type: 'user', timestamp: iso(t), cwd, gitBranch: branch, message: { role: 'user', content: text } }); return api; },
    say(t, text, stop = 'end_turn') { assistant(t, [{ type: 'text', text }], stop); return api; },
    /** 도구 호출 + 결과. pending 이면 결과를 남기지 않는다 (결과를 기다리는 도구). */
    tool(t, name, input, { error = false, pending = false, useId } = {}) {
      const tid = useId || id('toolu');
      assistant(t, [{ type: 'tool_use', id: tid, name, input }]);
      if (!pending) lines.push({ type: 'user', timestamp: iso(Math.max(0, t - 2)), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, is_error: error, content: error ? 'FAIL  test/rateLimit.test.ts › resets the window after 60s\n  Expected: 200  Received: 429' : 'ok' }] } });
      return api;
    },
    advise(t) { assistant(t, [{ type: 'server_tool_use', id: id('srvtoolu'), name: 'advisor', input: {} }]); return api; },
    cost(usd) { lines.push({ type: 'cost-state', totalCostUSD: usd }); return api; },
  };
  return api;
}

function writeSession({ project, sid, rec, mtimeAgo, subagents = [] }) {
  const dir = path.join(out, project);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, rec.lines.map((l) => JSON.stringify({ sessionId: sid, ...l })).join('\n') + '\n');
  const m = new Date(NOW - mtimeAgo * 1000);
  for (const s of subagents) {
    const sdir = path.join(dir, sid, 'subagents');
    fs.mkdirSync(sdir, { recursive: true });
    const sf = path.join(sdir, `agent-${s.id}.jsonl`);
    fs.writeFileSync(sf, s.rec.lines.map((l) => JSON.stringify({ sessionId: sid, isSidechain: true, ...l })).join('\n') + '\n');
    fs.writeFileSync(path.join(sdir, `agent-${s.id}.meta.json`), JSON.stringify({ agentType: s.type, description: s.description, finished: s.finished }));
    const sm = new Date(NOW - s.mtimeAgo * 1000);
    fs.utimesSync(sf, sm, sm);
  }
  fs.utimesSync(file, m, m);
}

/** 하위 에이전트 기록: 읽기 위주의 도구 호출 n 건 */
function subagent({ model, start, every, calls, cwd, branch, finished, finalText }) {
  const r = transcript({ model, effort: 'medium', cwd, branch });
  let t = start;
  for (const [name, input] of calls) { r.tool(t, name, input); t -= every; }
  if (finished) r.say(t, finalText || 'Done. Summary returned to the main session.');
  return r;
}

// ───────────── 1. 작업 중인 메인 세션: 하위 에이전트 3개, 조언자 3회, 오류 2건 ─────────────
{
  const cwd = path.join(home, 'projects', 'shop-api'), branch = 'feat/rate-limit';
  const r = transcript({ model: MODEL.opus, advisor: MODEL.opus, cwd, branch }).title('Add rate limiting to the public API');
  r.prompt(1500, 'Add per-key rate limiting to the public API (100 req/min), return RateLimit headers, and cover it with tests.');
  r.tool(1490, 'Read', { file_path: `${cwd}/src/server.ts` });
  r.tool(1480, 'Grep', { pattern: 'app.use\\(' });
  r.tool(1470, 'Read', { file_path: `${cwd}/src/middleware/auth.ts` });
  r.advise(1460);                                                                        // 계획 확정 전
  r.tool(1450, 'Agent', { subagent_type: 'Explore', description: 'Find existing middleware and config loading' });
  r.tool(1100, 'Read', { file_path: `${cwd}/src/config.ts` });
  r.tool(1090, 'Write', { file_path: `${cwd}/src/middleware/rateLimit.ts` });
  r.tool(1080, 'Edit', { file_path: `${cwd}/src/server.ts` });
  r.tool(1070, 'Write', { file_path: `${cwd}/test/rateLimit.test.ts` });
  r.tool(1000, 'Bash', { description: 'Run the rate limiter tests', command: 'npm test -- rateLimit' }, { error: true });
  r.tool(960, 'Edit', { file_path: `${cwd}/src/middleware/rateLimit.ts` });
  r.tool(900, 'Bash', { description: 'Run the rate limiter tests', command: 'npm test -- rateLimit' }, { error: true });
  r.advise(880);                                                                         // 같은 오류 반복 뒤
  r.tool(860, 'Read', { file_path: `${cwd}/src/middleware/rateLimit.ts` });
  r.tool(840, 'Edit', { file_path: `${cwd}/src/middleware/rateLimit.ts` });
  r.tool(780, 'Bash', { description: 'Run the rate limiter tests', command: 'npm test -- rateLimit' });
  r.tool(700, 'Bash', { description: 'Run the full test suite', command: 'npm test' });
  r.tool(640, 'Edit', { file_path: `${cwd}/README.md` });
  r.say(620, 'Tests pass. Asking a reviewer and checking the header spec before I call this done.', 'tool_use');
  r.advise(600);                                                                         // 완료 선언 전
  r.tool(590, 'Agent', { subagent_type: 'Explore', description: 'Check the standard RateLimit-* response headers' }, { pending: true });
  r.tool(40, 'Agent', { subagent_type: 'critic', description: 'Review the rate limiter diff' }, { pending: true });
  r.cost(4.18);

  const subs = [
    { id: 'a1e0c0ffee01', type: 'Explore', description: 'Find existing middleware and config loading', finished: true, mtimeAgo: 1110,
      rec: subagent({ model: MODEL.haiku, start: 1440, every: 24, cwd, branch, finished: true, calls: [
        ['Glob', { pattern: 'src/**/*.ts' }], ['Read', { file_path: `${cwd}/src/server.ts` }], ['Grep', { pattern: 'middleware' }],
        ['Read', { file_path: `${cwd}/src/middleware/auth.ts` }], ['Read', { file_path: `${cwd}/src/middleware/cors.ts` }], ['Grep', { pattern: 'process.env' }],
        ['Read', { file_path: `${cwd}/src/config.ts` }], ['Read', { file_path: `${cwd}/package.json` }], ['Grep', { pattern: 'redis' }],
        ['Read', { file_path: `${cwd}/src/lib/redis.ts` }], ['Glob', { pattern: 'test/**/*.ts' }], ['Read', { file_path: `${cwd}/test/auth.test.ts` }],
        ['Grep', { pattern: 'supertest' }], ['Read', { file_path: `${cwd}/docs/api.md` }],
      ] }) },
    { id: 'a2e0c0ffee02', type: 'Explore', description: 'Check the standard RateLimit-* response headers', finished: false, mtimeAgo: 18,
      rec: subagent({ model: MODEL.haiku, start: 580, every: 90, cwd, branch, finished: false, calls: [
        ['WebSearch', { query: 'IETF RateLimit header fields draft' }], ['WebFetch', { url: 'https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/' }],
        ['Read', { file_path: `${cwd}/src/middleware/rateLimit.ts` }], ['Grep', { pattern: 'RateLimit-' }], ['Read', { file_path: `${cwd}/docs/api.md` }],
        ['Grep', { pattern: 'Retry-After' }],
      ] }) },
    { id: 'a3e0c0ffee03', type: 'critic', description: 'Review the rate limiter diff', finished: false, mtimeAgo: 4,
      rec: subagent({ model: MODEL.opus, start: 36, every: 8, cwd, branch, finished: false, calls: [
        ['Bash', { description: 'Show the diff', command: 'git diff main' }], ['Read', { file_path: `${cwd}/src/middleware/rateLimit.ts` }],
        ['Read', { file_path: `${cwd}/test/rateLimit.test.ts` }], ['Grep', { pattern: 'X-Forwarded-For' }],
      ] }) },
  ];
  writeSession({ project: '-projects-shop-api', sid: '7c1e2a90-5b3d-4f6e-9a21-1d2c3b4a5e6f', rec: r, mtimeAgo: 3, subagents: subs });
}

// ───────────── 2. 입력 대기: 끝난 하위 에이전트 1개 ─────────────
{
  const cwd = path.join(home, 'projects', 'shop-web'), branch = 'fix/checkout-flake';
  const r = transcript({ model: MODEL.sonnet, advisor: MODEL.opus, cwd, branch }).title('Fix flaky checkout test');
  r.prompt(2400, 'The checkout e2e test fails about 1 in 5 runs on CI. Find out why and fix it.');
  r.tool(2390, 'Bash', { description: 'Run the checkout test 10 times', command: 'for i in $(seq 10); do npx playwright test checkout; done' });
  r.tool(2200, 'Agent', { subagent_type: 'Explore', description: 'Find where the cart total is awaited' });
  r.advise(1800);
  r.tool(1790, 'Edit', { file_path: `${cwd}/e2e/checkout.spec.ts` });
  r.tool(1700, 'Bash', { description: 'Run the checkout test 20 times', command: 'for i in $(seq 20); do npx playwright test checkout; done' });
  r.say(260, 'Fixed: the test clicked "Pay" before the total finished updating. It now waits for the total. 20/20 runs pass. Want me to open a PR?');
  r.cost(1.07);
  const subs = [{ id: 'b1e0c0ffee01', type: 'Explore', description: 'Find where the cart total is awaited', finished: true, mtimeAgo: 1900,
    rec: subagent({ model: MODEL.haiku, start: 2190, every: 30, cwd, branch, finished: true, calls: [
      ['Grep', { pattern: 'cartTotal' }], ['Read', { file_path: `${cwd}/src/cart/Total.tsx` }], ['Read', { file_path: `${cwd}/e2e/checkout.spec.ts` }],
      ['Grep', { pattern: 'waitFor' }], ['Read', { file_path: `${cwd}/src/cart/useCart.ts` }], ['Glob', { pattern: 'e2e/**/*.ts' }],
      ['Read', { file_path: `${cwd}/playwright.config.ts` }], ['Grep', { pattern: 'debounce' }], ['Read', { file_path: `${cwd}/src/lib/debounce.ts` }],
      ['Read', { file_path: `${cwd}/src/cart/Pay.tsx` }],
    ] }) }];
  writeSession({ project: '-projects-shop-web', sid: '2f9d8c7b-6a5e-4d3c-8b2a-0e1f2a3b4c5d', rec: r, mtimeAgo: 255, subagents: subs });
}

// ───────────── 3. 입력 대기: VS Code 에서 연 세션 (자동 제목), 조언자 없음 ─────────────
{
  const cwd = path.join(home, 'projects', 'infra'), branch = 'main';
  const r = transcript({ model: MODEL.sonnet, cwd, branch }).aiTitle('Move CI to Node 24');
  r.prompt(1200, 'Update the GitHub Actions workflows to Node 24 and drop Node 20.');
  r.tool(1190, 'Glob', { pattern: '.github/workflows/*.yml' });
  r.tool(1180, 'Read', { file_path: `${cwd}/.github/workflows/ci.yml` });
  r.tool(1170, 'Edit', { file_path: `${cwd}/.github/workflows/ci.yml` });
  r.tool(1160, 'Edit', { file_path: `${cwd}/.github/workflows/release.yml` });
  r.say(720, 'Both workflows now use Node 24. Node 20 is removed from the matrix.');
  writeSession({ project: '-projects-infra', sid: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d', rec: r, mtimeAgo: 715 });
}

// ───────────── 4. 휴면: 몇 시간 전 ─────────────
{
  const cwd = path.join(home, 'projects', 'docs-site'), branch = 'main';
  const r = transcript({ model: MODEL.sonnet, effort: 'medium', cwd, branch }).title('Write release notes for v2.3');
  r.prompt(9000, 'Draft release notes for v2.3 from the merged PRs.');
  r.tool(8990, 'Bash', { description: 'List merged PRs since v2.2', command: 'gh pr list --state merged --search "merged:>2026-10-01"' });
  r.tool(8900, 'Write', { file_path: `${cwd}/content/releases/v2.3.md` });
  r.say(8800, 'Draft written to content/releases/v2.3.md.');
  writeSession({ project: '-projects-docs-site', sid: '4d3c2b1a-0f9e-4d8c-b7a6-5f4e3d2c1b0a', rec: r, mtimeAgo: 8800 });
}

// ───────────── 5. 휴면: 오류가 많았던 세션 ─────────────
{
  const cwd = path.join(home, 'projects', 'worker'), branch = 'debug/memory';
  const r = transcript({ model: MODEL.opus, advisor: MODEL.opus, cwd, branch }).title('Investigate memory growth in the job worker');
  r.prompt(20000, 'The job worker grows to 2 GB after a day. Find the leak.');
  r.tool(19990, 'Bash', { description: 'Take a heap snapshot', command: 'node --heapsnapshot-signal=SIGUSR2 dist/worker.js' }, { error: true });
  r.tool(19900, 'Bash', { description: 'Take a heap snapshot', command: 'node --heapsnapshot-signal=SIGUSR2 dist/worker.js' }, { error: true });
  r.advise(19850);
  r.tool(19800, 'Read', { file_path: `${cwd}/src/queue.ts` });
  r.tool(19700, 'Edit', { file_path: `${cwd}/src/queue.ts` });
  r.say(19600, 'Found it: listeners were added per job and never removed. Fixed in src/queue.ts.');
  r.cost(2.64);
  writeSession({ project: '-projects-worker', sid: '6e5d4c3b-2a1f-4e0d-9c8b-7a6f5e4d3c2b', rec: r, mtimeAgo: 19600 });
}

console.log(`demo transcripts written to ${out}`);
