// 에이전트 워치타워 — Claude Code 세션 기록(~/.claude/projects)을 읽어 브라우저로 실시간 전달하는 로컬 서버.
// 외부 패키지 없음. 읽기 전용(기록 파일을 고치지 않음). 127.0.0.1 에서만 접속 가능.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 4477;
const PORT_TRIES = 20;   // 포트를 따로 정하지 않았을 때, 겹치면 이만큼 다음 번호를 차례로 시도
// 실행 설정. main() 이 환경 변수와 명령줄 옵션으로 채운다. windowMs = 이 시간 안에 바뀐 세션만 추적
const cfg = { root: '', port: DEFAULT_PORT, windowMs: 24 * 3600_000 };
// 터미널 안내문: 시스템 언어가 한국어면 한국어, 그 밖에는 영어
const KO = /^ko/i.test(process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || '');
const say = (en, ko) => (KO ? ko : en);
const SCAN_MS = 2000;
const MAX_EVENTS = 300;
const RECENT_N = 20;     // 지표를 계산할 최근 도구 호출 수
const BOOKKEEPING = /update_plan|wrap_up|TodoWrite|ToolSearch/;
const MIN_SIGNAL_N = 5;  // 표본이 이보다 적으면 지표를 내지 않음 (1건짜리 '1.00' 방지)

/** @type {Map<string, any>} 세션 ID → 세션 상태 */
const sessions = new Map();
/** @type {Map<string, {offset:number, agent:any, session:any}>} 파일 경로 → 읽은 위치 */
const files = new Map();
let initialLoadDone = false;
let version = 0; // 상태가 바뀔 때마다 증가 → 브라우저에 알림

// ───────────────────────── 상태 만들기 ─────────────────────────

function newAgent(extra) {
  return {
    model: null, effort: null, advisorModel: null,
    firstTs: null, lastTs: null, mtimeMs: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
    context: 0,            // 가장 최근 요청의 입력 크기(= 현재 컨텍스트 추정)
    msgUsage: new Map(),   // 메시지 ID → 사용량 (같은 메시지가 여러 줄로 기록되므로 중복 합산 방지)
    tools: {}, toolCalls: 0, errors: 0,
    pending: new Map(),    // 아직 결과가 안 온 도구 호출
    lastStop: null, lastAction: '',
    recent: [],            // 최근 도구 호출 (지표 계산용): {id, name, file, err}
    advisorCalls: 0, advisorTimes: [], // 이 에이전트가 한 자문: {ts, why} (시각 오름차순, 최근 20개)
    advisorWhy: { plan: 0, error: 0, done: 0 }, // 추정한 시점별 횟수
    turnEdits: 0,          // 이번 사용자 요청 이후 파일을 고친 횟수 (자문 시점 추정용)
    lastAdvice: null, toolsSinceAdvice: 0, // 가장 최근 자문과 그 뒤의 도구 호출 수 ('완료 선언 전' 판정용)
    lastText: null,        // 가장 최근 응답 글
    events: [],
    ...extra,
  };
}

function newSession(id, projectDir) {
  return newAgent({
    id, projectDir, cwd: null, title: null, agentName: null, aiTitle: null, gitBranch: null,
    turns: 0, compactions: 0, cost: null,
    subagents: new Map(),
  });
}

/** 집계만 비움 (정체성·하위 에이전트 목록은 유지) */
function resetAgent(agent) {
  if (agent.subagents) {
    const subs = agent.subagents;
    Object.assign(agent, newSession(agent.id, agent.projectDir));
    agent.subagents = subs;
  } else Object.assign(agent, newAgent({}));
}

const clip = (s, n) => {
  s = String(s ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const base = (p) => (typeof p === 'string' ? path.basename(p) : '');
  switch (name) {
    case 'Bash': return clip(input.description || input.command, 90);
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit':
      return base(input.file_path || input.notebook_path);
    case 'Grep': case 'Glob': return clip(input.pattern, 60);
    case 'Agent': case 'Task':
      return clip(`${input.subagent_type ? '[' + input.subagent_type + '] ' : ''}${input.description || ''}`, 90);
    case 'WebSearch': return clip(input.query, 70);
    case 'WebFetch': try { return new URL(input.url).host; } catch { return ''; }
    case 'Skill': return clip(input.skill, 40);
    default: return clip(input.description || input.action || '', 70);
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : '')).join(' ');
  return '';
}

function pushEvent(agent, ev) {
  agent.events.push(ev);
  if (agent.events.length > MAX_EVENTS + 100) agent.events = agent.events.slice(-MAX_EVENTS);
}

