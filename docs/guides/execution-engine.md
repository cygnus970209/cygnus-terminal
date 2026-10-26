# SSH 공용 실행 기반

MCP와 멀티 서버 관리에서 함께 사용할 단일 서버 작업 API다. 현재는 Rust 서비스와
Tauri IPC, TypeScript 호출 함수를 제공한다. 외부 AI 도구용 어댑터는
[Cygnus MCP](mcp.md)에서 이 API를 사용한다. 별도의 실행 관리 화면은 아직 없다.

## 호출하기

`src/services/executionService.ts`를 사용한다. 키체인 접근이 필요하면 기존
`secureInvoke`의 안내·승인·재시도 흐름을 사용한다. 승인 전에는 작업을 생성하거나
서버에 연결하지 않으므로 키체인 재시도가 명령을 중복 실행하지 않는다.

```ts
import {
  startExecution,
  getExecution,
  listExecutions,
  cancelExecution,
} from "../../src/services/executionService";

const jobId = await startExecution({
  profile_id: 42,
  command: "uname -a",
  timeout_seconds: 120,
  output_limit_bytes: 1024 * 1024,
});

const job = await getExecution(jobId); // 진행 중에도 현재 stdout/stderr 조회 가능
const recent = await listExecutions(50, 0); // 출력 본문 없는 요약, 최신순
await cancelExecution(jobId); // 완료된 작업에는 아무 동작도 하지 않음
```

`getExecution`의 결과는 한 시점의 전체 스냅샷이다. 완료까지 일정 간격으로 조회한다.
각 호출이 비동기 작업 ID를 반환하며, 네트워크 연결 실패나 명령 실패는 작업 결과로
기록된다. 입력 검증, 프로필 조회, 자격 증명 복호화, 초기 기록 저장 실패는 제출 오류다.

| Tauri 명령 | 인자 | 반환 |
| --- | --- | --- |
| `execution_start` | `{ req: { profile_id, command, timeout_seconds?, output_limit_bytes? } }` | 작업 ID |
| `execution_get` | `{ jobId }` | `ExecutionJob` |
| `execution_list` | `{ limit?, offset? }` | `ExecutionSummary[]` |
| `execution_cancel` | `{ jobId }` | 없음 |
| `execution_history_settings` | 없음 | `{ enabled, retention_days }` |
| `execution_history_update` | `{ settings: { enabled, retention_days } }` | 없음 |
| `execution_history_clear` | 없음 | 없음 |

Rust에서 직접 사용하는 경우 `ExecutionManager::start/get/list/cancel`을 호출한다.
Manager는 앱 시작 시 한 번 생성하고 이후 `clone`으로 공유한다. `new`는 이전 실행의
미완료 기록을 복구하므로 작업 중에 다시 생성하지 않는다.

## 실행 규칙

- 저장된 SSH 프로필의 비밀번호 또는 키 파일 인증과 Jump Host를 사용한다.
  자격 증명은 Rust에서 해결하며, API 요청·응답·작업 기록에 연결 비밀번호나
  Jump Host 비밀번호를 포함하지 않는다.
- 대상과 Jump Host 모두 기존 `known_hosts` 검증을 통과해야 한다. 처음 접속하는
  서버는 기존 터미널 연결에서 호스트 키를 확인한 후 실행한다. 자동 실행은
  새 키를 승인하거나 변경된 키를 덮어쓰지 않는다.
- 작업마다 전용 SSH 연결과 exec 채널을 갖는다. 로컬 `execution_start`는 비대화형이다.
  MCP의 `cygnus_execute`는 전용 터미널 탭 연결을 기다린 뒤 PTY를 요청한다.
  모니터를 연결하지 못하거나 서버가 PTY를 거부하면 명령을 실행하지 않는다.
  같은 서버의 완료된 탭은 재사용하고 동시 실행에는 별도 탭을 사용한다.
- 명령은 원문 그대로 서버의 SSH exec에 전달한다. 기존 터미널의 `cd`, 환경변수,
  활성화된 가상환경을 상속하지 않는다. 필요하면 명령 자체에 `cd ... && ...` 등을
  포함한다. 비대화형 작업은 stdin을 즉시 EOF 처리하고 MCP 작업은 사람의 입력을 받는다.
