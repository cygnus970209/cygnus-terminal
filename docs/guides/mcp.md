# Cygnus MCP

Cygnus를 실행 중인 컴퓨터의 AI 클라이언트에서 저장된 SSH 서버를 조회하고 명령 실행과 SFTP 파일 작업을 할 수 있다.
MCP는 기본적으로 꺼져 있으며 **Settings → MCP**에서 직접 켠다.

## 보안 및 개인정보 주의사항

- **저장된 SSH 비밀번호는 MCP 응답으로 제공하지 않는다.** 사용자 컴퓨터의 Cygnus가
  비밀번호를 복호화해 대상 SSH 서버 인증에 사용한다. AI 클라이언트는 프로필 ID로 작업을 요청한다.
- **명령 출력과 읽은 파일 내용은 AI 서비스로 전송되거나 클라이언트 기록에 저장될 수 있다.**
  `.env`, 로그 등에 포함된 비밀번호·API 키·개인정보는 자동으로 마스킹하지 않는다.
  MCP가 로컬 주소에서만 수신한다는 것이 응답 데이터도 컴퓨터 안에만 남는다는 뜻은 아니다.
- **명령 실행을 허용하면 AI 클라이언트는 해당 SSH 계정의 권한으로 작업할 수 있다.**
  SFTP 권한을 꺼도 셸 명령으로 파일을 읽거나 변경·삭제할 수 있다.
  필요한 서버와 권한만 공유한다.

Settings → MCP에서 위 주의사항에 **동의해야 MCP를 시작할 수 있다.**
동의 여부는 현재 활성화에만 적용하며, 중지 후 다시 시작할 때는 다시 체크해야 한다.
실행 중에는 **Stop MCP**로 접근을 중단한다. OAuth 승인 자체를 철회하려면
**Authorized clients → Revoke access**를 누른다. 백엔드도 동의가 없거나 거부된 시작 요청을 차단한다.

## 연결하기

1. Connections에 SSH 프로필을 저장하고, 터미널로 한 번 접속해 호스트 키를 확인한다.
   Jump Host를 사용하면 경유 서버와 대상 서버 모두 신뢰된 키가 필요하다.
2. Settings → MCP에서 공유할 SSH 서버를 선택한다. 이름·주소·계정·그룹 검색, 그룹 필터와 **Selected only**로 대상을 좁힐 수 있다. **Select shown / Clear shown**은 현재 보이는 서버만 변경하며 숨겨진 선택은 유지한다. 실행 중에는 검색만 가능하고, 공유 대상을 바꾸려면 먼저 **Stop MCP**를 누른다. 기본 포트는 `38473`이다.
   다른 앱이 사용 중이면 포트를 바꾸거나 `0`으로 설정해 빈 포트를 배정받는다.
3. 서버 조회만 필요하면 **Allow remote command execution**을 끈다.
   켜면 해당 SSH 계정이 허용하는 임의 명령을 AI 클라이언트가 실행할 수 있다.
   파일 조회는 **Allow SFTP file reading**, 파일 변경은 **Allow SFTP file changes**로
   별도 허용한다. 둘 다 기본 꺼짐이며, 파일 변경은 파일 조회를 함께 켜야 한다.
   명령 실행을 켜면 SFTP 설정과 관계없이 셸 명령으로 파일에 접근할 수 있다.
4. 보안·개인정보 주의사항을 읽고 동의 체크박스를 선택한 뒤 **Start MCP**를 누른다.
   하단 **Connect an AI client → App approval (OAuth · Beta)**에서 클라이언트를 선택하고
   URL만 포함한 등록 내용을 복사한다. 클라이언트에서 인증을 시작한 뒤 Cygnus에서 승인한다.
5. 저장된 비밀번호를 사용하는 작업에서 잠금 해제 오류가 나오면
   **Unlock saved credentials**를 누른다. 기존 Cygnus 키체인 안내와 OS 권한 절차를
   거쳐 잠금이 해제된다. MCP 요청 자체가 OS 키체인 접근을 승인하지는 않는다.

이 버전은 로컬 클라이언트의 HTTP 연결을 지원한다. stdio 전용 클라이언트, 브라우저에서
MCP 도구를 직접 호출하는 클라이언트, 클라우드에서 사용자의 컴퓨터로 연결하는 중계 서비스는 포함하지 않는다.
OAuth 승인 안내·복귀 페이지는 브라우저로 열 수 있지만 도구 호출과 앱의 승인 IPC는 노출하지 않는다.

