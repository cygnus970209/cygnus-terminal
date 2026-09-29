# 터미널 입력 조사 — 2026-09-18

조사 기준: `6ea61e41dbd61910efd2709abb7e2fc2e89950c1` (v0.1.11), xterm 6.0.0.

**2026-09-28 갱신: 실패한 명령의 공백이 NBSP임을 사용자 히스토리 바이트로 확인.
NBSP가 생성된 입력 이벤트/입력기는 아직 미확정.**
v0.1.12에서는 직접 입력·붙여넣기와 저장 명령 실행의 U+00A0를 전송 전에 일반 공백
U+0020으로 바꾼다. v0.1.12 배포 시점에는 아래 IME 재전송·볼트 Enter 중복 결함이 별도 미해결 항목이었다.

v0.1.13 볼트 UI 작업에서는 처리한 키 이벤트의 전파를 중단하고 중복 주입을 막아
Enter 이중 전달을 수정했다. 현재 동작의 회귀 검증은
`scripts/qa/vault.cjs`에서 수행한다. 아래 당시 재현 기록과 스크립트는 역사적 자료다.

## 2026-09-28 확정 증거

실패 직후 사용자가 실행한 `fc${IFS}-ln${IFS}-1|od${IFS}-An${IFS}-tx1` 결과:

```text
09 20 73 75 64 6f c2 a0 73 75 0a
      s  u  d  o [NBSP] s  u
```

명령 내부의 `c2 a0`는 UTF-8 U+00A0다. 일반 공백 `20`이 아니므로 Bash가
`sudo`와 `su`를 분리하지 않는다. 따라서 `sudo su: command not found`가 발생한다.
이는 원격 sudo 설치나 디렉터리 유실을 이 실패의 원인으로 볼 근거가 없음을 보여준다.
앞의 `09 20`은 fc 출력의 선행 공백이고, 핵심은 명령 내부의 바이트다.

기존 합성 IME 재전송 결함이 NBSP를 생성했다는 증거는 없다. macOS 입력기,
modifier 상태 또는 브라우저의 키 이벤트를 추가로 구분해야 한다.
아래 9월 18일의 미확정 가설과 검증 기록은 당시 조사 이력이다.

## 9월 18일 당시 관찰과 해석

- `sudo`는 실행되지만 `sudo su` 전체가 `command not found`에 표시된다.
- `cd /home`은 실패하고 `cd${IFS}/home`은 성공한다.
- 새 세션은 정상이다. reset은 해결하지 못했다. Ctrl+C 후 회복한 경우도 있지만,
  이후 다른 서버에서 반복한 Ctrl+C로도 회복되지 않았다.
- 마지막 재발에는 Tab 완성도 기대대로 동작하지 않았다.
- 별도로 입력한 `echo "a b"`의 바이트는 ASCII 공백 `20`이었다. 이것은
  **실패한 명령에 들어 있던 공백의 바이트를 증명하지 않는다.**

로그는 경로 자체가 사라졌다기보다, 명령 이름과 인자가 하나의 토큰으로
해석되는 경우에 부합했다. 당시에는 실패한 명령의 바이트가 없어 NBSP를 확정하지 못했다.
로컬 Bash에서 다음 세 입력은 모두 비슷한 오류를 낸다:

| 입력 | 실제 바이트 | 결과 |
| --- | --- | --- |
| `cd /` | `63 64 20 2f` | 성공 |
| `cd` + NBSP + `/` | `63 64 c2 a0 2f` | `cd /: No such file or directory` |
| `'cd /'` | `27 63 64 20 2f 27` | `cd /: No such file or directory` |
| `cd\ /` | `63 64 5c 20 2f` | `cd /: No such file or directory` |

## 재현한 결함

### 1. xterm IME 처리에서 기존 textarea 전체를 재전송

실제 앱을 Chromium에서 실행하고 Tauri IPC만 가짜 세션으로 교체했다.
일반 `sudo su` 타이핑의 전송값은 정확히 `sudo su`였지만,
숨겨진 textarea에는 공백이 남았다. 대문자 `A B C`는 textarea에 전부 남았다.
일반 Enter와 Ctrl+C는 textarea를 비웠다.

textarea를 `sudo su`로 설정하고 비조합 상태에서 keyCode 229 이벤트를 발생시킨 뒤
`sudo sX`로 바꾸면 **전체 `sudo sX`가 write_ssh로 전송됐다.**
`CompositionHelper._handleAnyTextareaChanges()`의 같은 길이 변경 분기가 원인이다.

이것은 **합성 IME 이벤트로 재현한 결함**이다. 실제 macOS 입력기에서 발생한
이벤트를 캡처한 것이 아니고, 위 재현은 공백을 NBSP로 바꾸지도 않았다.
따라서 사용자 오류의 직접 원인이라고 결론 내릴 수 없다.

