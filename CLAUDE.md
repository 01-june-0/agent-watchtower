# 에이전트 워치타워

이 컴퓨터의 Claude Code 세션을 지켜보는 로컬 웹 대시보드. 세션 기록 파일을 읽기만 해서
메인 세션·하위 에이전트·조언자의 상태와 도구 사용을 터미널 느낌의 흐름도로 보여준다.

- 원칙: 기록에 없는 값은 만들어 넣지 않는다. 추정하는 값은 추정이라고 밝힌다.

공개 배포했다: npm 패키지 `agent-watchtower`(0.1.1, 계정 dev.june) + GitHub `01-june-0/agent-watchtower` + Claude Code 플러그인. 화면은 영어 기본 + 한국어.

## 실행

```bash
node server.mjs                 # 개발용: 브라우저를 열지 않음. http://localhost:4477
node bin/agent-watchtower.mjs      # 설치형 명령과 같음: 브라우저를 엶. 4477이 쓰이면 다음 빈 포트
node server.mjs --port 4488     # 포트를 직접 정하면 겹칠 때 옮기지 않고 끝남. 같은 포트에 워치타워가 이미 있으면 그 주소만 알리고 끝남
npm test                        # 계산 규칙 자동 테스트 (node --test, test/rules.test.mjs)
```

- Claude 미리보기: `.claude/launch.json` 의 `agent-watchtower` (이 폴더에서 세션을 열었을 때).
- `server.mjs` 를 고치면 서버를 다시 띄워야 한다. `index.html` 은 요청마다 새로 읽으므로 새로고침만 하면 된다.
- 옵션: `--port`, `--hours`, `--dir`, `--open`/`--no-open`, `--help`, `--version`.
- 환경 변수: `AGENT_WATCHTOWER_PORT`(기본 4477. 다른 개발 서버의 `PORT` 와 겹치지 않게 전용 이름), `WINDOW_HOURS`(기본 24), `CLAUDE_PROJECTS_DIR`, `CLAUDE_CONFIG_DIR`(기록 폴더 = `--dir` > `CLAUDE_PROJECTS_DIR` > `CLAUDE_CONFIG_DIR/projects` > `~/.claude/projects`).

## 구조

외부 패키지 없음. Node 22 이상(`engines`, Node 20은 2026-04 지원 종료). 깃 저장소가 아니다.

| 파일 | 역할 |
|---|---|
| `server.mjs` | 기록 파일(JSONL)을 2초마다 늘어난 만큼만 읽어 세션 상태를 메모리에 쌓고 `/`, `/api/sessions`, `/api/session?id=`, `/events`(SSE)로 내보냄. `main()`이 옵션을 읽고 서버를 띄움. 테스트용으로 계산 함수를 export |
| `index.html` | 단일 파일 화면(인라인 CSS·JS). SSE로 요약을 받고 선택한 세션의 상세를 가져와 그림. 문구는 `I18N`(en/ko) 사전에 있음 |
| `bin/agent-watchtower.mjs` | 설치형 명령 진입점. `main(argv, { openDefault: true })` |
| `setup.mjs`, `setup/{en,ko}/` | `agent-watchtower setup [--yes]`: 조언자(`advisorModel`)·critic/scout 서브에이전트·critic 규칙을 사용자 설정에 추가. `--yes` 없으면 보여 주기만 함. 덮어쓰지 않고 settings.json 은 백업. `setup/ko/` 는 개발자 실제 설정과 글자 단위로 같다 |
| `docs/SETUP.md`, `docs/SETUP.ko.md` | 같은 화면을 보기 위한 설정 따라 하기 안내서 |
| `test/rules.test.mjs`, `test/setup.test.mjs` | 계산 규칙·기록 읽기·옵션·포트 자동 선택 / setup 명령 테스트 |
| `package.json`, `LICENSE`(MIT), `README.md`, `README.ko.md` | npm 배포용 |
| `.claude-plugin/`, `commands/start.md` | Claude Code 플러그인(`/agent-watchtower:start`)과 마켓플레이스 정의 |

서버 흐름: `scanOnce()` → `readNew()` → `applyRecord()`(`applyUser`/`applyAssistant`) → `summary()`/`detail()`.
화면 흐름: `onSnapshot()` → `renderList()` / `loadDetail()` → `renderDetail()` → `renderStatus()` → `renderHeader()`.

## 계산 규칙 (코드의 실제 값)

기록에 없어서 추정하는 값들이다. 화면에도 추정임을 적어 둔다. 자세한 설명은 PRD의 "데이터와 계산 규칙".

- 세션 상태(`sessionStatus`): 15초 안 활동 → 작업 중. 응답이 안 끝났고 3분 안 → 작업 중.
  하위 에이전트 실행 중이거나, 결과 대기 도구가 있고 30분 안 → 작업 중. 그 밖에 30분 안 → 입력 대기, 넘으면 휴면.
- 하위 에이전트 상태(`subStatus`): 메타 파일에 완료 → 완료. 아니면 3분 안 활동 → 실행 중, 넘으면 멈춘 듯.
- 판단 층(`signals`): 메인의 최근 도구 호출 20건(`RECENT_N`). 표본 5건(`MIN_SIGNAL_N`) 미만이면 판정하지 않음.
  화면 기준값 0.7(`SHARP`) 이상 또렷, 미만 갈림. '어느 도구'와 로그의 p는 기록용 호출(`BOOKKEEPING`)을 뺀다.
