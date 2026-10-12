# Cygnus MCP

Cygnus를 실행 중인 컴퓨터의 AI 클라이언트에서 저장된 SSH 서버를 조회하고 명령을 실행할 수 있다.
MCP는 기본적으로 꺼져 있으며 **Settings → MCP**에서 직접 켠다.

## 연결하기

1. Connections에 SSH 프로필을 저장하고, 터미널로 한 번 접속해 호스트 키를 확인한다.
   Jump Host를 사용하면 경유 서버와 대상 서버 모두 신뢰된 키가 필요하다.
2. Settings → MCP에서 공유할 SSH 서버를 선택한다. 기본 포트는 `38473`이다.
   다른 앱이 사용 중이면 포트를 바꾸거나 `0`으로 설정해 빈 포트를 배정받는다.
3. 서버 조회만 필요하면 **Allow remote command execution**을 끈다.
   켜면 해당 SSH 계정이 허용하는 임의 명령을 AI 클라이언트가 실행할 수 있다.
4. **Start MCP**를 누르고 표시된 URL과 토큰을 AI 클라이언트에 등록한다.
   전송 방식은 **Streamable HTTP**, 인증 헤더는 `Authorization: Bearer <토큰>`이다.
5. 저장된 비밀번호를 사용하는 작업에서 잠금 해제 오류가 나오면
   **Unlock saved credentials**를 누른다. 기존 Cygnus 키체인 안내와 OS 권한 절차를
   거쳐 잠금이 해제된다. MCP 요청 자체가 OS 키체인 접근을 승인하지는 않는다.

클라이언트의 HTTP MCP 서버 설정에 전달할 값은 다음과 같다. 설정 파일의 바깥 구조는
클라이언트마다 다르다. 포트 `0`을 선택했다면 화면에 표시되는 실제 URL을 사용한다.

```json
{
  "url": "http://127.0.0.1:38473/mcp",
  "headers": {
    "Authorization": "Bearer <Settings에서 복사한 토큰>"
  }
}
```

이 버전은 로컬 클라이언트의 HTTP 연결을 지원한다. stdio 전용 클라이언트, 브라우저에서
직접 호출하는 클라이언트, 클라우드에서 사용자의 컴퓨터로 연결하는 중계 서비스는 포함하지 않는다.

## 클라이언트별 빠른 등록

Settings → MCP 하단의 **Connect an AI client**에서 Codex CLI, Claude Code,
Cursor, Kiro IDE를 선택한다. MCP를 시작하면 현재 URL과 토큰을 반영한 내용을 복사할 수 있다.
Windows는 PowerShell, macOS는 zsh/bash 문법과 사용자 설정 경로를 자동으로 표시한다.
화면의 `<BEARER_TOKEN>`은 미리보기용이며 복사 버튼은 실제 토큰을 넣는다.

Codex CLI와 Claude Code는 설치된 CLI가 필요하다. 복사한 두 줄을 **이 컴퓨터의 터미널**에
실행한 뒤 같은 터미널에서 `codex` 또는 `claude`를 시작한다. 첫 줄은 현재 셸의
`CYGNUS_MCP_TOKEN`을 설정하고, 두 번째 줄은 사용자 범위에 `cygnus` 서버를 등록한다.
설정 파일에는 토큰 자체 대신 환경변수 참조를 저장한다. 새 터미널에서는 토큰을 다시
설정해야 한다. 등록 명령어를 붙여넣으면 셸 히스토리에는 토큰이 남을 수 있다.

