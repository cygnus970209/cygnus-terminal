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
  결과 관리도 중단되고 다음 실행에서 미완료 기록을 `interrupted`로 복구한다.
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