- 자문 시점: 직전 6건 중 오류 2건 이상 → error. 자문 뒤 도구 2건 이하로 응답 종료 → done. 그 요청에서 파일 수정 전 → plan.
- 진행률(`progressOf`): 같은 종류 완료 에이전트의 도구 호출 중앙값 대비. 완료 기록 2건 미만이면 추정 안 함. 실행 중은 3~95%.
- '최근 자문' 표시: 마지막 자문 뒤 90초.
- 로그: 세션당 이벤트 300건 기억, 화면에는 최근 200건.

## 이 프로젝트에서 지킬 것

- **추정값을 실제 값처럼 보이게 하지 않는다.** 화면에 추정임을 적고, 표본이 부족하면 값을 내지 않는다.
- **보안 유지**: 127.0.0.1 바인딩, Host 검사, 교차 사이트 요청 거절, GET만 허용, CSP. 화면에 프롬프트와 명령 요약이 나오기 때문이다.
- **기록 속 문자열은 글자로만 넣는다.** `h()` 도우미의 `text`/자식으로 넣고 `innerHTML` 은 쓰지 않는다.
- **`replaceChildren()` 에 배열이나 `null` 을 직접 넘기지 않는다.** `h()` 안에서는 풀어 주지만 `replaceChildren` 은 "[object …]"나 "null" 글자로 찍는다. 펼쳐서 넘긴다.
- **CSS 클래스 이름이 겹치지 않는지 먼저 찾아본다.** (`.bars` 를 다른 뜻으로 다시 써서 상자 테두리가 붙은 적이 있다.)
- **애니메이션은 주기 1초 또는 2초로 맞추고 `animation-delay: var(--t)` 를 붙인다.** 화면이 2초마다 다시 그려져도 끊기지 않게 하는 장치다.
- **서버는 언어에 묶인 문구를 보내지 않는다.** 서버가 만든 문구는 `code`(예: `compact`, `advice`)나 `key`(판단 층 `file`/`tool`/`ok`), `null`(제목 없음)로 보내고 화면이 `T.*`로 붙인다. 기록에서 온 글(프롬프트, 응답, 설명)만 그대로 보낸다. 테스트가 이를 검사한다.
- **새 문구는 `I18N.en`과 `I18N.ko`에 같이 넣는다.** 화면을 그리는 함수의 키(`listKey`/`detailKey`)에 `LANG`이 들어 있어 언어를 바꾸면 다시 그린다.
- **화면에 보이는 같은 수치는 같은 기준으로 센다.** 기준이 다르면 이름표로 구분한다(예: 전체 도구 수 vs `메인 도구 호출`).

## 고친 뒤 확인하는 방법

1. 브라우저 콘솔 오류 없음.
2. 폭 1320 / 1000 / 768 / 375px 에서 가로 넘침과 잘린 글자 없음. (1200px, 860px, 흐름도 안쪽 600px 에서 배치가 바뀐다.)
3. 하위 에이전트가 많은 세션, 없는 세션, 폴더 경로가 긴 세션, 조언자를 안 쓴 세션을 영어·한국어로 각각 선택해 본다.
   (Claude 미리보기 서버와 Bash로 띄운 서버는 서로의 포트를 못 보는 것 같다. 포트 겹침은 Bash에서 두 개를 띄워 시험한다.)
6. `npm test`.
4. 움직임 관련 변경이면 움직임 줄이기 설정을 켠 브라우저에서 실행 중인 애니메이션이 0개인지 본다(Playwright `emulate_media`).
5. 실행 중인 하위 에이전트가 없으면 `.branch.on`, `.box.sub.running`, `.wire.on`, `.mk.on` 클래스를 잠깐 붙여서 본다. 이 경우 "강제로 켜서 확인"이라고 보고한다.

## 현재 상태 (2026-11-13)

동작하는 시제품에 공개 배포 준비를 더했다: 실행 옵션, `CLAUDE_CONFIG_DIR`, 포트 자동 선택, 브라우저 자동 열기, 영어/한국어 화면, 조언자를 안 쓰는 세션은 조언자 패널 숨김, VS Code 세션 제목(`ai-title`), 이미 떠 있는 워치타워 감지, 검토 파이프라인 setup 명령과 안내서, 자동 테스트 23개, npm 패키지·플러그인 파일, README 두 벌.

검증하지 못한 것:
- 자문 시점 분류의 정확도(조언 내용이 암호화되어 대조할 방법이 없음).
- 윈도우·리눅스 실행(테스트는 맥 Node 22·23·24에서 통과).
- 플러그인 설치(`/plugin marketplace add`)와 `/agent-watchtower:start` 실제 동작. 깃 저장소가 있어야 시험할 수 있다.

## 다음 단계 후보

- 새 버전을 낼 때: `package.json` 과 `.claude-plugin/plugin.json` 의 version 을 같이 올리고, `npm publish`(2단계 인증 필요)와 `git push`.
- GitHub Actions로 윈도우·리눅스·맥 × Node 22/24 테스트.
- 안 쓰는 CSS 정리: `.tiles`, `.log-head`, `.timeline`, `.sig .pick`, `.sig-note`, `.sig-div`, `tile()` 함수.
- 세션이 멈추거나 오류가 반복될 때 알림.
- 터치 화면에서 보충 설명(지금은 마우스를 올려야 나옴) 보는 방법.