- 자동화 연결에는 agent forwarding을 요청하지 않는다. MCP 탭에서는 `sudo` 등
  로그인 후 프로그램에 직접 입력할 수 있다. SSH 로그인·개인키 잠금 해제는 기존 인증을 사용한다.
  프롬프트를 감지하면 Vault 선택창을 열며 저장된 항목 선택 또는 저장 없는 일회성 입력을 지원한다.
  `vault_inject({ jobId, vaultItemId })`는 메인 창에서만 사용하며, 연결된 실행 중 작업인지
  확인한 뒤 Rust에서 복호화한다. 일반 SSH 세션용 `sessionId`와 동시에 지정할 수 없다.
  키보드·일회성 입력·Vault 전송 모두 입력을 큐에 넣기 전에 `output_withheld`를 설정하고
  이후 출력은 로컬 화면에만 전달한다.
  입력과 이후 출력은 MCP 결과·메모리 결과 캐시·실행기록에 남기지 않는다.
  탭 종료 또는 Stop은 해당 작업에 취소를 요청한다. 수동 입력용 MCP 도구는 없다.
- 동시 작업은 최대 16개다. 초과 제출은 오류이며, 대기 큐와 자동 재시도는 없다.
- 기본 제한 시간은 120초이며 1~3600초를 지정할 수 있다. 연결·인증·채널 열기·실행을
  포함하며 MCP 탭 연결 대기 시간도 포함한다. 타임아웃/취소 후 채널 정리는 추가로 최대 2초 기다린다.
- stdout와 stderr는 합산 기본 1 MiB, 최대 4 MiB의 원시 바이트를 보관한다.
  초과 출력도 계속 읽어 종료 코드 수신을 막지 않으며 `output_truncated`로 알린다.
  UTF-8 패킷 분할을 보존하고, 잘못된 UTF-8은 조회 시 대체 문자로 표시한다.
- 명령은 최대 64 KiB이며 빈 명령과 NUL은 거부한다.

## 상태와 결과

상태는 `connecting → running → succeeded/failed`로 진행한다.
취소 중에는 `cancelling`이며 최종적으로 `cancelled`가 된다.
기한 초과는 `timed_out`, 앱 재시작 시 이전 미완료 기록은 `interrupted`다.

`exit_code == 0`인 종료 결과를 받아야 성공이다. EOF는 출력 종료일 뿐이므로 그 뒤의
종료 코드도 기다린다. 비정상 종료 코드는 `failed`, 시그널 종료는 `failed`와
`exit_signal`로 기록한다. 종료 결과 없이 채널이 닫히면 성공으로 간주하지 않는다.

`remote_outcome_unknown`은 상태와 별개다. exec 요청이 전송될 수 있는 시점부터
참이며, 종료 코드·시그널 또는 exec 거부를 확인하면 거짓으로 바뀐다.
취소와 타임아웃은 TERM 및 채널 닫기를 최선의 노력으로 요청할 뿐, 서버의 프로세스나
그 자식 프로세스가 종료됐음을 보장하지 않는다. 결과가 불명확한 작업은 자동 재실행하지 않는다.

## 기록과 수명

**Settings → Data → Execution history**에서 저장 여부, 보관 기간(1~365일), 기록 삭제를
관리한다. 이 정책은 MCP와 공용 실행 엔진의 작업에 적용하며, 기존 터미널의 명령
히스토리(`command_history`)는 별도다. MCP 클라이언트에는 정책 변경·기록 삭제 도구를 제공하지 않는다.

- 새 설치는 **디스크 저장 꺼짐**, 저장을 켤 때의 기본 보관 기간은 **7일**이다.
  스키마 v9로 업그레이드할 때 기존 작업 기록이 있으면 저장 켜짐·7일로 초기화한다.
  그 이전의 완료 기록은 만료되므로 필요하다면 업그레이드 전에 별도 보관한다.
- 저장하지 않는 작업은 진행 상태·출력을 메모리에서 조회한다. 완료 후 최대 **15분**,
  **32개**, 명령·결과 문자열 기준 **64 MiB**까지만 유지하고 오래된 결과부터 제거한다.
  실제 프로세스 메모리 사용량의 상한을 뜻하지는 않는다. 앱을 닫으면 결과는 사라지고,
  재시작 시 복구할 기록도 없다. 진행 중인 작업에는 이 캐시 만료를 적용하지 않는다.