/** 기록 한 줄을 상태에 반영. agent = 메인 세션이거나 하위 에이전트, session = 소속 세션 */
function applyRecord(agent, session, o) {
  const ts = o.timestamp ? Date.parse(o.timestamp) : null;
  if (ts) { agent.firstTs ??= ts; if (!agent.lastTs || ts > agent.lastTs) agent.lastTs = ts; }

  switch (o.type) {
    case 'custom-title': if (agent === session && o.customTitle) session.title = o.customTitle; return;
    case 'agent-name': if (agent === session && o.agentName) session.agentName = o.agentName; return;
    case 'ai-title': if (agent === session && o.aiTitle) session.aiTitle = o.aiTitle; return;   // VS Code 확장이 자동으로 붙이는 제목
    case 'cost-state':
      if (agent === session && typeof o.totalCostUSD === 'number') session.cost = o.totalCostUSD;
      return;
    case 'system':
      if (o.subtype === 'compact_boundary' && agent === session) {
        session.compactions++;
        pushEvent(agent, { ts, kind: 'info', code: 'compact' });   // 문구는 화면이 언어에 맞춰 붙인다
      }
      return;
    case 'user': return applyUser(agent, session, o, ts);
    case 'assistant': return applyAssistant(agent, session, o, ts);
    default: return;
  }
}

function applyUser(agent, session, o, ts) {
  if (agent === session) { if (o.cwd) session.cwd = o.cwd; if (o.gitBranch) session.gitBranch = o.gitBranch; }
  const c = o.message?.content;
  const blocks = typeof c === 'string' ? [{ type: 'text', text: c }] : Array.isArray(c) ? c : [];
  let prompt = null;
  for (const b of blocks) {
    if (b?.type === 'tool_result') {
      const p = agent.pending.get(b.tool_use_id);
      agent.pending.delete(b.tool_use_id);
      if (b.is_error) {
        const r = agent.recent.find((x) => x.id === b.tool_use_id);
        if (r) r.err = true;
        agent.errors++;
        pushEvent(agent, { ts, kind: 'error', tool: p?.name || null, text: clip(resultText(b.content), 140) });
      }
    } else if (b?.type === 'text' && prompt === null) prompt = b.text;
  }
  // 사람이 직접 보낸 메시지만 '요청'으로 셈 (시스템이 끼워 넣은 것, 하위 에이전트 지시문은 제외)
  if (prompt && agent === session && !o.isMeta && !o.isSidechain && !o.isCompactSummary && !o.isVisibleInTranscriptOnly
      && !/^\s*(<|\[Request interrupted)/.test(prompt)) {
    session.turns++;
    agent.turnEdits = 0; agent.lastAdvice = null;
    pushEvent(agent, { ts, kind: 'prompt', text: clip(prompt, 110) });
  }
}

function applyAssistant(agent, session, o, ts) {
  const m = o.message || {};
  if (m.model && m.model !== '<synthetic>') agent.model = m.model;
  if (o.effort) agent.effort = o.effort;
  if (o.advisorModel) agent.advisorModel = o.advisorModel;
  if (m.stop_reason) agent.lastStop = m.stop_reason;

  const u = m.usage;
  if (u && m.id && m.model !== '<synthetic>') {
    const cur = {
      input: u.input_tokens || 0, output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0, cacheCreate: u.cache_creation_input_tokens || 0,
    };
    const prev = agent.msgUsage.get(m.id);
    for (const k of Object.keys(cur)) agent.usage[k] += cur[k] - (prev ? prev[k] : 0);
    agent.msgUsage.set(m.id, cur);
    agent.context = cur.input + cur.cacheRead + cur.cacheCreate;
  }

  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b?.type === 'tool_use') {
      const summary = toolSummary(b.name, b.input);
      agent.toolCalls++;
      agent.tools[b.name] = (agent.tools[b.name] || 0) + 1;
      agent.pending.set(b.id, { name: b.name, ts, summary });
      if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') agent.turnEdits++;
      agent.toolsSinceAdvice++;
      const fp = b.input && (b.input.file_path || b.input.notebook_path);
      agent.recent.push({ id: b.id, name: b.name, file: typeof fp === 'string' ? path.basename(fp) : null, err: false, ts });
      if (agent.recent.length > RECENT_N) agent.recent.shift();
      agent.lastAction = summary ? `${b.name} · ${summary}` : b.name;
      // 로그 줄마다 붙이는 p: 이 호출을 포함한 최근 RECENT_N 건 중 '같은 선택'의 비율 (모델의 확신도가 아닌 대용값)
      //  - 파일을 다루는 호출이면 같은 파일을 고른 비율, 그 밖에는 같은 도구를 고른 비율
      //  - 기록용 호출은 표본에서 빼고 p 도 붙이지 않는다 (판단 층의 '어느 도구'와 같은 기준)
      const cur = agent.recent[agent.recent.length - 1];
      const book = BOOKKEEPING.test(cur.name);   // 작업 목록 갱신 같은 기록용 호출
      const pool = cur.file ? agent.recent.filter((x) => x.file) : agent.recent.filter((x) => !BOOKKEEPING.test(x.name));
      const same = pool.filter((x) => (cur.file ? x.file === cur.file : x.name === cur.name)).length;
      pushEvent(agent, { ts, kind: 'tool', tool: b.name, text: summary, ...(book ? {} : { p: same / pool.length, pn: pool.length, pk: cur.file ? 'file' : 'tool' }) });
    } else if (b?.type === 'server_tool_use') {
      // 서버 쪽 도구(조언자 등). 내용은 암호화되어 있어 호출 사실과 시각만 알 수 있음.
      const isAdvisor = /advis/i.test(b.name || '');
      if (isAdvisor) {
        // 조언 내용은 암호화되어 있어 '왜 불렀는지'는 알 수 없다. 앞선 도구 호출로 시점을 추정한다:
        //  - 최근 6건 중 오류가 2건 이상 → 같은 오류 반복 뒤(error)
        //  - 이번 요청에서 아직 파일을 고치지 않음 → 계획 확정 전(plan)
        //  - 그 밖(이미 고친 뒤) → 완료 선언 전(done)
        const why = agent.recent.slice(-6).filter((x) => x.err).length >= 2 ? 'error' : agent.turnEdits === 0 ? 'plan' : 'done';
        const entry = { ts, why };
        agent.advisorCalls++;
        agent.advisorWhy[why]++;
        agent.lastAdvice = entry; agent.toolsSinceAdvice = 0;
        if (ts) { // 파일을 읽는 순서가 시각순이 아닐 수 있으므로 정렬해 두고 가장 오래된 것부터 버림
          agent.advisorTimes.push(entry);
          agent.advisorTimes.sort((a, b) => a.ts - b.ts);
          if (agent.advisorTimes.length > 20) agent.advisorTimes.shift();
        }
      }
      pushEvent(agent, { ts, kind: isAdvisor ? 'advisor' : 'tool', tool: b.name, text: '', ...(isAdvisor ? { code: 'advice' } : {}) });
    } else if (b?.type === 'text' && b.text?.trim()) {
      pushEvent(agent, { ts, kind: 'text', text: clip(b.text, 120) });
      agent.lastText = clip(b.text, 220);
    }
  }

  if (m.stop_reason === 'end_turn' && agent.lastAdvice) {
    const a = agent.lastAdvice;
    if (a.why === 'plan' && agent.toolsSinceAdvice <= 2) { agent.advisorWhy.plan--; agent.advisorWhy.done++; a.why = 'done'; }
    agent.lastAdvice = null;
  }
}