같은 경로가 [xterm upstream #6078](https://github.com/xtermjs/xterm.js/issues/6078)에
보고되어 있다. 조합 중 textarea를 무조건 비우거나 229를 차단하는 방식은
정상 한글 조합을 손상시킬 수 있으므로 수정안으로 채택하지 않았다.

### 2. 볼트 팝업과 터미널에 Enter가 동시에 전달

가짜 sudo 비밀번호 프롬프트로 팝업을 연 뒤 터미널 textarea를 다시 포커스하고
Enter를 누르면, `vault_inject` 1회와 별도 `write_ssh("\r")` 1회가 발생했다.
백엔드 `vault_inject`는 이미 비밀번호에 CR을 붙이므로 추가 Enter가 중복된다.

`VaultPromptPicker.tsx`의 window capture 핸들러가 `preventDefault()`만 하고
전파를 중단하지 않아, xterm의 키 핸들러도 같은 이벤트를 처리한다.
이 결함은 공백 변조를 설명하지 않지만 비밀번호 입력 흐름에 영향을 준다.

## 9월 18일 코드 추적에서 추가로 확인한 사항

| 경로 | 확인 결과 |
| --- | --- |
| 직접 타이핑 | `Terminal.tsx` onData → invoke → Rust write_* → 세션 writer. 앱에서 공백을 치환하거나 명령 전체를 quote하는 코드 없음 |
| SSH | 문자열을 UTF-8 바이트로 바꾸고 mpsc로 보낸 뒤 SSH channel에 그대로 씀 |
| Telnet / Serial / PTY | 일반 텍스트 입력을 임의로 quote하거나 공백을 치환하지 않음 |
| 복사 / 붙여넣기 | 네이티브 클립보드 → xterm.paste. 직접 타이핑에는 사용되지 않음 |
| Ctrl+C | macOS Cmd+C 복사와 구별됨. Ctrl+C는 xterm에서 ETX (`03`)로 전송됨 |
| 명령 저장 / 히스토리 | Enter 때 표시 문자열을 읽어 저장하지만 원래 onData 값을 수정하지 않음 |
| OSC 7 / cwd | 수신한 경로만 읽음. 현재 코드에는 pwd 자동 주입 없음 |
| 하이라이트 | 서버 출력 처리에만 적용. 직접 입력 바이트를 가공하지 않음 |
| 저장 명령 실행 | App.tsx는 SSH 외 세션을 모두 write_pty로 보냄. Telnet/Serial 경로 오류가 코드상 확인됨. 이번 직접 타이핑 증상과 별개 |
| 비동기 전송 | onData가 invoke 완료를 기다리지 않고 오류도 처리하지 않음. 실제 네이티브 IPC 재정렬 여부는 미검증 |
| SSH 락 | write/resize가 전역 sessions 락을 잡고 큐 send를 await함. SFTP channel_open_session도 락 안이며 뒤의 15초 타임아웃 범위 밖. 지연/먹통 위험은 남아 있으나 공백 변조 증거는 없음 |

v0.1.8의 SFTP 락 수정 이력도 확인했다. subsystem 핸드셰이크의 락은 분리되어
있으며, 이번 로그를 그 과거 버그의 재발로 단정할 근거는 없다.

## 실행한 검증과 범위

- 앱의 일반 `cd /home`, `sudo su`, Enter: 예상 문자열과 일치.
- Unicode insertText `가나다`, 합성 한글 composition `한`: 각각 한 번 전송.
- 숨겨진 textarea 축적과 Ctrl+C 초기화: 관찰됨.
- 합성 keyCode 229 문자열 전체 재전송: 재현됨.
- 볼트 팝업에서 터미널 재포커스 후 Enter 이중 전달: 재현됨.
- 로컬 Bash에서 NBSP / quote / escaped-space 오류 형태: 재현됨.
- 브라우저 pageerror: 없음.

이 검증은 가짜 IPC를 사용하는 Chromium 테스트다. 실제 SSH 전송 순서,
사용자의 원격 Bash 설정, macOS 네이티브 IME 이벤트는 검증하지 않았다.
Playwright WebKit 설치는 진행이 멈춰 중단했으며 WebKit 통과를 주장하지 않는다.
9월 18일 조사에서는 제품 코드를 수정하지 않아 전체 빌드/테스트 스위트를 재실행하지 않았다.
이 기록은 이후 v0.1.12 수정의 검증 결과와 구분한다.

## 재현 스크립트

`reproduce.cjs`는 위 두 결함을 확인하는 조사 스크립트다. 정상 동작을 보증하는
회귀 테스트가 아니므로 결함을 수정하면 마지막 assertion도 변경해야 한다.
실제 서버에 연결하지 않으며 fixture 문자열만 사용한다.

Vite 서버를 실행한 다음, Playwright가 설치된 환경에서:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core \
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
node docs/investigations/terminal-input-2026-09-18/reproduce.cjs
```

`APP_URL` 기본값은 `http://127.0.0.1:1420`이다. `webkit` 인자로 엔진을 바꿀 수
있지만 해당 브라우저가 별도로 설치되어 있어야 한다.

## 재발 시 진단과 남은 조사

증상이 유지된 세션에서 **직전 실패한 명령**을 다음과 같이 확인한다.
별도의 테스트 문자열에 들어간 공백을 검사하는 것과 구분해야 한다.

```sh
fc${IFS}-ln${IFS}-1|od${IFS}-An${IFS}-tx1
```

`c2 a0`이면 NBSP, `5c 20`이면 escaped space, `27`/`22`는 quote 후보다.
실패한 명령에 정상 공백만 있다면 입력기 공백 가설을 버리고, 원격 readline
바인딩·셸 함수 및 실제 전송 경계를 조사해야 한다. 히스토리 바이트만으로도
모든 셸 설정이나 키 이벤트 원인을 판별할 수 있는 것은 아니다.

v0.1.12의 NBSP 치환은 사용자가 요청한 입력 정책이다. 일반 키 입력과 붙여넣기의
U+00A0를 문맥에 관계없이 바꾸므로, 따옴표 안의 문자열·파일명·직접 입력한
비밀번호에 포함된 NBSP도 일반 공백이 된다. Rust 백엔드의 Vault 직접 주입은
이 프런트엔드 치환 경로를 지나지 않는다. 다른 유니코드 문자와 제어 문자는 유지한다.
`src/utils/terminalInput.test.ts`에서 치환과 문자 보존을 검증한다.

저장 명령의 프로토콜 라우팅, IME 호환성 검증을 거친 xterm 수정은
별도 조사·수정 대상으로 남는다. NBSP가 처음 생성되는 입력 이벤트도 미확정이다.
