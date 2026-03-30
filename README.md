# Claude Discord & Slack Bot

Claude Code를 MCP Channel 플러그인으로 연동하는 멀티 플랫폼(Discord + Slack) 봇.
Claude Max 구독 인증을 그대로 사용하여 API 비용 없이 운영한다.
Discord와 Slack을 동시에 지원하며, 각 플랫폼은 독립된 MCP 서버로 동작한다.

## 기능

- **멀티 플랫폼** — Discord와 Slack을 동시에 지원 (토큰 설정에 따라 조건부 활성화)
- **MCP Channel 통합** — Claude Code가 메인 프로세스, 봇은 MCP 서버로 동작
- **일반 대화** — 메시지가 `<channel>` 태그로 Claude에 전달 (`source="discord"` 또는 `source="slack"`)
- **첨부파일** — 이미지/파일을 올리면 Claude가 `download_attachment` 도구로 다운로드
- **답장 맥락** — 특정 메시지에 답장하면 원본 메시지를 맥락으로 포함 (Discord), 스레드 지원 (Slack)
- **MCP 도구** — reply, react, edit_message, fetch_messages, download_attachment
- `/new` — 새 세션 시작 (하드 리스타트)
- `/clear` — 세션 초기화 (CLI 내장 명령어)
- `/compact [힌트]` — 컨텍스트 압축 (CLI 내장 명령어)
- `/model <name>` — 모델 변경 (sonnet, opus, haiku)
- `/cwd <path>` — 작업 디렉토리 변경
- `/help` — 명령어 목록

## 사전 요구사항

- **Node.js** >= 20
- **Claude Code CLI** (`claude` 명령어가 PATH에 있어야 함)
- **Claude Max 구독** (CLI에 로그인된 상태)
- **Discord Bot Token** 및/또는 **Slack Bot Token** (최소 하나 필수)
- **빌드 도구** — node-pty 컴파일을 위해 `build-essential` / `python3` 필요

## 세팅 가이드

### 1. Claude Code CLI 준비

```bash
# Claude CLI가 설치되어 있는지 확인
claude --version

# Max 구독으로 로그인 (아직 안 했다면)
claude login
```

### 2. Discord Bot 생성