// ───────────────────────── 파일 읽기 ─────────────────────────

const SKIP_PREFIX = Buffer.from('{"type":"api-request'); // 요청 원문 사본 — 매우 크고 여기선 필요 없음

/** 파일에서 지난번 이후 새로 추가된 줄만 읽어 반영. 끝이 덜 써진 줄은 다음 번에 다시 읽음. */
async function readNew(file, entry, size) {
  if (size < entry.offset) { entry.offset = 0; resetAgent(entry.agent); } // 파일이 잘린 경우: 집계를 비우고 처음부터
  if (size === entry.offset) return false;
  let carry = Buffer.alloc(0);
  let consumed = 0;
  const stream = fs.createReadStream(file, { start: entry.offset, end: size - 1, highWaterMark: 1 << 20 });
  for await (const chunk of stream) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0, nl;
    while ((nl = buf.indexOf(10, start)) !== -1) {
      const line = buf.subarray(start, nl);
      start = nl + 1;
      if (line.length < 2 || line.subarray(0, SKIP_PREFIX.length).equals(SKIP_PREFIX)) continue;
      let o;
      try { o = JSON.parse(line.toString('utf8')); } catch { continue; }
      try { applyRecord(entry.agent, entry.session, o); } catch (e) { /* 모르는 형식의 줄은 건너뜀 */ }
    }
    consumed += start; // buf 는 '지금까지 소비한 위치'에서 시작하므로 start 만큼 전진
    carry = buf.subarray(start);
  }
  // carry 에 남은 것은 아직 줄바꿈이 안 온 미완성 줄 → 위치를 거기까지만 전진
  entry.offset += consumed;
  return consumed > 0;
}

async function safeReaddir(dir) {
  try { return await fsp.readdir(dir, { withFileTypes: true }); } catch { return []; }
}
async function safeStat(p) { try { return await fsp.stat(p); } catch { return null; } }