## 클라이언트별 빠른 등록

### OAuth 앱 승인 (Beta, 기본)

1. 클라이언트에 URL만 등록한다. 기존 수동 `Authorization` 헤더·환경변수 참조는 제거한다.
   Claude Code는 헤더 인증이 설정되어 있으면 실패해도 OAuth로 전환하지 않는다.
2. Claude Code는 `/mcp`에서 `cygnus`를 선택해 인증한다. Codex는 등록 시 인증이 시작되지
   않으면 `codex mcp login cygnus`를 실행한다. Cursor·Kiro는 MCP 연결의 인증 동작을 사용한다.
3. 브라우저에 표시된 8자리 확인 코드를 확인하고 Cygnus의 **Review connection** 알림을 연다.
   클라이언트가 보낸 이름은 검증된 신원이 아니므로, 본인이 시작한 브라우저의 코드와
   반드시 비교한다. 공유 서버·권한을 확인하고 체크한 뒤 **Approve connection**을 누른다.
4. 브라우저가 클라이언트의 로컬 콜백으로 돌아가면 인증이 완료된다. 요청은 5분 뒤 만료되며,
   거절·만료된 요청은 클라이언트에서 다시 인증한다. 앱의 터미널 입력 포커스는 알림이 빼앗지 않는다.

등록 명령 예시:

```sh
codex mcp add cygnus --url 'http://127.0.0.1:38473/mcp'
```

```sh
claude mcp add --transport http --scope user cygnus 'http://127.0.0.1:38473/mcp'
```

기존 `cygnus`가 있으면 먼저 `codex mcp remove cygnus` 또는
`claude mcp remove --scope user cygnus`로 해당 항목만 제거한다.
Cursor 데스크톱용 JSON에는 공개 클라이언트 ID `cygnus-cursor-desktop`이 들어간다.
이 ID는 비밀값이 아니며 `http://localhost:8787/callback`만 허용해 클라우드 콜백으로
로컬 인증 코드를 보내지 않는다. Kiro는 동적 클라이언트 등록과 `cygnus` scope를 사용한다.

접근 토큰은 15분, 갱신 권한은 마지막 발급·갱신 후 90일 동안 유효하다. 클라이언트가
갱신 토큰으로 자동 갱신하므로 설정을 다시 복사할 필요가 없다. 갱신 토큰은 매번 교체하며,
사용한 토큰의 재사용이 감지되면 해당 승인을 철회한다. 앱에는 원문 토큰 대신 무작위
256비트 갱신 토큰의 SHA-256 해시와 승인 범위만 저장한다. 원문 토큰 보관은 클라이언트가 담당한다.

MCP 중지·앱 종료는 활성 요청을 취소하고 수신을 멈추지만 OAuth 승인은 보존한다.
다시 시작할 때는 보안 동의가 필요하다. 이전 포트·공유 설정을 불러오며 자동으로 시작하지 않는다.
같은 포트를 유지해야 기존 OAuth 연결을 재사용할 수 있다. 포트를 바꾸면 새 URL에서 다시 인증한다.
설정에서 권한을 늘려도 기존 승인에는 자동 적용되지 않는다. 기존 승인의 범위와 현재 공유
설정이 겹치는 권한만 허용하며, 추가 권한이 필요하면 다시 인증하고 승인한다.

**Authorized clients → Revoke access**는 선택한 승인의 토큰을 무효화하고 그 승인이
시작한 작업에 취소를 요청한다. 다른 클라이언트의 승인·실행 기록은 분리된다.
공식 MCP TypeScript SDK로 전체 인증·자동 갱신·도구 연결을 검증했다. 개별 IDE의 실제
OS 브라우저 복귀는 추가 실사용 검증이 필요한 Beta이며, 호환 문제가 있으면 수동 방식을 사용할 수 있다.

[MCP 인증 사양](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) ·
[Claude Code OAuth](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers) ·
[OpenAI 공식 MCP 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)

### 수동 Bearer 토큰 (호환용)

Settings → MCP 하단의 **Connect an AI client**에서 Codex CLI, Claude Code,
Cursor, Kiro IDE를 선택하고 **Authentication → Manual bearer token**으로 전환한다.
MCP를 시작하면 현재 URL과 토큰을 반영한 내용을 복사할 수 있다.
Windows는 PowerShell, macOS는 zsh/bash 문법과 사용자 설정 경로를 자동으로 표시한다.
화면의 `<BEARER_TOKEN>`은 미리보기용이며 복사 버튼은 실제 토큰을 넣는다.
환경변수 설정이나 `${...}` 치환은 필요하지 않다.

