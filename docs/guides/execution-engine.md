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
- 작업마다 전용 SSH 연결과 exec 채널을 갖는다. 터미널 탭·PTY·대화형 입력을
  만들지 않으며, 기존 탭을 닫아도 작업 연결에 영향을 주지 않는다.
- 명령은 원문 그대로 서버의 SSH exec에 전달한다. 기존 터미널의 `cd`, 환경변수,
  활성화된 가상환경을 상속하지 않는다. 필요하면 명령 자체에 `cd ... && ...` 등을
  포함한다. stdin은 즉시 EOF 처리한다.
- 자동화 연결에는 agent forwarding을 요청하지 않는다. 비밀번호 입력을 요구하는
  `sudo`나 암호화된 개인키의 대화형 잠금 해제는 이 API에서 지원하지 않는다.
- 동시 작업은 최대 16개다. 초과 제출은 오류이며, 대기 큐와 자동 재시도는 없다.
- 기본 제한 시간은 120초이며 1~3600초를 지정할 수 있다. 연결·인증·채널 열기·실행을
  포함한다. 타임아웃/취소 후 채널 정리는 추가로 최대 2초 기다린다.
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

스키마 v8의 `execution_jobs`에 제출 시점, 명령 전송 직전, 완료 시점의 기록을 저장한다.
프로필 이름·주소·사용자·환경은 스냅샷이므로 프로필 변경이나 삭제 후에도 기록이 유지된다.
`execution_list`는 출력 본문을 읽지 않으며 limit은 1~100, 기본 50이다.

진행 중 출력은 메모리에 있고 완료 시 SQLite에 저장된다. 앱이 강제 종료되면 마지막
진행 출력은 잃을 수 있다. 다음 시작에서 미완료 상태를 `interrupted`로 바꾸고 명령을
재전송하지 않는다. 앱 종료 이후 작업을 계속 관리하는 상주 데몬은 아직 없다.

완료 기록 저장에 실패하면 결과를 메모리에 유지하고 `persistence_error`에 오류를
표시한다. 그 기록은 재시작 후 복원되지 않을 수 있고 동시 작업 한도를 계속 차지한다.

연결 자격 증명은 저장하지 않지만 **사용자가 지정한 명령과 원격 출력은 일반 SQLite
작업 기록에 저장**된다. 원격 출력에 포함된 비밀 값을 자동 탐지·제거하는 기능은 없다.
현재 기록 만료·삭제 UI도 없으므로 장기 운영 전 보관 정책을 추가해야 한다.

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
인증 실패, Jump Host와 재시작 기록 복구를 검증한다.