async function scanOnce() {
  const now = Date.now();
  let changed = false;
  const alive = new Set();

  const WINDOW_MS = cfg.windowMs;
  for (const proj of await safeReaddir(cfg.root)) {
    if (!proj.isDirectory()) continue;
    const projPath = path.join(cfg.root, proj.name);
    for (const ent of await safeReaddir(projPath)) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(projPath, ent.name);
      const st = await safeStat(file);
      if (!st) continue;
      const id = ent.name.slice(0, -6);
      const subDir = path.join(projPath, id, 'subagents');

      // 이미 추적 중인 세션은 메인 기록이 오래돼도 하위 에이전트가 최근에 움직였으면 계속 추적.
      // (추적한 적 없는 오래된 세션의 하위 폴더까지는 뒤지지 않음 — 수천 개 폴더를 2초마다 훑지 않기 위해)
      let session = sessions.get(id);
      let recent = now - st.mtimeMs < WINDOW_MS;
      const subFiles = [];
      if (recent || session) {
        for (const s of await safeReaddir(subDir)) {
          if (!s.isFile() || !s.name.startsWith('agent-') || !s.name.endsWith('.jsonl')) continue;
          const sst = await safeStat(path.join(subDir, s.name));
          if (sst) { subFiles.push({ name: s.name, st: sst }); if (now - sst.mtimeMs < WINDOW_MS) recent = true; }
        }
      }
      if (!recent) continue;
      alive.add(id);

      if (!session) { session = newSession(id, proj.name); sessions.set(id, session); changed = true; }
      session.mtimeMs = st.mtimeMs;
      let entry = files.get(file);
      if (!entry) { entry = { offset: 0, agent: session, session }; files.set(file, entry); }
      if (await readNew(file, entry, st.size)) changed = true;

      for (const { name, st: sst } of subFiles) {
        const agentId = name.slice(6, -6);
        const sfile = path.join(subDir, name);
        let sub = session.subagents.get(agentId);
        if (!sub) {
          sub = newAgent({ id: agentId, agentType: null, description: null, finished: false, toolUseId: null });
          session.subagents.set(agentId, sub);
          changed = true;
        }
        sub.mtimeMs = sst.mtimeMs;
        let sentry = files.get(sfile);
        if (!sentry) { sentry = { offset: 0, agent: sub, session }; files.set(sfile, sentry); }
        const grew = await readNew(sfile, sentry, sst.size);
        if (grew) changed = true;
        // 메타 파일: 끝났는지 여부가 바뀌므로, 아직 안 끝난 에이전트만 다시 읽음
        if (!sub.finished || grew || sub.agentType === null) {
          try {
            const meta = JSON.parse(await fsp.readFile(sfile.slice(0, -6) + '.meta.json', 'utf8'));
            if (sub.finished !== !!meta.finished) changed = true;
            sub.agentType = meta.agentType || sub.agentType || '';   // '' = 메타는 읽었지만 종류가 없음 (화면이 '에이전트'로 표시)
            sub.description = meta.description || sub.description;
            sub.finished = !!meta.finished;
            sub.toolUseId = meta.toolUseId || null;
          } catch { sub.agentType ??= ''; }
        }
      }
    }
  }

  // 추적 범위를 벗어난 세션 정리
  for (const [id, s] of sessions) {
    if (alive.has(id)) continue;
    sessions.delete(id);
    for (const [f, e] of files) if (e.session === s) files.delete(f);
    changed = true;
  }
  return changed;
}

// ───────────────────────── 화면에 보낼 모양으로 정리 ─────────────────────────

function lastActivity(s) {
  let t = Math.max(s.mtimeMs || 0, s.lastTs || 0);
  for (const a of s.subagents.values()) t = Math.max(t, a.mtimeMs || 0, a.lastTs || 0);
  return t;
}

/** 상태는 기록에 직접 적혀 있지 않아 '마지막 활동 시각'으로 추정한 값 */
function sessionStatus(s, now) {
  const idle = now - lastActivity(s);
  if (idle < 15_000) return 'working';
  if (s.lastStop !== 'end_turn' && idle < 180_000) return 'working';
  for (const a of s.subagents.values()) if (subStatus(a, now) === 'running') return 'working';
  // 결과가 아직 안 온 도구가 있으면 긴 명령을 기다리는 중으로 봄 (세션이 강제 종료된 경우를 위해 30분 상한)
  if (s.pending.size > 0 && idle < 30 * 60_000) return 'working';
  if (idle < 30 * 60_000) return 'waiting';
  return 'idle';
}
function subStatus(a, now) {
  if (a.finished) return 'done';
  return now - Math.max(a.mtimeMs || 0, a.lastTs || 0) < 180_000 ? 'running' : 'stalled';
}

