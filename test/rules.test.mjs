// 계산 규칙 자동 테스트. 기록 형식이나 규칙이 바뀌었을 때 알아채기 위한 것이다.
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {
  sessions, newAgent, newSession, applyRecord, readNew, sessionStatus, subStatus,
  signals, typeMedians, progressOf, advisorInfo, summary, detail, parseArgs, resolveRoot, listen,
} from '../server.mjs';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
let seq = 0;
const toolUse = (name, input = {}, extra = {}) => {
  const id = 'tu_' + (++seq);
  return { id, rec: { type: 'assistant', timestamp: iso(0), message: { id: 'msg_' + seq, model: 'claude-test-1-0', content: [{ type: 'tool_use', id, name, input }], ...extra } } };
};
const toolResult = (id, isError = false) => ({ type: 'user', timestamp: iso(0), message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'out' }] } });
const prompt = (text, extra = {}) => ({ type: 'user', timestamp: iso(0), message: { content: text }, ...extra });
const advisor = () => ({ type: 'assistant', timestamp: iso(0), message: { id: 'msg_' + (++seq), model: 'claude-test-1-0', content: [{ type: 'server_tool_use', id: 'st_' + seq, name: 'advisor', input: {} }] } });
const endTurn = () => ({ type: 'assistant', timestamp: iso(0), message: { id: 'msg_' + (++seq), model: 'claude-test-1-0', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } });
const feed = (s, ...recs) => { for (const r of recs) applyRecord(s, s, r); };
/** 도구를 부르고 결과까지 받은 것으로 기록 */
const call = (s, name, input, isError = false) => { const t = toolUse(name, input); feed(s, t.rec, toolResult(t.id, isError)); };

test('세션 상태: 마지막 활동 시각으로 추정', () => {
  const mk = (idleMs, patch = {}) => Object.assign(newSession('s', 'p'), { mtimeMs: NOW - idleMs, lastStop: 'end_turn' }, patch);
  assert.equal(sessionStatus(mk(5_000), NOW), 'working', '15초 안 활동');
  assert.equal(sessionStatus(mk(60_000), NOW), 'waiting', '응답이 끝났고 30분 안');
  assert.equal(sessionStatus(mk(60_000, { lastStop: 'tool_use' }), NOW), 'working', '응답이 안 끝났고 3분 안');
  assert.equal(sessionStatus(mk(200_000, { lastStop: 'tool_use' }), NOW), 'waiting', '응답이 안 끝났어도 3분을 넘김');
  assert.equal(sessionStatus(mk(31 * 60_000), NOW), 'idle', '30분 넘음');

  const pending = mk(10 * 60_000);
  pending.pending.set('x', { name: 'Bash' });
  assert.equal(sessionStatus(pending, NOW), 'working', '결과 대기 도구가 있고 30분 안');
  pending.mtimeMs = NOW - 31 * 60_000;
  assert.equal(sessionStatus(pending, NOW), 'idle', '결과 대기 도구가 있어도 30분 넘음');

  const withSub = mk(31 * 60_000);
  withSub.subagents.set('a', newAgent({ finished: false, mtimeMs: NOW - 60_000 }));
  assert.equal(sessionStatus(withSub, NOW), 'working', '하위 에이전트 실행 중');
});

test('하위 에이전트 상태', () => {
  assert.equal(subStatus(newAgent({ finished: true, mtimeMs: NOW }), NOW), 'done');
  assert.equal(subStatus(newAgent({ finished: false, mtimeMs: NOW - 179_000 }), NOW), 'running');
  assert.equal(subStatus(newAgent({ finished: false, mtimeMs: NOW - 181_000 }), NOW), 'stalled');
});

test('도구 호출·오류·결과 대기 집계', () => {
  const s = newSession('s', 'p');
  const a = toolUse('Bash', { command: 'ls' });
  feed(s, a.rec);
  assert.equal(s.toolCalls, 1);
  assert.equal(s.pending.size, 1);
  feed(s, toolResult(a.id, true));
  assert.equal(s.pending.size, 0);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.tools, { Bash: 1 });
  assert.equal(s.events.at(-1).kind, 'error');
});

