# 검토 파이프라인 따라 하기

에이전트 워치타워는 Claude Code가 남기는 기록만 읽습니다. 그래서 화면에 무엇이 채워지는지는 **어떤 앱에서, 어떤 설정으로 Claude Code를 쓰는지**에 달려 있습니다. 이 문서는 워치타워를 만든 사람의 개발/검토 설정을 그대로 따라 하는 방법입니다. 이대로 하면 스크린샷과 같은 화면(조언자 패널, critic 하위 에이전트 카드 등)이 나옵니다.

[English](SETUP.md)

## 화면 요소와 필요한 설정

| 화면 요소 | 기록에 남는 것 | 필요한 설정 |
|---|---|---|
| 세션 제목 | `custom-title` / `agent-name`(데스크톱 앱), `ai-title`(VS Code) | 데스크톱 앱 또는 VS Code 확장 |
| 조언자 패널, 상태줄 `--advisor` | `advisorModel` 필드, `advisor` 서버 도구 호출 | `settings.json` 의 `advisorModel` |
| 하위 에이전트 카드·진행률 | `subagents/agent-*.jsonl`, `.meta.json` | 서브에이전트 정의(`critic`, `scout`)와 이를 부르는 규칙 |
| 추론 강도 막대 | `effort` 필드 | 기본으로 남음. `effortLevel` 로 바꿀 수 있음 |
| 비용 | `cost-state` 줄 | 데스크톱 앱 또는 VS Code 확장 |
| 판단 층에서 빼는 기록용 호출 | `update_plan`, `wrap_up`(데스크톱 앱), `TodoWrite`(터미널), `ToolSearch` | 따로 할 일 없음 |

조언자 패널은 조언자를 쓰지 않는 세션에서는 숨겨지고, 비용은 기록에 있을 때만 나옵니다. 설정이 빠져도 화면이 깨지지는 않습니다.

## 1. 준비

- **Claude 데스크톱 앱의 Code 탭**(권장. 워치타워를 만든 환경) 또는 **VS Code의 Claude Code 확장**.
- Claude Code **2.1.317 이상**. 앱과 확장은 자체 버전을 함께 씁니다. 개발 환경의 기록은 2.1.317~2.1.321에서 확인했습니다.
- Node.js 22 이상(워치타워 실행용).

## 2. 한 줄로 설정하기

```bash
npx agent-watchtower setup
```

무엇을 추가할지 보여 주기만 하고 아무것도 바꾸지 않습니다. 내용을 확인한 뒤:

```bash
npx agent-watchtower setup --yes
```

하는 일:

- `~/.claude/agents/critic.md`, `~/.claude/agents/scout.md` 추가. 같은 이름의 파일(심볼릭 링크 포함)이 있으면 건너뜁니다.
- `~/.claude/CLAUDE.md` 끝에 "완료 보고 전 critic 검토" 규칙을 표시 주석으로 감싸 추가. 이 명령으로 넣은 적이 있으면 건너뜁니다. 비슷한 규칙을 이미 손으로 써 두었다면 적용 뒤 둘 중 하나를 지우세요.
- `~/.claude/settings.json` 에 `"advisorModel": "opus"` 추가. 이미 값이 있으면 그대로 두고, 고치기 전에 백업 파일을 남깁니다.

`CLAUDE_CONFIG_DIR` 을 쓰면 그 폴더에 씁니다. 시스템 언어가 한국어면 한국어 규칙을, 아니면 영어 규칙을 넣습니다(`--lang=ko` / `--lang=en` 으로 고를 수 있음). 적용 뒤 Claude Code를 다시 시작하거나 새 세션을 여세요.

## 3. 손으로 설정하기 (같은 내용)

### 조언자

`~/.claude/settings.json`:

```json
{
  "advisorModel": "opus"
}
```

조언자는 작업 중에 더 강한 모델에게 검토를 받는 기능입니다. 계정이나 요금제에 따라 쓸 수 없을 수 있으며, 그 경우 기록에 자문이 남지 않아 조언자 패널이 숨겨집니다. (개발 환경 외의 계정에서는 확인하지 못했습니다.)

### 서브에이전트

`~/.claude/agents/critic.md` — 완료 전 검토 담당. 내용은 이 패키지의 [`setup/ko/critic.md`](../setup/ko/critic.md).
`~/.claude/agents/scout.md` — 코드 위치만 빠르게 찾는 담당. 내용은 [`setup/ko/scout.md`](../setup/ko/scout.md).

### 전역 규칙

`~/.claude/CLAUDE.md` 에 [`setup/ko/CLAUDE.md`](../setup/ko/CLAUDE.md) 의 세 줄을 넣습니다. 이 규칙 때문에 메인 세션이 일을 마치기 전에 critic 하위 에이전트를 띄우고, 워치타워에 그 카드가 나타납니다.

## 4. 선택: 모델과 안전 장치

자동 설정에는 넣지 않았습니다. 개인 취향과 요금제에 따라 다르기 때문입니다.

```json
{
  "model": "opus",
  "effortLevel": "medium",
  "permissions": {
    "deny": [
      "Bash(sudo rm:*)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(git reset --hard:*)",
      "Bash(git clean -fd:*)"
    ]
  }
}
```

- `model`, `effortLevel`: 개발 환경은 Opus를 기본으로, 추론 강도는 medium(모델별로 high)을 씁니다.
- `permissions.deny`: 되돌리기 어려운 명령을 막는 목록의 일부입니다.

## 5. 확인

1. Claude Code에서 코드를 고치는 작업을 하나 맡깁니다.
2. 다른 터미널에서 `npx agent-watchtower` 를 실행합니다.
3. 작업이 끝날 무렵 흐름도에 `critic` 하위 에이전트 카드가 나타나고, 조언자를 쓸 수 있는 계정이면 왼쪽에 조언자 패널과 자문 횟수가 나옵니다.

## 따라 하지 않는 것

- **권한 허용 목록**: 개발 환경의 허용 목록은 그 사람의 프로젝트와 도구에 맞춘 것이라 옮기지 않습니다.
- **개인 플러그인과 MCP 서버**: 워치타워 화면과 관계가 없습니다.