function projectLabel(s) {
  if (s.cwd) return s.cwd.replace(os.homedir(), '~');
  return s.projectDir;
}

function summary(s, now) {
  const subs = [...s.subagents.values()];
  return {
    id: s.id, title: s.title || s.agentName || s.aiTitle || null, project: projectLabel(s),
    status: sessionStatus(s, now), lastActivity: lastActivity(s),
    model: s.model, toolCalls: s.toolCalls, errors: s.errors,
    subagents: subs.length, subagentsRunning: subs.filter((a) => subStatus(a, now) === 'running').length,
    tokens: s.usage.input + s.usage.output + s.usage.cacheCreate
      + subs.reduce((n, a) => n + a.usage.input + a.usage.output + a.usage.cacheCreate, 0),
  };
}

function detail(s, now) {
  const subs = [...s.subagents.values()].sort((a, b) => (b.firstTs || 0) - (a.firstTs || 0));
  const medians = typeMedians();
  const events = [];
  for (const e of s.events) events.push({ ...e, actor: 'main' });
  for (const a of subs) for (const e of a.events) events.push({ ...e, actor: a.agentType || '', sub: a.id });
  events.sort((x, y) => (x.ts || 0) - (y.ts || 0));

  const tools = { ...s.tools };
  for (const a of subs) for (const [k, v] of Object.entries(a.tools)) tools[k] = (tools[k] || 0) + v;

  return {
    ...summary(s, now),
    gitBranch: s.gitBranch, effort: s.effort, turns: s.turns, compactions: s.compactions,
    usage: s.usage, context: s.context, cost: s.cost, firstTs: s.firstTs,
    pending: [...s.pending.values()].slice(-5),
    advisor: advisorInfo(s, subs), lastMainText: s.lastText,
    tools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 10),
    signals: signals(s), signalWindow: s.recent.length,
    recentMain: s.recent.map((x) => ({ name: x.name, ts: x.ts })),   // 메인 세션만의 최근 도구 호출 (하위 에이전트 로그에 밀리지 않게 따로 전달)
    toolCallsAll: s.toolCalls + subs.reduce((n, a) => n + a.toolCalls, 0),
    subagentList: subs.slice(0, 60).map((a) => ({
      id: a.id, type: a.agentType, description: a.description, model: a.model,
      status: subStatus(a, now), ...progressOf(a, subStatus(a, now), medians), toolCalls: a.toolCalls, errors: a.errors,
      tokens: a.usage.input + a.usage.output + a.usage.cacheCreate,
      firstTs: a.firstTs, lastTs: a.lastTs, lastAction: a.lastAction,
    })),
    events: events.slice(-200),
  };
}

/**
 * 판단 층의 막대에 넣는 지표. 기록에는 모델의 확신도가 없으므로,
 * 최근 도구 호출 RECENT_N 건에서 '얼마나 한 방향으로 진행 중인가'를 0~1 로 계산한 대용값이다.
 *  - 어느 파일: 파일을 다룬 호출 중 가장 많이 다룬 파일의 비율
 *  - 어느 도구: 가장 많이 쓴 도구의 비율
 *  - 오류 없이 진행: 오류 없이 끝난 호출의 비율
 */
function signals(agent) {
  const r = agent.recent;
  if (!r.length) return [];
  const top = (keys) => {
    const c = new Map();
    for (const k of keys) c.set(k, (c.get(k) || 0) + 1);
    let best = null, n = 0;
    for (const [k, v] of c) if (v > n) { best = k; n = v; }
    return { pick: best, value: keys.length >= MIN_SIGNAL_N ? n / keys.length : null, n: keys.length };
  };
  const files = top(r.filter((x) => x.file).map((x) => x.file));
  // 작업 목록 갱신·마무리 같은 기록용 호출은 '무엇을 하는가'와 무관하므로 제외 (화면의 '주로 하는 일'과 같은 기준)
  const tools = top(r.filter((x) => !BOOKKEEPING.test(x.name)).map((x) => x.name));
  const errs = r.filter((x) => x.err).length;
  return [
    // 이름표는 화면이 key 로 붙인다 (file = 어느 파일, tool = 어느 도구, ok = 오류 없이 진행)
    { key: 'file', ...files },
    { key: 'tool', ...tools },
    { key: 'ok', value: r.length >= MIN_SIGNAL_N ? (r.length - errs) / r.length : null, n: r.length, pick: null, errs },
  ];
}

/**
 * 하위 에이전트 진행률. 기록에는 '전체 작업량'이 없어 실제 진행률을 알 수 없으므로,
 * 같은 종류(agentType)의 에이전트가 끝날 때까지 보통 쓴 도구 호출 수(중앙값)와 견주어 추정한다.
 */