test('토큰: 같은 메시지가 여러 줄로 기록돼도 한 번만 센다', () => {
  const s = newSession('s', 'p');
  const rec = (out) => ({ type: 'assistant', timestamp: iso(0), message: { id: 'same', model: 'claude-test-1-0', usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }, content: [] } });
  feed(s, rec(3), rec(7));
  assert.deepEqual(s.usage, { input: 10, output: 7, cacheRead: 100, cacheCreate: 5 });
  assert.equal(s.context, 115);
});

test('사용자 요청 수: 사람이 보낸 메시지만 센다', () => {
  const s = newSession('s', 'p');
  feed(s, prompt('고쳐 줘'), prompt('<system-reminder>x</system-reminder>'), prompt('meta', { isMeta: true }), prompt('side', { isSidechain: true }), prompt('[Request interrupted by user]'));
  assert.equal(s.turns, 1);
});

test('판단 층: 표본 5건 미만이면 판정하지 않는다', () => {
  const s = newSession('s', 'p');
  for (let i = 0; i < 4; i++) call(s, 'Read', { file_path: '/x/a.js' });
  for (const g of signals(s)) assert.equal(g.value, null, g.key);
  call(s, 'Read', { file_path: '/x/a.js' });
  const byKey = Object.fromEntries(signals(s).map((g) => [g.key, g]));
  assert.equal(byKey.file.value, 1);
  assert.equal(byKey.file.pick, 'a.js');
  assert.equal(byKey.tool.value, 1);
  assert.equal(byKey.ok.value, 1);
  assert.equal(byKey.ok.errs, 0);
});

test('판단 층: 비율 계산, 기록용 호출 제외, 최근 20건만', () => {
  const s = newSession('s', 'p');
  for (let i = 0; i < 3; i++) call(s, 'Edit', { file_path: '/x/a.js' });
  for (let i = 0; i < 2; i++) call(s, 'Read', { file_path: '/x/b.js' }, true);
  for (let i = 0; i < 5; i++) call(s, 'mcp__ccd_turn__update_plan', {});
  const byKey = Object.fromEntries(signals(s).map((g) => [g.key, g]));
  assert.equal(byKey.file.value, 0.6);
  assert.equal(byKey.tool.n, 5, '기록용 호출은 표본에서 뺀다');
  assert.equal(byKey.tool.value, 0.6);
  assert.equal(byKey.ok.value, 0.8, '오류 2건 / 10건');
  assert.equal(byKey.ok.errs, 2);
  for (let i = 0; i < 30; i++) call(s, 'Bash', { command: 'x' });
  assert.equal(s.recent.length, 20);
  assert.equal(signals(s).find((g) => g.key === 'tool').value, 1);
});

test('로그의 p: 같은 선택의 비율, 기록용 호출에는 붙이지 않는다', () => {
  const s = newSession('s', 'p');
  call(s, 'Bash', { command: 'a' });
  call(s, 'Grep', { pattern: 'x' });
  call(s, 'Bash', { command: 'b' });
  const tools = s.events.filter((e) => e.kind === 'tool');
  assert.equal(tools.at(-1).p, 2 / 3);
  assert.equal(tools.at(-1).pn, 3);
  assert.equal(tools.at(-1).pk, 'tool');
  call(s, 'TodoWrite', {});
  assert.equal(s.events.filter((e) => e.kind === 'tool').at(-1).p, undefined);
  call(s, 'Edit', { file_path: '/x/a.js' });
  const last = s.events.filter((e) => e.kind === 'tool').at(-1);
  assert.equal(last.pk, 'file');
  assert.equal(last.p, 1);
});

test('자문 시점: 파일 수정 전 → plan', () => {
  const s = newSession('s', 'p');
  feed(s, prompt('시작'));
  for (let i = 0; i < 3; i++) call(s, 'Read', { file_path: '/x/a.js' });
  feed(s, advisor());
  for (let i = 0; i < 3; i++) call(s, 'Read', { file_path: '/x/a.js' });
  feed(s, endTurn());
  assert.deepEqual(s.advisorWhy, { plan: 1, error: 0, done: 0 });
  assert.equal(s.events.find((e) => e.kind === 'advisor').code, 'advice');
});

test('자문 시점: 직전 6건 중 오류 2건 이상 → error', () => {
  const s = newSession('s', 'p');
  feed(s, prompt('시작'));
  call(s, 'Bash', { command: 'a' }, true);
  call(s, 'Bash', { command: 'a' }, true);
  feed(s, advisor());
  assert.deepEqual(s.advisorWhy, { plan: 0, error: 1, done: 0 });
});