- 저장을 켜면 이후 제출한 작업을 SQLite `execution_jobs`에 제출·명령 전송 직전·완료
  시점에 저장한다. 프로필 이름·주소·사용자·환경은 스냅샷이다. 진행 출력은 메모리에
  있으므로 강제 종료하면 일부 출력이 유실될 수 있다. 다음 시작에서 저장된 미완료
  상태를 `interrupted`로 바꾸고 명령은 재전송하지 않는다.
- 보관 기간은 제출 시각 기준이다. 완료 기록은 만료 즉시 조회에서 제외하며, 앱 시작,
  정책 변경, 실행 중 매분 정리한다. 실행 중인 작업은 기간 만료만으로 삭제하지 않는다.
  앱이 닫힌 동안에는 정리하지 않으며 다음 시작 때 처리한다.
- 저장 끄기 또는 **Delete execution history**는 디스크 기록과 완료된 메모리 결과를
  삭제한다. 실행 중 작업은 계속 조회·취소할 수 있지만 이후 완료 결과를 디스크에
  다시 저장하지 않는다. 저장을 다시 켜도 해당 작업에 소급 적용하지 않는다.
  명시적 삭제는 저장 설정 자체를 바꾸지 않으므로 새 작업에는 기존 설정이 적용된다.
- `execution_list`는 메모리·디스크 요약을 합쳐 최신순으로 페이지를 구성하며 출력
  본문을 읽지 않는다. limit은 1~100, 기본 50이다. 만료·삭제·존재하지 않는 ID는
  `LookupError::NotFound`로 구분하며 IPC/MCP에서는 설명 문자열을 반환한다.
  MCP 목록은 없어진 결과를 건너뛰지만 손상된 레코드나 DB 오류는 숨기지 않는다.
  **결과가 없어졌다는 이유로 명령을 자동 재실행하면 안 된다.**

저장 켜짐 상태에서 완료 기록 쓰기에 실패하면 `persistence_error`와 결과를 메모리에
유지한다. 이 예외 상태는 재시작 후 복원되지 않을 수 있고 기존처럼 동시 작업 한도를
차지한다. 저장 끄기·삭제 시 해당 메모리 결과도 제거한다.

연결 자격 증명은 기록하지 않지만, 저장을 켜면 **명령과 원격 출력은 암호화하지 않은
SQLite에 저장**된다. 원격 출력에 포함된 비밀 값을 자동 탐지·제거하지 않는다.

macOS/Linux에서는 앱 데이터 폴더를 `0700`, DB 및 기존 WAL/SHM/journal 파일을 `0600`으로
제한한 뒤 DB를 연다. 신규 보조 파일도 DB 권한을 따르는지 테스트한다. 해당 DB 경로의
심볼릭 링크는 거부한다. Windows에서는 사용자 앱 데이터 폴더의 기존 ACL을 상속하며,
이번 변경에서 Windows ACL을 별도로 재설정하지는 않는다.

삭제에는 SQLite [`secure_delete=ON`](https://www.sqlite.org/pragma.html#pragma_secure_delete)과
[`wal_checkpoint(TRUNCATE)`](https://www.sqlite.org/pragma.html#pragma_wal_checkpoint)를 사용한다.
다른 DB 독자가 WAL 정리를 막으면 변경 자체는 반영될 수 있으며 UI에 정리 오류를 표시하고
주기적 정리에서 재시도한다. 백업, 파일시스템 스냅샷, 이전 복사본, OS 스왑이나 디스크의
물리적 흔적까지 지우는 보안 삭제 보장은 아니다.

## 검증

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib execution::tests
cargo test --manifest-path src-tauri/Cargo.toml
bun run build
bun run test
```

실행 테스트는 로컬 임시 포트의 russh 테스트 서버와 메모리 SQLite를 사용한다.
실제 저장된 서버나 OS 키체인에 접근하지 않는다. 정상/비정상 종료, EOF 순서,
stdout/stderr, UTF-8 분할, 출력 제한, 취소·타임아웃, 신뢰되지 않은 키·변경된 키,
인증 실패, Jump Host와 재시작 기록 복구를 검증한다. 기록 저장 전환·삭제 중 실행 완료,
만료·캐시 제한·페이지 정렬, 파일 권한, DB 페이지/WAL 정리와 외부 독자에 의한 정리
지연도 임시 DB와 합성 데이터로 확인한다.