function typeMedians() {
  const byType = new Map();
  for (const s of sessions.values()) for (const a of s.subagents.values()) {
    if (!a.finished || a.agentType == null) continue;
    if (!byType.has(a.agentType)) byType.set(a.agentType, []);
    byType.get(a.agentType).push(a.toolCalls);
  }
  const out = new Map();
  for (const [type, arr] of byType) {
    arr.sort((x, y) => x - y);
    const mid = arr.length >> 1;
    out.set(type, { n: arr.length, median: arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2 });
  }
  return out;
}
function progressOf(a, status, medians) {
  if (status === 'done') return { progress: 100, est: false };
  const m = medians.get(a.agentType);
  if (!m || m.n < 2 || m.median <= 0) return { progress: null };   // 견줄 기록이 부족하면 추정하지 않음
  // 끝나지 않았으므로 95% 를 넘기지 않는다
  return { progress: Math.max(3, Math.min(95, Math.round(a.toolCalls / m.median * 100))), est: true, basisN: m.n, basisMedian: m.median };
}

/** 메인과 하위 에이전트의 자문을 합쳐 시각순으로 정리 */
function advisorInfo(s, subs) {
  const all = [s, ...subs];
  const times = all.flatMap((a) => a.advisorTimes).sort((a, b) => a.ts - b.ts);
  const last = times[times.length - 1];
  const why = { plan: 0, error: 0, done: 0 };
  for (const a of all) for (const k of Object.keys(why)) why[k] += a.advisorWhy[k];
  return {
    model: s.advisorModel || subs.map((a) => a.advisorModel).find(Boolean) || null,
    calls: all.reduce((n, a) => n + a.advisorCalls, 0),
    lastTs: last ? last.ts : null, lastWhy: last ? last.why : null,
    why, times: times.slice(-6),
  };
}

function snapshot() {
  const now = Date.now();
  const list = [...sessions.values()].map((s) => summary(s, now)).sort((a, b) => b.lastActivity - a.lastActivity);
  return { now, loading: !initialLoadDone, version, windowHours: cfg.windowMs / 3600_000, sessions: list };
}

// ───────────────────────── 주기적 읽기 + 웹 서버 ─────────────────────────

const clients = new Set();
function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(data);
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const changed = await scanOnce();
    if (!initialLoadDone) { initialLoadDone = true; console.log(say(`[watchtower] Initial read done: ${sessions.size} session(s)`, `[워치타워] 첫 읽기 완료: 세션 ${sessions.size}개`)); }
    if (changed) version++;
    broadcast(); // 바뀐 게 없어도 '몇 초 전' 표시와 상태 추정이 갱신되도록 주기적으로 보냄
  } catch (e) {
    console.error(say('[watchtower] Read error:', '[워치타워] 읽기 오류:'), e.message);
  } finally { ticking = false; }
}

// 다른 웹사이트가 이 서버를 몰래 읽지 못하게: 주소창에 localhost/127.0.0.1 로 직접 연 요청만 허용 (포트가 정해진 뒤 채움)
let allowedHosts = new Set();

function send(res, code, type, body) {
  res.writeHead(code, {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(body);
}

async function handle(req, res) {
  if (!allowedHosts.has(req.headers.host || '')) return send(res, 403, 'text/plain; charset=utf-8', 'Host not allowed.');
  // 다른 사이트에서 보낸 요청(브라우저가 표시해 줌)은 거절
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return send(res, 403, 'text/plain; charset=utf-8', 'Cross-site requests are not allowed.');
  if (req.method !== 'GET') return send(res, 405, 'text/plain; charset=utf-8', 'Only GET is supported.');

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/') {
    try { return send(res, 200, 'text/html; charset=utf-8', await fsp.readFile(path.join(HERE, 'index.html'))); }
    catch { return send(res, 500, 'text/plain; charset=utf-8', 'index.html not found.'); }
  }
  if (url.pathname === '/api/sessions') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(snapshot()));
  if (url.pathname === '/api/session') {
    const s = sessions.get(url.searchParams.get('id') || '');
    if (!s) return send(res, 404, 'application/json; charset=utf-8', '{"error":"session not found"}');
    return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(detail(s, Date.now())));
  }
  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    res.on('close', () => clients.delete(res));
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
}

// ───────────────────────── 실행 ─────────────────────────