test('자문 시점: 수정한 뒤, 또는 자문 뒤 도구 2건 이하로 응답 종료 → done', () => {
  const edited = newSession('s', 'p');
  feed(edited, prompt('시작'));
  call(edited, 'Edit', { file_path: '/x/a.js' });
  feed(edited, advisor());
  assert.deepEqual(edited.advisorWhy, { plan: 0, error: 0, done: 1 });

  const quick = newSession('s', 'p');
  feed(quick, prompt('시작'), advisor());
  assert.equal(quick.advisorWhy.plan, 1);
  call(quick, 'Read', { file_path: '/x/a.js' });
  feed(quick, endTurn());
  assert.deepEqual(quick.advisorWhy, { plan: 0, error: 0, done: 1 }, 'plan 으로 셌던 것을 done 으로 옮긴다');
});

test('진행률: 같은 종류 완료 기록의 중앙값과 견준다', () => {
  sessions.clear();
  const s = newSession('s', 'p');
  sessions.set('s', s);
  const add = (id, type, finished, toolCalls) => s.subagents.set(id, newAgent({ id, agentType: type, finished, toolCalls }));
  add('a', 'Explore', true, 10);
  assert.equal(progressOf({ agentType: 'Explore', toolCalls: 5 }, 'running', typeMedians()).progress, null, '완료 기록 1건 → 추정 안 함');
  add('b', 'Explore', true, 30);
  const m = typeMedians();
  assert.deepEqual(m.get('Explore'), { n: 2, median: 20 });
  assert.deepEqual(progressOf({ agentType: 'Explore', toolCalls: 5 }, 'running', m), { progress: 25, est: true, basisN: 2, basisMedian: 20 });
  assert.equal(progressOf({ agentType: 'Explore', toolCalls: 0 }, 'running', m).progress, 3, '아래로 3%');
  assert.equal(progressOf({ agentType: 'Explore', toolCalls: 500 }, 'running', m).progress, 95, '위로 95%');
  assert.deepEqual(progressOf({ agentType: 'Explore', toolCalls: 1 }, 'done', m), { progress: 100, est: false });
  assert.equal(progressOf({ agentType: 'Plan', toolCalls: 5 }, 'running', m).progress, null, '다른 종류');
  sessions.clear();
});

test('요약·상세: 언어에 묶인 문구를 서버가 넣지 않는다', () => {
  const s = newSession('s', 'p');
  feed(s, prompt('시작'), { type: 'system', subtype: 'compact_boundary', timestamp: iso(0) }, advisor());
  call(s, 'Read', { file_path: '/x/a.js' });
  s.subagents.set('a', newAgent({ id: 'a', agentType: '', finished: false }));
  const sum = summary(s, NOW);
  assert.equal(sum.title, null, '제목이 없으면 null (화면이 언어에 맞춰 채움)');
  const d = detail(s, NOW);
  assert.equal(d.subagentList[0].type, '');
  assert.equal(d.events.find((e) => e.kind === 'info').code, 'compact');
  assert.equal(d.advisor.calls, 1);
  const leaked = JSON.stringify({ ...d, events: d.events.filter((e) => e.kind !== 'prompt') }).match(/[가-힣]+/);
  assert.equal(leaked, null, '기록에서 온 글이 아닌 한국어가 섞여 있음');
});

test('자문 집계: 메인과 하위 에이전트를 합친다', () => {
  const s = newSession('s', 'p');
  const sub = newAgent({ id: 'a', agentType: 'Explore' });
  feed(s, prompt('시작'), advisor());
  applyRecord(sub, s, advisor());
  const info = advisorInfo(s, [sub]);
  assert.equal(info.calls, 2);
  assert.equal(info.why.plan, 2);
});

