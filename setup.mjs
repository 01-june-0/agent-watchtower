// `agent-watchtower setup` — 개발/검토 파이프라인(조언자 + critic·scout 서브에이전트 + critic 규칙)을 Claude Code 설정에 넣는다.
// 대시보드 자체는 읽기 전용이고, 설정을 쓰는 것은 사용자가 이 명령을 --yes 로 실행했을 때뿐이다.
//  - 먼저 무엇을 바꿀지 보여 주고, --yes 가 있을 때만 쓴다.
//  - 이미 있는 것은 덮어쓰지 않는다 (같은 이름의 다른 에이전트 파일, 이미 정해 둔 advisorModel).
//  - settings.json 을 고치기 전에 옆에 백업을 남긴다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARK_BEGIN = '<!-- agent-watchtower:review-pipeline:begin -->';
const MARK_END = '<!-- agent-watchtower:review-pipeline:end -->';

/** 설치 계획을 세운다. 파일은 건드리지 않는다. */
export function planSetup({ configDir, lang = 'en', advisorModel = 'opus' }) {
  const src = path.join(HERE, 'setup', lang === 'ko' ? 'ko' : 'en');
  const steps = [];

  for (const name of ['critic.md', 'scout.md']) {
    const dest = path.join(configDir, 'agents', name);
    const content = fs.readFileSync(path.join(src, name), 'utf8');
    // lstat: 끊어진 심볼릭 링크도 '있음'으로 본다 (링크를 따라가 설정 폴더 밖에 파일을 만들지 않게)
    let exists = true;
    try { fs.lstatSync(dest); } catch { exists = false; }
    let same = false;
    if (exists) { try { same = fs.readFileSync(dest, 'utf8') === content; } catch { same = false; } }
    steps.push({ kind: !exists ? 'write' : same ? 'same' : 'conflict', file: dest, content, what: 'agent', newFile: true });
  }

  const md = path.join(configDir, 'CLAUDE.md');
  const rule = fs.readFileSync(path.join(src, 'CLAUDE.md'), 'utf8').trimEnd();
  const cur = fs.existsSync(md) ? fs.readFileSync(md, 'utf8') : '';
  // 이 명령이 넣은 표시만 '이미 있음'으로 본다. 손으로 쓴 규칙인지는 알 수 없으니 표시가 없으면 추가한다
  if (cur.includes(MARK_BEGIN)) steps.push({ kind: 'same', file: md, what: 'rule' });
  else steps.push({ kind: 'write', file: md, content: (cur ? cur.replace(/\n*$/, '\n\n') : '') + `${MARK_BEGIN}\n${rule}\n${MARK_END}\n`, what: 'rule' });

  const sj = path.join(configDir, 'settings.json');
  let settings = {};
  if (fs.existsSync(sj)) {
    try { settings = JSON.parse(fs.readFileSync(sj, 'utf8')); } catch { settings = undefined; }
    // JSON 이어도 객체가 아니면(배열·문자열·null 등) 손대지 않는다
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      steps.push({ kind: 'conflict', file: sj, what: 'settings-unreadable' }); return steps;
    }
  }
  if (Object.hasOwn(settings, 'advisorModel')) steps.push({ kind: 'same', file: sj, what: 'advisor', value: settings.advisorModel });
  else steps.push({ kind: 'write', file: sj, content: JSON.stringify({ ...settings, advisorModel }, null, 2) + '\n', what: 'advisor', value: advisorModel, backup: fs.existsSync(sj) });
  return steps;
}

/**
 * 계획대로 쓴다. 'write' 단계만 실행하고, 단계마다 결과를 s.done / s.error 에 남긴다 (한 단계가 실패해도 나머지는 계속).
 * 새 에이전트 파일은 'wx' 로 만들어, 계획과 쓰기 사이에 생긴 파일을 덮어쓰지 않는다.
 */