const HELP = () => say(
`Agent Watchtower — a local, read-only dashboard for Claude Code sessions on this machine.

Usage: agent-watchtower [options]
       agent-watchtower setup [--yes]   Add the review pipeline (advisor, critic/scout subagents) to Claude Code

  -p, --port <n>     Port to listen on (default ${DEFAULT_PORT}; the next free port is used if it is taken)
      --hours <n>    Track sessions active within the last n hours (default 24)
      --dir <path>   Transcript folder (default: <Claude config dir>/projects)
      --open         Open the dashboard in the browser
      --no-open      Do not open the browser
  -v, --version      Print the version
  -h, --help         Show this help

Environment: AGENT_WATCHTOWER_PORT, WINDOW_HOURS, CLAUDE_PROJECTS_DIR, CLAUDE_CONFIG_DIR
The server listens on 127.0.0.1 only and never sends anything off this machine.`,
`에이전트 워치타워 — 이 컴퓨터의 Claude Code 세션을 읽기 전용으로 보여주는 로컬 대시보드.

사용법: agent-watchtower [옵션]
        agent-watchtower setup [--yes]   검토 파이프라인(조언자, critic·scout 서브에이전트)을 Claude Code 에 추가

  -p, --port <n>     사용할 포트 (기본 ${DEFAULT_PORT}; 이미 쓰이고 있으면 다음 빈 포트)
      --hours <n>    최근 n시간 안에 활동한 세션만 추적 (기본 24)
      --dir <경로>   기록 폴더 (기본: <Claude 설정 폴더>/projects)
      --open         브라우저에서 화면 열기
      --no-open      브라우저를 열지 않음
  -v, --version      버전 출력
  -h, --help         이 도움말

환경 변수: AGENT_WATCHTOWER_PORT, WINDOW_HOURS, CLAUDE_PROJECTS_DIR, CLAUDE_CONFIG_DIR
서버는 127.0.0.1 에서만 열리고, 이 컴퓨터 밖으로 아무것도 보내지 않습니다.`);

/** 명령줄 옵션 읽기. 잘못된 옵션이면 { error } 를 돌려준다. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const val = () => (v !== undefined ? v : argv[++i]);
    switch (a) {
      case '-h': case '--help': out.help = true; break;
      case '-v': case '--version': out.version = true; break;
      case '--open': out.open = true; break;
      case '--no-open': out.open = false; break;
      case '-p': case '--port': {
        const n = Number(val());
        if (!Number.isInteger(n) || n < 1 || n > 65535) return { error: say('--port needs a number between 1 and 65535.', '--port 에는 1~65535 사이의 숫자가 필요합니다.') };
        out.port = n; break;
      }
      case '--hours': {
        const n = Number(val());
        if (!(n > 0)) return { error: say('--hours needs a number greater than 0.', '--hours 에는 0보다 큰 숫자가 필요합니다.') };
        out.hours = n; break;
      }
      case '--dir': {
        const d = val();
        if (!d) return { error: say('--dir needs a path.', '--dir 에는 경로가 필요합니다.') };
        out.dir = d; break;
      }
      default: return { error: say(`Unknown option: ${a}`, `모르는 옵션: ${a}`) };
    }
  }
  return out;
}

/** 기록 폴더 위치: --dir > CLAUDE_PROJECTS_DIR > CLAUDE_CONFIG_DIR/projects > ~/.claude/projects */
export function resolveRoot(dir, env = process.env, home = os.homedir()) {
  if (dir) return path.resolve(dir);
  if (env.CLAUDE_PROJECTS_DIR) return env.CLAUDE_PROJECTS_DIR;
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});   // 브라우저를 못 열어도 서버는 계속 돈다 (주소는 이미 터미널에 찍혀 있음)
    child.unref();
  } catch { /* 위와 같음 */ }
}

/**
 * 그 포트에 이미 에이전트 워치타워가 떠 있는지 확인한다. 같은 컴퓨터의 다른 프로그램을 워치타워로 착각하지 않도록
 * 응답 모양(sessions 배열과 windowHours)까지 본다. 아무도 없거나 다른 프로그램이면 false.
 */
function probeWatchtower(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/sessions', headers: { Host: `127.0.0.1:${port}` }, timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; if (body.length > 4e6) req.destroy(); });
      res.on('end', () => { try { const j = JSON.parse(body); resolve(Array.isArray(j.sessions) && typeof j.windowHours === 'number'); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** 포트를 연다. 포트를 직접 정한 경우(fixed)에는 겹치면 실패하고, 아니면 다음 번호를 차례로 시도한다. */
function listen(server, port, fixed) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    // 시도마다 두 대기 콜백을 붙였다가, 한쪽이 불리면 다른 쪽을 떼어 낸다.
    // (listen(p, cb) 로 붙이면 실패한 시도의 cb 가 남아 있다가 다음 포트가 열릴 때 함께 불려, 엉뚱한 포트 번호로 resolve 된다)
    const attempt = (p) => {
      const onError = (e) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' && !fixed && tries++ < PORT_TRIES && p < 65535) return attempt(p + 1);
        reject(e);
      };
      const onListening = () => { server.off('error', onError); resolve(server.address().port); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, '127.0.0.1');
    };
    attempt(port);
  });
}

