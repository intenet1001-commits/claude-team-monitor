# Claude Team Monitor

> Real-time web dashboard for monitoring Claude Agent Teams

**GitHub:** https://github.com/intenet1001-commits/claude-team-monitor

---

## 소개

Claude Code의 멀티 에이전트 팀 세션을 실시간으로 모니터링하는 웹 대시보드입니다.
팀 멤버 상태, 태스크 보드, 액티비티 피드, 터미널 출력을 한 화면에서 확인할 수 있습니다.

## 주요 기능

- **팀 멤버 패널** — lead/subagent 역할, 활성/종료 상태 실시간 표시
- **태스크 보드** — Pending / In Progress / Done 칸반 뷰
- **액티비티 피드** — 에이전트 간 메시지·툴 호출 실시간 스트림
- **터미널 패널** — 각 에이전트 pane의 터미널 출력 탭 전환
- **플러그인 스킬 패널** — 설치된 oh-my-claudecode 스킬 목록 + 검색
  - **Teams 필터** — `⬡ Teams만 보기` 버튼으로 멀티 에이전트 스킬만 필터링
- **팀 이력** — 종료된 세션 기록 조회

## 설치 및 실행

```bash
npm install
npm start
```

기본 포트: **9099**
브라우저에서 `http://localhost:9099` 접속

## 기술 스택

- **Frontend:** Vanilla JS, Single Page App
- **Backend:** Node.js + Express + WebSocket (ws)
- **파일 감시:** chokidar (Claude 세션 파일 실시간 감지)

## Claude 세션 연동

Claude Code 실행 중인 상태에서 대시보드를 열면 자동으로 팀 세션을 감지합니다.
`~/.claude/` 디렉토리의 세션 파일을 실시간으로 파싱하여 표시합니다.