export function applySetup(steps, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  for (const s of steps) {
    if (s.kind !== 'write') continue;
    try {
      fs.mkdirSync(path.dirname(s.file), { recursive: true });
      if (s.backup) fs.copyFileSync(s.file, `${s.file}.bak-agent-watchtower-${stamp}`);
      fs.writeFileSync(s.file, s.content, s.newFile ? { flag: 'wx' } : undefined);
      s.done = true;
    } catch (e) {
      if (e.code === 'EEXIST') s.kind = 'conflict';
      else s.error = e.message;
    }
  }
}

export function runSetup(argv, { say, ko, resolveConfigDir }) {
  const yes = argv.includes('--yes') || argv.includes('-y');
  const lang = argv.includes('--lang=ko') ? 'ko' : argv.includes('--lang=en') ? 'en' : ko ? 'ko' : 'en';
  const configDir = resolveConfigDir();
  const steps = planSetup({ configDir, lang });
  const label = {
    agent: (f) => say(`subagent ${path.basename(f, '.md')}`, `서브에이전트 ${path.basename(f, '.md')}`),
    rule: () => say('global rule: review with critic before reporting done', '전역 규칙: 완료 보고 전에 critic 으로 검토'),
    advisor: (f, v) => say(`advisorModel = "${v}"`, `advisorModel = "${v}"`),
    'settings-unreadable': () => say('settings.json (not valid JSON — left alone)', 'settings.json (JSON 이 아니라 손대지 않음)'),
  };
  const mark = { write: yes ? say('wrote   ', '씀      ') : say('will add', '추가 예정'), same: say('already ', '이미 있음'), conflict: say('skipped ', '건너뜀  '), failed: say('FAILED  ', '실패    ') };
  console.log(say(`Claude Code config folder: ${configDir}\n`, `Claude Code 설정 폴더: ${configDir}\n`));
  if (yes) applySetup(steps);
  for (const s of steps) {
    let line = `  ${mark[s.error ? 'failed' : s.kind]}  ${label[s.what](s.file, s.value)}`;
    if (s.error) line += ` — ${s.error}`;
    if (s.kind === 'same' && s.what === 'advisor') line += say(' (kept your value)', ' (기존 값 유지)');
    if (s.kind === 'conflict' && s.what === 'agent') line += say(` — a different ${path.basename(s.file)} already exists; compare it with setup/ in this package`, ` — 내용이 다른 ${path.basename(s.file)} 가 이미 있음. 이 패키지의 setup/ 과 비교해 보세요`);
    console.log(line + `\n      ${s.file}`);
  }
  const n = steps.filter((s) => s.kind === 'write').length;
  const skipped = steps.filter((s) => s.kind === 'conflict').length;
  const failed = steps.filter((s) => s.error).length;
  const skipNote = skipped ? say(` ${skipped} item(s) were skipped and need a look by hand (see above).`, ` ${skipped}건은 건너뛰었으니 위 내용을 보고 직접 확인하세요.`) : '';
  if (!yes) {
    console.log('\n' + (n
      ? say(`Nothing was changed. Run again with --yes to apply ${n} change(s). settings.json is backed up first.`, `아무것도 바꾸지 않았습니다. 적용하려면 --yes 를 붙여 다시 실행하세요 (${n}건). settings.json 은 먼저 백업합니다.`)
      : skipped ? say('Nothing to add automatically.', '자동으로 추가할 것이 없습니다.') : say('Everything is already in place.', '이미 모두 설정되어 있습니다.')) + skipNote);
  } else if (failed) {
    console.log('\n' + say(`${failed} step(s) failed; the lines above show what was written.`, `${failed}건이 실패했습니다. 위 목록에서 실제로 쓴 것을 확인하세요.`) + skipNote);
    process.exitCode = 1;
  } else console.log('\n' + say('Done. Restart Claude Code (or open a new session) to pick up the changes.', '완료. Claude Code 를 다시 시작하거나 새 세션을 열면 적용됩니다.') + skipNote);
  return steps;
}

export const defaultConfigDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