test('기록 파일: 늘어난 만큼만 읽고, 덜 써진 줄은 다음에 읽고, 잘리면 처음부터 다시 센다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watchtower-test-'));
  const file = path.join(dir, 's.jsonl');
  try {
    const line = (name) => JSON.stringify(toolUse(name).rec) + '\n';
    const s = newSession('s', 'p');
    const entry = { offset: 0, agent: s, session: s };
    const size = () => fs.statSync(file).size;

    fs.writeFileSync(file, line('Bash') + line('Read'));
    assert.equal(await readNew(file, entry, size()), true);
    assert.equal(s.toolCalls, 2);
    assert.equal(await readNew(file, entry, size()), false, '바뀐 게 없으면 다시 읽지 않는다');

    const half = line('Grep');
    fs.appendFileSync(file, half.slice(0, 20));
    await readNew(file, entry, size());
    assert.equal(s.toolCalls, 2, '줄바꿈이 안 온 줄은 아직 세지 않는다');
    fs.appendFileSync(file, half.slice(20));
    await readNew(file, entry, size());
    assert.equal(s.toolCalls, 3);

    fs.appendFileSync(file, '{"type":"api-request","big":"x"}\nnot json\n');
    await readNew(file, entry, size());
    assert.equal(s.toolCalls, 3, '요청 원문 사본과 깨진 줄은 건너뛴다');

    fs.writeFileSync(file, line('Edit'));
    await readNew(file, entry, size());
    assert.equal(s.toolCalls, 1, '파일이 잘리면 집계를 비우고 처음부터');
    assert.deepEqual(s.tools, { Edit: 1 });
    assert.equal(s.id, 's', '세션 정체성은 유지');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('명령줄 옵션', () => {
  assert.deepEqual(parseArgs([]), {});
  assert.deepEqual(parseArgs(['-p', '4488', '--hours=48', '--no-open', '--dir', '/x']), { port: 4488, hours: 48, open: false, dir: '/x' });
  assert.deepEqual(parseArgs(['--port=5000', '--open']), { port: 5000, open: true });
  assert.ok(parseArgs(['--port', 'abc']).error);
  assert.ok(parseArgs(['--port']).error);
  assert.ok(parseArgs(['--hours', '0']).error);
  assert.ok(parseArgs(['--nope']).error);
  assert.equal(parseArgs(['-h']).help, true);
});

test('기록 폴더 위치', () => {
  const home = path.join(path.sep, 'home', 'me');
  assert.equal(resolveRoot(undefined, {}, home), path.join(home, '.claude', 'projects'));
  assert.equal(resolveRoot(undefined, { CLAUDE_CONFIG_DIR: path.join(path.sep, 'cfg') }, home), path.join(path.sep, 'cfg', 'projects'));
  assert.equal(resolveRoot(undefined, { CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_PROJECTS_DIR: '/p' }, home), '/p');
  assert.equal(resolveRoot('/d', { CLAUDE_PROJECTS_DIR: '/p' }, home), path.resolve('/d'));
});

test('포트: 겹치면 다음 번호로 옮기고 실제로 연 번호를 돌려준다, 직접 정한 포트는 옮기지 않는다', async () => {
  const a = http.createServer(), b = http.createServer(), c = http.createServer();
  try {
    const pa = await listen(a, 0, true);   // 0 = 운영체제가 빈 포트를 고름
    const pb = await listen(b, pa, false);
    assert.notEqual(pb, pa);
    assert.equal(b.address().port, pb, '돌려준 번호와 실제로 연 번호가 같아야 함');
    await assert.rejects(listen(c, pa, true), { code: 'EADDRINUSE' });
  } finally { for (const s of [a, b, c]) s.close(); }
});

test('포트: IPv6 에 같은 포트를 쓰는 프로그램이 있어도 127.0.0.1 로는 모니터에 닿는다', async () => {
  const other = http.createServer((q, r) => r.end('other'));
  const mon = http.createServer((q, r) => r.end('monitor'));
  try {
    try { await new Promise((ok, no) => { other.once('error', no); other.listen(0, '::1', ok); }); }
    catch { return; }   // IPv6 를 못 쓰는 환경이면 건너뜀
    const port = other.address().port;
    const got = await listen(mon, port, true);
    assert.equal(got, port);
    const body = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    assert.equal(body, 'monitor', '안내하는 주소(127.0.0.1)는 모니터로 가야 함');
  } finally { other.close(); mon.close(); }
});

test('제목: 직접 붙인 제목 > 에이전트 이름 > VS Code 자동 제목', () => {
  const s = newSession('s', 'p');
  feed(s, { type: 'ai-title', aiTitle: 'auto' });
  assert.equal(summary(s, NOW).title, 'auto');
  feed(s, { type: 'custom-title', customTitle: 'mine' });
  assert.equal(summary(s, NOW).title, 'mine');
});