export async function main(argv = [], { openDefault = false } = {}) {
  if (argv[0] === 'setup') {
    const { runSetup, defaultConfigDir } = await import('./setup.mjs');
    runSetup(argv.slice(1), { say, ko: KO, resolveConfigDir: defaultConfigDir });
    return;
  }
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error + '\n\n' + HELP()); process.exit(2); }
  if (args.help) { console.log(HELP()); return; }
  if (args.version) {
    const pkg = JSON.parse(await fsp.readFile(path.join(HERE, 'package.json'), 'utf8'));
    console.log(pkg.version); return;
  }
  // PORT 는 다른 개발 서버들이 셸 전체에 걸어 두는 경우가 많아, 워치타워 전용 이름만 따른다
  const envPort = Number(process.env.AGENT_WATCHTOWER_PORT) || 0;
  const wanted = args.port || envPort || DEFAULT_PORT;
  const fixed = !!(args.port || envPort);
  cfg.root = resolveRoot(args.dir);
  cfg.windowMs = (args.hours || Number(process.env.WINDOW_HOURS) || 24) * 3600_000;

  // 이미 떠 있으면 두 번째 서버를 띄우지 않고 그 주소를 알려 준다 (플러그인 명령을 두 번 불러도 하나만 돌게)
  if (await probeWatchtower(wanted)) {
    const url = `http://127.0.0.1:${wanted}`;
    console.log(say(`[watchtower] Already running at ${url}`, `[워치타워] 이미 ${url} 에서 실행 중입니다.`));
    if (args.open ?? openDefault) openBrowser(url);
    return;
  }
  const server = http.createServer(handle);
  try { cfg.port = await listen(server, wanted, fixed); }
  catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(say(`[watchtower] Port ${wanted} is used by another program (not Agent Watchtower).`, `[워치타워] ${wanted} 포트를 다른 프로그램(에이전트 워치타워 아님)이 쓰고 있습니다.`));
      console.error(say('[watchtower] Pick another port with --port, or leave it out to use the next free one.', '[워치타워] --port 로 다른 포트를 고르거나, 빼고 실행하면 다음 빈 포트를 씁니다.'));
    } else console.error(say('[watchtower] Server error:', '[워치타워] 서버 오류:'), e.message);
    process.exit(1);
  }
  server.on('error', (e) => console.error(say('[watchtower] Server error:', '[워치타워] 서버 오류:'), e.message));
  allowedHosts = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`]);

  // 'localhost' 는 IPv6(::1)로 먼저 갈 수 있고, 그 포트를 IPv6 에서 다른 프로그램이 쓰고 있으면 그쪽이 열린다.
  // 그래서 실제로 연 주소(127.0.0.1)를 그대로 안내하고 연다.
  const url = `http://127.0.0.1:${cfg.port}`;
  const hours = cfg.windowMs / 3600_000;
  if (cfg.port !== wanted) console.log(say(`[watchtower] Port ${wanted} is in use, so using ${cfg.port} instead.`, `[워치타워] ${wanted} 포트가 쓰이고 있어 ${cfg.port} 포트를 씁니다.`));
  console.log(say(`[watchtower] Running at ${url}`, `[워치타워] ${url} 에서 실행 중`));
  console.log(say(`[watchtower] Reading ${cfg.root} (sessions changed in the last ${hours}h)`, `[워치타워] 읽는 폴더: ${cfg.root} (최근 ${hours}시간 안에 바뀐 세션)`));
  if (!fs.existsSync(cfg.root)) console.log(say(
    '[watchtower] That folder does not exist yet. Sessions will appear once Claude Code writes a transcript there. If your config lives elsewhere, set CLAUDE_CONFIG_DIR or pass --dir.',
    '[워치타워] 그 폴더가 아직 없습니다. Claude Code 가 기록을 남기면 세션이 나타납니다. 설정 폴더가 다른 곳이면 CLAUDE_CONFIG_DIR 을 지정하거나 --dir 로 알려 주세요.'));
  if (args.open ?? openDefault) openBrowser(url);
  tick();
  setInterval(tick, SCAN_MS);
}

// 계산 규칙 자동 테스트에서 쓰는 것들
export { listen, sessions, newAgent, newSession, applyRecord, readNew, sessionStatus, subStatus, signals, typeMedians, progressOf, advisorInfo, summary, detail };

// `node server.mjs` 로 직접 띄운 경우 (브라우저는 열지 않음). 설치형 명령은 bin/agent-watchtower.mjs 가 main() 을 부른다.
const isMain = (() => { try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) main(process.argv.slice(2));
