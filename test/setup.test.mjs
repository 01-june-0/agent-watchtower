// `agent-watchtower setup` 테스트: 임시 설정 폴더에서만 돈다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSetup, applySetup } from '../setup.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-watchtower-setup-'));

test('빈 설정 폴더: 에이전트 2개, 규칙, advisorModel 을 추가하고 두 번째에는 바꿀 것이 없다', () => {
  const dir = tmp();
  try {
    const steps = planSetup({ configDir: dir, lang: 'en' });
    assert.deepEqual(steps.map((s) => s.kind), ['write', 'write', 'write', 'write']);
    applySetup(steps);
    assert.match(fs.readFileSync(path.join(dir, 'agents', 'critic.md'), 'utf8'), /name: critic/);
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /`critic` subagent/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).advisorModel, 'opus');
    assert.deepEqual(planSetup({ configDir: dir, lang: 'en' }).map((s) => s.kind), ['same', 'same', 'same', 'same']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('이미 있는 것은 덮어쓰지 않고, settings.json 은 다른 값을 지키며 백업한다', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'agents'));
    fs.writeFileSync(path.join(dir, 'agents', 'critic.md'), 'my own critic');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '- my rule\n');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'sonnet', permissions: { allow: ['Read'] } }));
    const steps = planSetup({ configDir: dir, lang: 'ko' });
    assert.equal(steps[0].kind, 'conflict');
    applySetup(steps, new Date('2026-11-13T00:00:00Z'));
    assert.equal(fs.readFileSync(path.join(dir, 'agents', 'critic.md'), 'utf8'), 'my own critic');
    const md = fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(md.startsWith('- my rule\n\n'), '기존 내용 뒤에 붙임');
    assert.match(md, /critic/);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(s, { model: 'sonnet', permissions: { allow: ['Read'] }, advisorModel: 'opus' });
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.json.bak-agent-watchtower-')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('이미 정해 둔 advisorModel 은 그대로 두고, 깨진 settings.json 은 손대지 않는다', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ advisorModel: 'sonnet' }));
    assert.equal(planSetup({ configDir: dir }).at(-1).kind, 'same');
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ broken');
    const steps = planSetup({ configDir: dir });
    assert.equal(steps.at(-1).kind, 'conflict');
    applySetup(steps);
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), '{ broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('객체가 아닌 settings.json, 비어 있는 advisorModel, 무관한 critic 언급, 끊어진 링크', () => {
  const dir = tmp();
  try {
    for (const bad of ['[1,2]', '"abc"', '42', 'null']) {
      fs.writeFileSync(path.join(dir, 'settings.json'), bad);
      const steps = planSetup({ configDir: dir });
      assert.equal(steps.at(-1).kind, 'conflict', bad);
      applySetup(steps);
      assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), bad);
    }
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"advisorModel":""}');
    assert.equal(planSetup({ configDir: dir }).at(-1).kind, 'same', '빈 값도 사용자가 정한 값');

    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'Never rename the `critic` column\n');
    assert.equal(planSetup({ configDir: dir }).find((s) => s.what === 'rule').kind, 'write');

    fs.rmSync(path.join(dir, 'agents'), { recursive: true, force: true });   // 앞 단계에서 만든 파일을 비움
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'nowhere', 'x.md'), path.join(dir, 'agents', 'critic.md'));
    const steps = planSetup({ configDir: dir });
    assert.equal(steps[0].kind, 'conflict', '끊어진 링크는 따라가지 않음');
    applySetup(steps);
    assert.equal(fs.existsSync(path.join(dir, 'nowhere')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