Codex는 `--bearer-token-env-var CYGNUS_MCP_TOKEN`, Claude Code는
`--transport http --scope user`와 리터럴 `Authorization: Bearer ${CYGNUS_MCP_TOKEN}`
헤더를 사용한다. 이미 등록한 `cygnus`를 교체해야 하면 화면에 나온 remove 명령으로
해당 항목을 지운 뒤 다시 등록한다.
[OpenAI 구성 문서](https://learn.chatgpt.com/docs/config-file/config-reference)와
[Claude Code MCP 문서](https://code.claude.com/docs/en/mcp)를 기준으로 하며,
로컬 Codex CLI 0.160.1·Claude Code 2.1.294의 CLI 도움말에서도 옵션을 확인했다.

Cursor와 Kiro IDE는 아래 사용자 설정 파일의 `mcpServers`에 `cygnus` 항목을 병합한다.
이미 있는 다른 서버 항목을 덮어쓰지 않는다.

| 클라이언트 | macOS | Windows |
| --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| Kiro IDE | `~/.kiro/settings/mcp.json` | `%USERPROFILE%\.kiro\settings\mcp.json` |

Kiro는 명령 팔레트의 **Kiro: Open user MCP config (JSON)**으로도 열 수 있다.
복사한 JSON은 URL과 Authorization 헤더의 실제 토큰을 포함하므로 개인 설정에만 저장하고
공유 저장소에 넣지 않는다. Kiro의 `autoApprove`는 빈 배열로 유지한다.
[Cursor 설정 문서](https://cursor.com/docs/mcp) ·
[Kiro 설정 문서](https://kiro.dev/docs/mcp/configuration/)

MCP를 중지하고 다시 시작하면 토큰이 바뀌며, 포트 0을 사용하면 URL도 바뀔 수 있다.
새 명령어 또는 JSON을 복사해 갱신하고 클라이언트를 다시 연결한다.
이 안내는 같은 컴퓨터에서 실행하는 클라이언트용이다. 원격 개발 환경·컨테이너·WSL 등은
`127.0.0.1`이 Cygnus를 실행한 컴퓨터를 가리키는지 별도로 확인해야 한다.

## 제공 도구

| 도구 | 인자 | 동작 |
| --- | --- | --- |
| `cygnus_list_servers` | `{}` | 선택한 SSH 프로필의 ID·이름·주소·그룹·환경 조회 |
| `cygnus_execute` | `profile_id`, `command`, 선택적 `timeout_seconds`, `output_limit_bytes` | 명령을 제출하고 `job_id` 반환. 실행 허용 시에만 제공 |
| `cygnus_get_job` | `job_id` | 상태·stdout·stderr·종료 코드·결과 불확실 여부 조회 |
| `cygnus_list_jobs` | 선택적 `limit`, `offset` | 현재 MCP 연결에서 시작한 작업 요약 조회. 최신순, 기본 50개, 최대 100개 |
| `cygnus_cancel_job` | `job_id` | 취소 요청. 실행 허용 시에만 제공 |

실행 예시:

```text
cygnus_list_servers({})
cygnus_execute({"profile_id": 42, "command": "uname -a", "timeout_seconds": 30})
→ {"job_id": "..."}
cygnus_get_job({"job_id": "..."})
→ {"status": "succeeded", "exit_code": 0, "stdout": "...", ...}
```

명령은 터미널 탭과 독립된 exec 채널에서 실행한다. 현재 터미널의 디렉터리나 환경변수를
이어받지 않는다. 자세한 실행 규칙, 출력 한도, 취소와 기록 동작은
[공용 SSH 실행 API](execution-engine.md)를 참고한다.

현재 MCP에는 SFTP 파일 조회·전송 도구와 여러 서버에 한 번에 실행하는 도구는 포함되지 않는다.

## 접근 범위와 수명

- `127.0.0.1`에만 수신한다. 모든 MCP 요청에 256비트 무작위 토큰 인증을 요구한다.
  Host는 해당 로컬 포트로 제한하고, 브라우저 Origin이 있는 요청은 거부한다.
- 공유할 서버와 실행 허용 여부를 바꾸려면 중지 후 다시 시작한다.
  접근 범위는 선택한 프로필 ID를 기준으로 하므로, 프로필 편집은 이후 접속 대상에도 반영된다.
- 토큰과 허용 범위는 디스크에 저장하지 않는다. 앱을 다시 실행하면 MCP는 꺼져 있다.
  MCP를 중지하고 다시 켤 때마다 새 토큰을 생성하므로 클라이언트 토큰도 갱신한다.
- 서버 조회에 비밀번호·개인키 경로·Jump Host 자격 증명을 포함하지 않는다.
  명령과 원격 출력에 포함된 비밀 값을 자동 제거하지는 않는다.
- MCP는 **현재 활성화에서 자신이 시작한 작업만** 조회·취소할 수 있다.
  이전 활성화나 다른 경로에서 만든 작업 기록은 이 토큰으로 읽을 수 없다.
- **Stop MCP**는 토큰 접근을 폐기하고 이 활성화에서 시작한 작업에 취소를 요청한다.
  실제 원격 프로세스 종료는 보장하지 않는다. `remote_outcome_unknown`이 참인 결과나
  응답을 받지 못한 실행 요청은 자동 재시도하지 않는다.
- MCP 연결이 일시적으로 끊겨도 제출된 작업은 계속된다. Cygnus 앱 자체가 종료되면
  결과 관리도 중단된다. 저장을 켠 경우에만 다음 실행에서 미완료 기록을 `interrupted`로 복구한다.
- Settings → Data → Execution history에서 작업 기록 저장·보관 기간·삭제를 관리한다.
  새 설치는 디스크 저장 꺼짐이며, 저장하지 않은 완료 결과는 최대 15분·32개·64 MiB의
  메모리 캐시에서만 조회할 수 있다. 결과가 만료·삭제되면 목록에서 빠지고 개별 조회는
  오류를 반환한다. 결과 없음은 원격 실행 실패나 미실행을 뜻하지 않는다.
- HTTP 요청 본문은 최대 128 KiB, 동시 요청은 32개, 활성화당 작업은 최대 1000개다.
  실행 엔진의 동시 작업 한도 16개와 출력·시간 제한도 함께 적용된다.

## 구현과 검증

공식 [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)의 Streamable HTTP
서버를 사용한다. JSON 응답과 stateless 모드로 구성하고, 공유 프로필·실행 권한·작업
소유권은 도구 구현에서도 검사한다. UI 설정은 Tauri IPC로만 변경할 수 있다.

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests
cargo test --manifest-path src-tauri/Cargo.toml
bun run build
bun run test
```

테스트는 임시 로컬 HTTP·SSH 서버와 메모리 DB를 사용한다. 공식 SDK 클라이언트와의
연결·SSH 결과 조회, 2025-11-25 프로토콜 초기화, 인증·Host·Origin 검증, 읽기 전용 권한,
프로필·작업 접근 범위, 키체인 잠금 오류, 중지·취소·토큰 교체를 확인한다.
실제 사용자의 SSH 서버나 키체인을 사용하지 않는다.
