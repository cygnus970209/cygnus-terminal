# 창 복원 시 프롬프트 줄바꿈 조사

2026-09-22, 기준 v0.1.11. 프로젝트 루트의 사용자 제공 사진에서 이전 프롬프트만
약 10열로 줄바꿈되고 최신 프롬프트는 정상 폭으로 출력되는 것을 확인했다.

## 원인과 재현 범위

기존 Terminal.tsx는 창 숨김 여부를 검사하지 않고 fit을 호출했다. ResizeObserver는
너비만 검사했고, 비동기 fit 실행 시점의 가시성도 검사하지 않았다.
복원 시에는 focus/visibility 이벤트를 처리하지 않았다.

실제 React 앱 + Chromium + 가짜 Tauri IPC에서 document.hidden=true와 너비 100px를
설정해 창 크기 변경을 모사했다. 수정 전 resize_ssh가 `cols:10, rows:41`을 보냈고,
복원 시 `cols:88, rows:41`을 보냈다. 이 경로는 서버의 프롬프트 재출력과 좁은
줄바꿈을 유발할 수 있다. 실제 macOS 최소화가 같은 DOM 이벤트를 발생시키는지는
네이티브 앱에서 검증하지 않았으므로 사진의 유일한 원인이라고 단정하지 않는다.

## v0.1.12에 포함된 변경

- 활성 탭, 보이는 문서, 양수 너비/높이에서만 크기를 계산한다.
- 100ms 동안 크기 변경을 모으고 실제 실행 시 가시성을 다시 검사한다.
- focus/visibilitychange/pageshow 및 탭 복귀 시 크기를 계산하고 화면을 다시 그린다.
- 접속 완료 전에 fit이 끝난 경우에도 서버에 현재 크기를 전달한다.
- Serial에는 지원하지 않는 PTY resize를 보내지 않는다.
- 종료 시 예약 작업과 이벤트 리스너를 정리한다.

기존 스크롤백을 지우거나 셸에 명령을 주입하지 않는다.

## 검증

- 수정 후 같은 숨김 재현에서 resize_ssh 호출 0회.
- 크기가 같은 상태로 복원했을 때 불필요한 서버 resize 0회.
- 숨겨진 동안 너비가 바뀌고 visibility 이벤트만으로 복원되어도 올바르게 resize.
- 높이 0 상태에서 resize 0회.
- 9월 22일 수정 검증 시 단위 테스트 전체 31개 통과, TypeScript/Vite 빌드 통과.
- 기존 빌드 경고: 번들 크기 및 static/dynamic import 중복.

브라우저 회귀 검증은 `reproduce.cjs`. Vite 서버 및 별도 설치된 Playwright 필요:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node docs/investigations/terminal-resize-2026-09-22/reproduce.cjs
```

실제 SSH 서버와 macOS Dock 최소화/장시간 복원의 통합 검증은 남아 있다.