Codex의 **Copy TOML**은 `http_headers.Authorization`에 실제 토큰이 들어간
`[mcp_servers.cygnus]` 설정을 복사한다. 아래 사용자 설정 파일에서 기존 `cygnus`
항목과 하위 헤더 설정을 교체하거나, 없으면 추가한다. 예전에 등록한
`bearer_token_env_var`와 `env_http_headers` 등 환경변수 참조는 해당 서버에서 제거한다.
다른 서버·사용자 설정은 보존하고, 저장한 뒤 Codex를 다시 시작한다.
Codex 구성 디렉터리를 별도로 지정한 경우에는 그 디렉터리의 `config.toml`을 수정한다.

Claude Code의 **Copy command**는 `--transport http --scope user`와 실제
`Authorization: Bearer …` 헤더를 포함한 등록 명령어를 복사한다.
설치된 Claude Code CLI가 있는 **이 컴퓨터의 터미널**에 붙여넣는다.
이미 `cygnus`를 등록했다면 `claude mcp remove --scope user cygnus`를 먼저 실행하고
새 명령어로 다시 등록한다. 등록 후 클라이언트를 다시 연결한다.
같은 터미널에서 시작하거나 새 터미널마다 토큰을 설정할 필요는 없다.
토큰은 사용자 설정에 평문으로 저장되고 명령어는 셸 히스토리에도 남을 수 있다.
[OpenAI MCP 구성 문서](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)와
[Claude Code MCP 문서](https://code.claude.com/docs/en/mcp)를 참고한다.
로컬 Codex CLI 0.163.0·Claude Code 2.1.310의 CLI 도움말에서도 지원 옵션을 확인했다.

Cursor와 Kiro IDE는 아래 사용자 설정 파일의 `mcpServers`에 `cygnus` 항목을 병합한다.
이미 있는 다른 서버 항목을 덮어쓰지 않는다.

| 클라이언트 | macOS | Windows |
| --- | --- | --- |
| Codex | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` |
| Cursor | `~/.cursor/mcp.json` | `%USERPROFILE%\.cursor\mcp.json` |
| Kiro IDE | `~/.kiro/settings/mcp.json` | `%USERPROFILE%\.kiro\settings\mcp.json` |

Kiro는 명령 팔레트의 **Kiro: Open user MCP config (JSON)**으로도 열 수 있다.
복사한 TOML·JSON은 URL과 Authorization 헤더의 실제 토큰을 포함하므로 개인 설정에만 저장하고
공유 저장소에 넣지 않는다. Kiro의 `autoApprove`는 빈 배열로 유지한다.
[Cursor 설정 문서](https://cursor.com/docs/mcp) ·
[Kiro 설정 문서](https://kiro.dev/docs/mcp/configuration/)

수동 방식은 MCP를 중지하고 다시 시작하면 토큰이 바뀌며, 포트 0을 사용하면 URL도 바뀔 수 있다.
선택한 클라이언트는 그대로 유지된다. 새 TOML·명령어·JSON을 복사해 이전 설정을 교체하고
클라이언트를 다시 연결한다. 이전 토큰이 들어간 설정은 재시작 후 사용할 수 없다.
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
| `cygnus_sftp_list` | `profile_id`, `path`, 선택적 `limit` | 디렉터리 목록. 기본 100개, 최대 500개·64KiB, 초과 시 `truncated: true` |
| `cygnus_sftp_stat` | `profile_id`, `path` | 크기·종류·권한·수정 시각. 마지막 심볼릭 링크는 따라가지 않음 |
| `cygnus_sftp_read` | `profile_id`, `path`, 선택적 `offset`, `max_bytes`, `encoding` | 일반 파일 읽기. 기본 16KiB, 최대 64KiB, UTF-8 또는 base64 |
| `cygnus_sftp_write` | `profile_id`, `path`, `content`, 선택적 `encoding`, `overwrite` | 최대 64KiB 파일 생성. 기본 덮어쓰기 금지, 명시적 `overwrite: true`로 교체 |
| `cygnus_sftp_mkdir` | `profile_id`, `path` | 폴더 하나 생성. 부모 폴더는 있어야 함 |
| `cygnus_sftp_rename` | `profile_id`, `old_path`, `new_path` | 파일·폴더 이름 변경. 대상 경로가 이미 있으면 실패 |
| `cygnus_sftp_remove` | `profile_id`, `path`, 선택적 `directory` | 파일·링크 삭제. `directory: true`는 빈 폴더만 삭제 |

실행 예시:

```text
cygnus_list_servers({})
cygnus_execute({"profile_id": 42, "command": "uname -a", "timeout_seconds": 30})
→ {"job_id": "..."}
cygnus_get_job({"job_id": "..."})
→ {"status": "succeeded", "exit_code": 0, "stdout": "...", ...}
```

명령을 제출하면 **MCP 전용 터미널 탭이 자동으로 열린다.** 같은 서버의 완료된 탭은
재사용하며 이전 명령과 출력은 스크롤백에 남는다. 같은 서버에 이미 실행 중인 작업이
있으면 별도 탭을 열어 입력과 출력이 섞이지 않게 한다. 사용 중인 탭이 있으면 새 탭으로
포커스를 옮기지 않아 입력 중인 비밀번호가 다른 작업으로 전달되지 않는다.
탭 고정과 F10도 그대로 사용한다.

명령은 로컬 탭이 연결된 뒤 실제 SSH PTY에서 실행한다. 탭에서 키보드 입력과 Ctrl+C를
전달할 수 있으므로 `sudo` 등의 비밀번호는 채팅이나 도구 인자 대신 **Cygnus 탭에 직접 입력**한다.
활성 MCP 탭에서 `sudo`/`Password:` 프롬프트가 감지되면 Vault 선택창이 열린다.
저장된 항목을 직접 선택하거나 **직접 입력 → 전송**으로 저장 없이 한 번 입력할 수 있다.
Esc로 선택창을 닫으면 터미널에 바로 입력할 수도 있다. 자동 감지되지 않는 프롬프트는
탭 상단의 **Password / Vault** 버튼을 사용한다. 감지 규칙은 기존 Vault 프롬프트 설정을 따른다.
비활성 탭의 프롬프트는 탭을 선택했을 때 표시하며, 탭을 바꾸거나 작업이 끝나면 입력창의
임시 비밀번호를 버린다. 비밀번호 입력 대기에도 작업의 제한 시간이 적용된다.

Vault 항목은 사용자 선택 후 Rust에서 복호화하여 해당 작업의 SSH 입력으로만 전송한다.
저장된 비밀번호 평문을 프론트엔드나 MCP로 반환하지 않으며, 자동 선택·자동 전송하지 않는다.
사람이 입력한 값은 MCP나 명령 히스토리에 보내지 않는다. 첫 입력 이후의 출력도
해당 작업이 끝날 때까지 AI 응답·실행기록에서 제외하며 `output_withheld: true`로 알린다.
서버가 입력값을 그대로 출력하더라도 로컬 터미널에서만 보인다. 이 보호는 이후 AI 명령이
원격 파일 등을 새로 읽는 것을 막는 접근 제어는 아니다.

실행 중 탭을 닫거나 탭의 **Stop**을 누르면 취소를 요청한다. **Stop MCP**는 전체 작업에
취소를 요청한다. 원격 프로세스 종료와 이미 수행된 변경의 취소를 보장하지 않는다.
탭을 재사용해도 작업마다 별도 SSH 연결·exec 채널이므로 다른 명령의 디렉터리나
환경변수를 이어받지 않는다. 저장된 자격 증명을 통한 SSH 로그인은 기존과 동일하며,
이 입력 기능은 로그인 후 실행된 프로그램용이다. 자세한 실행 규칙, 출력 한도, 취소와 기록 동작은
[공용 SSH 실행 API](execution-engine.md)를 참고한다.
PTY에서는 서버가 stdout와 stderr를 하나의 터미널 스트림으로 합칠 수 있다.

### SFTP 파일 작업

SFTP 도구는 작업 ID 대신 해당 요청의 결과를 바로 반환하며 터미널 탭 없이 접속한다.
조회 도구 3개는 파일 조회 허용 시, 변경 도구 4개는 파일 변경도 허용할 때 제공된다.
공유 프로필·권한 검사는 도구 목록뿐 아니라 실제 호출 시에도 적용한다.

```text
cygnus_sftp_list({"profile_id": 42, "path": "."})
cygnus_sftp_read({"profile_id": 42, "path": "/etc/nginx/nginx.conf"})
→ {"content": "...", "encoding": "utf8", "bytes_read": 123, "next_offset": 123, "eof": true, ...}
cygnus_sftp_write({"profile_id": 42, "path": "deploy-notes.txt", "content": "배포 확인\n"})
```

- 경로는 원격 SSH 계정 기준이다. `.`은 시작 디렉터리이며 보통 계정의 홈이다.
  `~`, `$VAR`, 와일드카드, 셸 구문은 확장하지 않는다. 로컬 파일 경로 인자는 없다.
  파일 내용·이름은 AI에게 지시하는 문장이 아닌 신뢰할 수 없는 데이터로 취급한다.
- 원격 접근 범위는 **선택한 SSH 계정의 파일 권한 전체**다. 특정 디렉터리로 제한하는
  샌드박스는 아니다. 읽기는 링크를 따라가므로 계정이 읽을 수 있는 비밀 파일도 노출될 수 있다.
- 읽기는 바이트 단위 `offset`·`max_bytes`를 받는다. `eof: false`면 `next_offset`으로
  이어서 읽을 수 있지만 호출 사이에 파일이 바뀔 수 있다. UTF-8 끝 문자가 잘리면 완성된
  문자까지만 반환한다. 바이너리 또는 문자 중간에서 읽을 때는 `encoding: "base64"`를 쓴다.
  목록은 서버 순서이며 `truncated: true`면 전체 목록이 아니다. 현재 목록 페이지 이어읽기는 없다.
- 쓰기는 요청에 들어온 내용으로 파일 전체를 생성·교체한다. 새 파일은 `0600`, 폴더는
  `0700`을 요청한다. 서버의 권한 정책에 따라 달라질 수 있다. 기본 생성은 SFTP EXCL을
  사용해 기존 파일·링크를 덮어쓰지 않는다. 명시적 덮어쓰기는 최종 링크·특수 파일을
  사전 검사하지만, 다른 프로세스가 동시에 경로를 바꾸는 것을 잠그지는 않는다.
- 덮어쓰기는 원자적 교체가 아니다. 실패·중지·응답 유실 시 빈 파일이나 일부 내용이 남을
  수 있으므로 **변경 요청을 자동 재시도하지 않는다**. 원격 경로를 먼저 확인한다.
  이름 변경은 [SFTP v3 RENAME](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.5)을
  사용한다. 재귀 삭제·서버 간 복사·대용량 로컬 업로드/다운로드는 이 도구에 포함하지 않는다.
  대용량 전송은 기존 SFTP 창을 사용한다.
- 요청마다 독립 SSH/SFTP 연결을 열고 정리한다. 최대 동시 4개, 전체 30초, 개별 SFTP
  응답 10초, 수신 패킷 256KiB 제한을 둔다. MCP를 중지하면 대기 중 요청도 취소한다.
  전송된 변경을 되돌리는 것은 아니며, 클라이언트 연결만 끊긴 경우에는 작업이 진행될 수 있다.
- SFTP 본문과 결과는 Cygnus의 명령 히스토리·실행기록 DB에 저장하지 않는다.
  연결한 AI 클라이언트는 응답 내용을 자체 대화 기록에 저장할 수 있다.

여러 서버에 한 번에 실행하는 도구는 아직 포함되지 않는다.

## 접근 범위와 수명

- `127.0.0.1`에만 수신한다. 모든 MCP 요청에 256비트 무작위 토큰 인증을 요구한다.
  Host는 해당 로컬 포트로 제한하고, 브라우저 Origin이 있는 요청은 거부한다.
  승인·대기 페이지는 브라우저가 보내는 Fetch Metadata도 검사하여 다른 사이트에서
  유도한 이동이나 이미지·프레임 요청을 차단한다. 인증은 클라이언트가 직접 연 브라우저에서
  시작한다. 관련 헤더를 보내지 않는 클라이언트에는 기존 Host·Origin·앱 승인 검사가 적용된다.
- 공유할 서버와 실행 허용 여부를 바꾸려면 중지 후 다시 시작한다.
  접근 범위는 선택한 프로필 ID를 기준으로 하므로, 프로필 편집은 이후 접속 대상에도 반영된다.
- 수동 토큰·OAuth 접근 토큰·일회용 코드는 메모리에만 보관한다. OAuth 갱신 토큰의
  해시·승인 범위·클라이언트 등록 정보·마지막 공유 설정은 사용자 전용 DB에 보관한다.
  앱을 다시 실행하면 MCP는 꺼져 있다. 수동 방식만 매번 새 토큰을 복사해야 한다.
- 서버 조회에 비밀번호·개인키 경로·Jump Host 자격 증명을 포함하지 않는다.
  명령과 원격 출력에 포함된 비밀 값을 자동 제거하지는 않는다.
- MCP는 **현재 활성화에서 같은 승인으로 시작한 작업만** 조회·취소할 수 있다.
  이전 활성화나 다른 경로에서 만든 작업 기록은 이 토큰으로 읽을 수 없다.
- **Stop MCP**는 현재 토큰 접근을 중단하고 이 활성화에서 시작한 작업에 취소를 요청한다.
  OAuth 승인과 갱신 권한은 유지되며, 영구 철회는 **Revoke access**로 처리한다.
  실제 원격 프로세스 종료는 보장하지 않는다. `remote_outcome_unknown`이 참인 결과나
  응답을 받지 못한 실행 요청은 자동 재시도하지 않는다.
- MCP 연결이 일시적으로 끊겨도 제출된 작업은 계속된다. Cygnus 앱 자체가 종료되면
  결과 관리도 중단된다. 저장을 켠 경우에만 다음 실행에서 미완료 기록을 `interrupted`로 복구한다.
- Settings → Data → Execution history에서 작업 기록 저장·보관 기간·삭제를 관리한다.
  새 설치는 디스크 저장 꺼짐이며, 저장하지 않은 완료 결과는 최대 15분·32개·64 MiB의
  메모리 캐시에서만 조회할 수 있다. 결과가 만료·삭제되면 목록에서 빠지고 개별 조회는
  오류를 반환한다. 결과 없음은 원격 실행 실패나 미실행을 뜻하지 않는다.
- MCP 요청 본문은 최대 128 KiB, 동시 요청은 32개, 승인별 활성화당 작업은 최대 1000개다.
  실행 엔진의 동시 작업 한도 16개와 출력·시간 제한도 함께 적용된다.
- OAuth 요청 본문은 최대 16 KiB, 동시 HTTP 요청은 16개·요청 시간은 15초,
  대기 승인은 8개, 저장된 승인은 최대 64개다.
  등록·승인·토큰 발급 요청에는 분당 제한을 적용한다. S256 PKCE, 등록된 로컬 콜백,
  일회용 코드, 리소스·클라이언트 결합을 검사하며 브라우저 요청으로 승인할 수 없다.
  동적 등록한 로컬 콜백은 [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3)에 따라
  재인증 시 포트 변경을 허용한다. 호스트·경로는 유지하고, 코드 교환 시에는 승인 요청의 정확한 URI를 요구한다.

## 구현과 검증

공식 [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)의 Streamable HTTP
서버를 사용한다. JSON 응답과 stateless 모드로 구성하고, 공유 프로필·실행 권한·작업
소유권은 도구 구현에서도 검사한다. UI 설정은 Tauri IPC로만 변경할 수 있다.

```sh
bun run rdp:build # Cargo를 직접 실행하기 전에 앱에 포함할 RDP 엔진 준비
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::tests
cargo test --manifest-path src-tauri/Cargo.toml --lib mcp::oauth::tests
cargo test --manifest-path src-tauri/Cargo.toml
bun run build
bun run test
```

테스트는 임시 로컬 HTTP·SSH 서버와 메모리 DB를 사용한다. 공식 SDK 클라이언트와의
연결·SSH 결과 조회, 2025-11-25 프로토콜 초기화, 인증·Host·Origin 검증, 읽기 전용 권한,
프로필·작업 접근 범위, 키체인 잠금 오류, 중지·취소·토큰 교체를 확인한다.

공식 TypeScript SDK가 로컬에 설치되어 있다면 다음 상호운용 테스트를 추가 실행할 수 있다.
사용자 클라이언트 설정은 수정하지 않으며 임시 서버와 메모리 자격 증명만 사용한다.

```sh
CYGNUS_QA_MCP_SDK=/path/to/node_modules/@modelcontextprotocol/sdk \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  mcp::oauth::tests::official_typescript_sdk_interoperability -- --ignored --nocapture
```
SFTP는 메모리 파일시스템을 가진 임시 SSH/SFTP 서버로 조회·읽기·쓰기·이름 변경·삭제,
권한 분리, 입력·응답 크기 제한, 덮어쓰기 방지, UTF-8 경계, 중지 중 대기 해제를 검증한다.
실제 사용자의 SSH 서버나 키체인을 사용하지 않는다.