1. [Discord Developer Portal](https://discord.com/developers/applications)에 접속
2. **New Application** 클릭 → 이름 입력 (예: `Claude Bot`)
3. 왼쪽 메뉴에서 **Bot** 클릭
4. **Privileged Gateway Intents** 섹션에서 아래 3개를 모두 활성화:
   - ✅ Presence Intent
   - ✅ Server Members Intent
   - ✅ **Message Content Intent** (필수 — 메시지 내용을 읽기 위해 필요)
5. **Reset Token** 클릭 → 토큰 복사 (이후 `.env`에 사용)

### 3. Bot을 서버에 초대

1. 왼쪽 메뉴에서 **OAuth2** → **URL Generator** 클릭
2. **Scopes** 에서 `bot` 체크
3. **Bot Permissions** 에서 아래 체크:
   - ✅ Send Messages
   - ✅ Send Messages in Threads
   - ✅ Read Message History
   - ✅ Attach Files
   - ✅ Add Reactions
4. 생성된 URL을 브라우저에서 열어 서버에 초대

### 4. (선택) Slack Bot 생성

1. [Slack API](https://api.slack.com/apps)에 접속
2. **Create New App** → **From scratch** → 이름과 워크스페이스 선택
3. 왼쪽 메뉴에서 **App Home** 클릭:
   - **Show Tabs** 섹션에서 **Messages Tab** 활성화
   - ✅ **"Allow users to send Slash commands and messages from the messages tab"** 체크 (DM 수신에 필수)
4. 왼쪽 메뉴에서 **Socket Mode** → **Enable Socket Mode** 활성화
   - App-Level Token 생성 (이름: `socket-mode`, Scope: `connections:write`) → `xapp-...` 토큰 복사
5. **OAuth & Permissions** → **Bot Token Scopes** 에서 아래 추가:
   - `channels:history` — 공개 채널 메시지 읽기
   - `channels:read` — 공개 채널 목록 조회
   - `groups:history` — 비공개 채널 메시지 읽기
   - `groups:read` — 비공개 채널 목록 조회
   - `im:history` — DM 메시지 읽기
   - `im:read` — DM 채널 조회
   - `im:write` — DM 대화 시작
   - `mpim:history` — 그룹 DM 메시지 읽기
   - `mpim:read` — 그룹 DM 채널 조회
   - `chat:write` — 메시지 전송
   - `files:read` — 첨부파일 다운로드
   - `files:write` — 파일 업로드
   - `reactions:write` — 이모지 리액션
   - `users:read` — 사용자 정보 조회
6. **Install to Workspace** → Bot User OAuth Token 복사 (`xoxb-...`)
7. **Event Subscriptions** → **Enable Events** 활성화
   - **Subscribe to bot events** 에서 아래 추가:
     - `message.channels` — 공개 채널 메시지
     - `message.groups` — 비공개 채널 메시지
     - `message.im` — DM 메시지
     - `message.mpim` — 그룹 DM 메시지
8. 스코프나 이벤트를 변경했다면 **Reinstall to Workspace** 클릭하여 앱 재설치
9. Bot을 채널에 초대: 채널에서 `/invite @봇이름`
   - DM은 초대 불필요 — Slack에서 봇에게 직접 메시지를 보내면 자동으로 DM 채널이 생성됨

### 5. 프로젝트 설정

```bash
# 의존성 설치
npm install

# 환경변수 파일 생성
cp .env.example .env
```

`.env` 파일을 열어 값을 설정:

```env
# [플랫폼 토큰] 최소 하나는 필수
DISCORD_BOT_TOKEN=your_discord_token_here
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_APP_TOKEN=xapp-your-slack-app-token

# [선택] 기본 설정
DEFAULT_MODEL=claude-sonnet-4-6
DEFAULT_CWD=~/
MAX_TURNS=50          # 0 = unlimited

# [선택] 특정 채널에서만 동작하게 제한 (빈 값이면 모든 채널에서 동작)
ALLOWED_CHANNEL_IDS=
SLACK_ALLOWED_CHANNEL_IDS=

# [선택] Claude Code CLI 경로 (기본: ~/.local/bin/claude)
# CLAUDE_PATH=~/.local/bin/claude

# [선택] 시스템 프롬프트 파일
# SYSTEM_PROMPT_PATH=data/system-prompt.txt
```

### 6. 실행

```bash
# 빌드 후 실행
npm run build
npm start

# 또는 개발 모드 (tsx로 직접 실행)
npm run dev
```

wrapper가 Claude Code를 node-pty로 스폰하고, Claude Code가 MCP 서버를 자식 프로세스로 실행합니다.

### 7. (선택) tmux/screen으로 상시 실행

Claude Code가 인터랙티브 모드로 실행되므로, PTY가 필요합니다.

```bash
# tmux 세션에서 실행
tmux new-session -d -s claude-bot 'npm start'

# 로그 확인
tmux attach -t claude-bot
```

## 설정 상세

| 환경변수 | 기본값 | 설명 |
|----------|--------|------|
| `DISCORD_BOT_TOKEN` | (Discord/Slack 중 하나 필수) | Discord Bot 토큰 |
| `SLACK_BOT_TOKEN` | (Discord/Slack 중 하나 필수) | Slack Bot OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | (`SLACK_BOT_TOKEN` 사용 시 필수) | Slack App-Level Token (`xapp-...`, Socket Mode용) |
| `VERBOSE` | `true` | Claude Code 터미널 출력 및 MCP 서버 로그 |
| `DEFAULT_MODEL` | `claude-sonnet-4-6` | 기본 모델 |
| `DEFAULT_CWD` | 현재 디렉토리 | 기본 작업 디렉토리 |
| `MAX_TURNS` | `50` | 메시지당 최대 도구 호출 횟수 (0=무제한) |
| `ALLOWED_CHANNEL_IDS` | (비어있음=전체) | Discord 허용 채널 ID 목록 (쉼표 구분) |
| `SLACK_ALLOWED_CHANNEL_IDS` | (비어있음=전체) | Slack 허용 채널 ID 목록 (쉼표 구분) |
| `CLAUDE_PATH` | `~/.local/bin/claude` | Claude Code CLI 경로 |
| `SYSTEM_PROMPT_PATH` | `data/system-prompt.txt` | 시스템 프롬프트 파일 경로 |

## 아키텍처

```
wrapper.ts (npm start)
  ├─ IPC 소켓 서버 (data/wrapper.sock) — 멀티 클라이언트
  ├─ Claude Code 스폰 (node-pty, 인터랙티브 모드)
  │   ├─ Discord MCP 서버 (조건부: DISCORD_BOT_TOKEN)
  │   │   ├─ Discord.js 클라이언트 (Gateway 연결)
  │   │   ├─ MCP 도구: reply, react, edit_message, fetch_messages, download_attachment
  │   │   ├─ 명령어 핸들링: /new, /clear, /compact, /model, /cwd, /help
  │   │   └─ 채널 notification (source="discord")
  │   └─ Slack MCP 서버 (조건부: SLACK_BOT_TOKEN)
  │       ├─ Slack Socket Mode 클라이언트 (WebSocket 연결)
  │       ├─ Slack Web API 클라이언트 (메시지, 리액션, 파일 등)
  │       ├─ MCP 도구: reply, react, edit_message, fetch_messages, download_attachment
  │       ├─ 명령어 핸들링: /new, /clear, /compact, /model, /cwd, /help
  │       └─ 채널 notification (source="slack")
  └─ restart 시 Claude Code kill → respawn, 또는 PTY 명령어 전달
```

> **참고:** Discord와 Slack은 같은 Claude Code 세션을 공유합니다. 한쪽에서 `/new`을 입력하면 양쪽 모두 새 세션으로 전환됩니다.

### 메시지 흐름

```
Discord/Slack 메시지 수신
  │
  ├─ 명령어 (/new, /clear, /compact, ...)
  │   └─ MCP 서버에서 직접 처리 → IPC로 wrapper에 시그널 (restart 또는 PTY 명령)
  │
  └─ 일반 메시지
      └─ MCP notifications/claude/channel → Claude 컨텍스트에 <channel> 태그로 주입
          └─ Claude가 reply 도구 호출 → 해당 플랫폼의 MCP 서버가 전송
```

### 하드 리스타트 흐름 (/new)

```
/new 입력
  → MCP 서버가 Discord에 확인 메시지 전송
  → IPC로 wrapper에 restart 시그널
  → wrapper가 Claude Code kill
  → MCP 서버 종료 (Claude의 자식 프로세스)
  → wrapper가 새 Claude Code 스폰
  → 새 Claude Code가 새 MCP 서버 스폰
  → MCP 서버가 Discord에 재연결
```

### PTY 명령어 흐름 (/compact, /clear)

```
/compact 또는 /clear 입력
  → MCP 서버가 Discord에 확인 메시지 전송
  → IPC로 wrapper에 시그널
  → wrapper가 PTY에 CLI 명령어 직접 입력 (/compact 또는 /clear)
  → Claude Code CLI가 내부적으로 처리 (프로세스 유지, MCP 연결 유지)
```

### Claude Code Channels (MCP) 모드

기본 실행 방법. wrapper가 Claude Code를 node-pty로 스폰하고, Claude Code가 이 프로젝트의 MCP 서버들을 채널 플러그인으로 로드한다.

```bash
# 빌드 필수 (MCP 서버는 dist/ 하위에서 실행됨)
npm run build

# wrapper 실행 → Claude Code 스폰 → MCP 서버 자동 시작
npm start

# 또는 개발 모드
npm run dev
```

**동작 과정:**

1. `wrapper.ts`가 `data/mcp-config.json`을 자동 생성 (설정된 토큰에 따라 Discord/Slack MCP 서버 등록)
2. Claude Code를 `--dangerously-load-development-channels server:discord-bot,server:slack-bot --mcp-config data/mcp-config.json`으로 스폰
3. Claude Code가 MCP 서버들을 자식 프로세스로 실행 (`dist/mcp-server.js`, `dist/slack-mcp-server.js`)
4. 각 MCP 서버가 플랫폼에 연결 (Discord Gateway / Slack Socket Mode), wrapper IPC 소켓에 연결
5. 메시지 → MCP 채널 notification → Claude 처리 → reply 도구 → 해당 플랫폼 응답

> **참고:** wrapper 없이 수동 실행할 경우 `data/mcp-config.json`을 직접 작성해야 하며, `/new`, `/model`, `/cwd`의 하드 리스타트와 `/compact`, `/clear`의 PTY 전달이 동작하지 않는다.

### 레거시 모드

기존 subprocess-per-message 방식도 유지:

```bash
npm run dev:legacy    # tsx src/index.ts
npm run start:legacy  # node dist/index.js
```

## 트러블슈팅

### Bot이 메시지에 반응하지 않음

1. **Message Content Intent** 가 켜져 있는지 확인 (Developer Portal → Bot → Privileged Intents)
2. `ALLOWED_CHANNEL_IDS`에 해당 채널이 포함되어 있는지 확인 (비어있으면 전체 허용)
3. Bot이 해당 채널에 메시지 읽기/쓰기 권한이 있는지 확인

### Claude CLI 인증 오류

```bash
# 인증 상태 확인
claude auth status

# 재로그인
claude login
```

### node-pty 빌드 오류

```bash
# Linux에서 필요한 빌드 도구
sudo apt install build-essential python3

# 재설치
npm rebuild node-pty
```

### 세션이 이상하게 동작할 때

Discord에서 `/new` 또는 `/clear`를 입력하여 Claude Code를 재시작합니다.
