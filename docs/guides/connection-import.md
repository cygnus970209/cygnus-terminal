# Connection import / 접속 정보 가져오기

## 한국어

Connections 화면이나 접속 사이드바에서 **Import connections**를 선택합니다. 처음 실행해 서버가 없으면 **Import existing connections**도 표시됩니다.

1. 감지된 설정을 선택하거나 파일을 직접 선택합니다. Termius는 데이터 폴더를 선택합니다.
2. 서버 주소, 사용자, 포트, 그룹, 키 경로와 안내 메시지를 확인합니다.
3. 각 항목 오른쪽의 **Group** 셀렉트에서 기존 그룹 또는 **No group**을 선택할 수 있습니다. 기본값은 원본 그룹입니다. 가져올 항목을 선택하고 **Import**를 누릅니다. 기존 접속 정보는 덮어쓰지 않습니다.
4. 사용자 이름이나 인증 정보가 부족한 프로필은 Connections의 편집 버튼으로 보완합니다.

### 지원 범위

- **OpenSSH**: `~/.ssh/config` 자동 감지. `Host` 별칭, `HostName`, `User`, `Port`, 첫 번째 `IdentityFile`을 변환합니다. 여러 별칭, 와일드카드·부정 패턴, 먼저 지정된 값의 우선순위를 처리합니다.
- **iTerm2 (macOS)**: 기본 환경설정 plist와 DynamicProfiles 폴더의 파일을 감지합니다. JSON, XML plist, binary plist 파일 선택도 지원합니다. `ssh [-p port] [-l user] [-i key] [user@]host` 형식의 명령을 해석하고 이름과 첫 번째 태그를 그룹으로 가져옵니다. 기본 로그인 셸 프로필은 시작 시 보내는 텍스트(`Initial Text`)에 저장된 단일 SSH 명령도 지원합니다. 주소 해석에 실패하면 이름을 주소로 사용하지 않고 수동 설정 대상으로 표시합니다. 서버 별칭은 현재 컴퓨터의 `~/.ssh/config`를 함께 읽어 해석합니다.
- iTerm2 JSON 내보내기: **Settings → Profiles → Other Actions → Save Profile as JSON**.
- **Termius 10.1.0 (macOS, 실험적)**: 로컬 IndexedDB에서 접속 이름·주소·포트·사용자·그룹을 직접 가져옵니다. 상위 그룹의 포트·사용자 상속과 10.1.0의 별도 사용자 연결 테이블을 해석합니다. 중첩 그룹 이름은 `상위 / 하위`로 표시합니다. 기본 데이터 폴더와 App Store 설치 경로를 자동 감지하며 폴더 직접 선택도 가능합니다. 다른 Termius 버전과 공유·팀 Vault는 검증 범위에 포함되지 않습니다.

### Termius 로컬 가져오기

1. Termius를 종료한 뒤 **Import connections → Termius local connections**를 선택합니다. 직접 선택할 때는 `~/Library/Application Support/Termius` 또는 그 안의 `IndexedDB/file__0.indexeddb.leveldb` 폴더를 지정합니다.
2. macOS가 요청하면 Termius의 `localKey` 키체인 항목 읽기를 허용합니다. 이 키는 접속 메타데이터 복호화에만 사용하며 저장하거나 화면에 표시하지 않습니다. 접근을 거부하면 안내창이 다시 열립니다. **Retry access**를 눌러 권한을 다시 요청하거나 **Cancel**로 중단할 수 있습니다. 다른 Mac의 백업은 대응하는 키체인 키가 이 Mac에 있어야 합니다.
3. 미리보기에서 항목과 그룹을 선택해 가져옵니다. 비밀번호와 Termius 내부 개인키는 복사하지 않으므로 가져온 뒤 인증 정보를 설정합니다.

원본 저장소는 읽기만 하며 Termius 실행·계정 로그인·네트워크 호출·외부 CLI 설치가 필요하지 않습니다. 현재 MANIFEST에 속한 파일과 최신 기록만 읽고 삭제 기록을 반영합니다. 손상되거나 읽는 도중 바뀐 저장소는 오류를 표시합니다. 점프 호스트·프록시·시작 명령·Mosh·공유 Vault·지원하지 않는 인증 정책은 수동 설정 대상으로 표시합니다. 포트 포워딩·환경변수·SSH agent forwarding은 이전하지 않습니다. 다른 키로 암호화된 공유 Vault가 함께 있으면 전체 미리보기가 중단될 수 있습니다.

주소·포트·사용자가 같은 SSH 연결은 중복으로 건너뜁니다. 같은 파일 안의 중복도 첫 번째 사용 가능한 항목만 선택할 수 있습니다. 미리보기 후 원본 설정이나 저장된 연결이 바뀌면 다시 미리보기를 해야 합니다.

### 제한 사항

- `Include`와 `Match`가 있는 SSH 파일은 완전하게 해석할 수 없어 자동 가져오기를 차단합니다. 파일을 수정할 필요 없이 필요한 연결을 수동 등록할 수 있습니다.
- 점프 서버·ProxyCommand·원격 명령·인증서·프로필 상속과 미지원 SSH 명령 옵션은 수동 설정 대상으로 표시합니다. 그 밖의 미이전 옵션은 항목별로 표시합니다.
- 시스템 전체 SSH 설정과 iTerm2의 사용자 지정 환경설정 위치는 자동으로 찾지 않습니다. 사용자 지정 iTerm2 plist는 직접 선택할 수 있습니다. SSH/iTerm2 파일은 최대 4 MB, Termius는 읽는 파일 합계 최대 64 MB·기록당 1 MB, 프로필은 최대 5,000개입니다.
- 비밀번호, SSH agent 인증 정보, 개인키 내용, 실행 기록, 테마는 복사하지 않습니다. 키 경로는 유지하되 파일이 없거나 상대 경로이면 안내합니다. 상대 경로도 가져올 수 있으며, 연결 전에 프로필 편집에서 키파일을 다시 선택해야 합니다. 연결 성공 여부나 키의 유효성을 검사하는 기능은 아닙니다.
- 로컬 파일만 읽으며 SSH 명령, `Match exec`, 셸 스크립트는 실행하지 않습니다. 가져오기는 기존 Cygnus 프로필 저장소의 트랜잭션으로 처리합니다.

## English

Choose **Import connections** in Connections or the connection sidebar. An empty library also offers **Import existing connections**. Select detected settings or a file, review the profiles and warnings, choose each connection’s group with the **Group** selector (including **No group**), then import the selected connections. The source group is selected by default. Existing profiles are never overwritten. Edit imported profiles to supply any missing username or authentication settings.

### Supported sources

- **OpenSSH:** automatically detects `~/.ssh/config`. Imports explicit `Host` aliases, `HostName`, `User`, `Port` and the first `IdentityFile`, respecting first-value precedence and wildcard/negated Host patterns.
- **iTerm2 on macOS:** detects the standard preferences plist and DynamicProfiles files. Accepts JSON, XML plist and binary plist files. Parses `ssh [-p port] [-l user] [-i key] [user@]host`, preserving the profile name and first tag as its group. Login-shell profiles also support a single SSH command in `Initial Text` (Send text at start). Unresolved profiles require manual setup; their display names are never substituted for addresses. Resolves SSH aliases against this computer's `~/.ssh/config`.
- Export iTerm2 profiles through **Settings → Profiles → Other Actions → Save Profile as JSON**.
- **Termius 10.1.0 on macOS (experimental):** reads connection names, addresses, ports, usernames and groups directly from local IndexedDB. Resolves parent-group defaults and the separate 10.1.0 identity join table. Nested groups become `Parent / Child`. Detects the standard data directory and App Store container; manual folder selection is supported. Other versions and shared/team vaults are outside the verified scope.

### Importing local Termius connections

Quit Termius, then choose **Import connections → Termius local connections**, or select `~/Library/Application Support/Termius` (the nested IndexedDB LevelDB folder also works). Allow the macOS Keychain request for the Termius `localKey` item. Denied or unavailable access reopens the explanation: choose **Retry access** to request permission again or **Cancel** to stop. The key is used in memory for connection metadata only; it is never displayed or saved. A backup from another Mac requires its matching Keychain key. Review and select connections before importing, then configure passwords or SSH key files in Edit connection.

The reader does not modify the source, launch Termius, sign in, contact the network or install an external CLI. It respects active MANIFEST files, latest sequence numbers and deletion records. Damaged or changing storage is rejected. Jump hosts, proxies, startup snippets, Mosh, shared vaults and unsupported credential policies require manual setup. Port forwards, environment variables and agent forwarding are not migrated. Shared vault records encrypted with another key can prevent the entire preview.

Duplicate SSH host/port/user combinations are skipped, including later duplicates within the source. If the source or saved profiles change after preview, preview again before importing.

### Limits

Files containing `Include` or `Match` are blocked rather than partially interpreted. Jump hosts, proxy commands, remote commands, certificates, inherited iTerm2 profiles and unsupported SSH command options require manual setup. Other unmigrated options are listed as warnings. System-wide SSH settings and custom iTerm2 preferences locations are not detected; custom plist files can be selected manually. Maximum SSH/iTerm2 file size: 4 MB; Termius: 64 MB total files read, 1 MB per record; maximum profiles: 5,000.

Passwords, SSH agent credentials, private key contents, history and themes are not copied. Key paths are retained and missing files or relative paths are flagged. Relative paths do not block import; choose the key file in Edit connection before connecting. Key validity and connectivity are not tested. Parsing reads local files only and never executes SSH, shell scripts or `Match exec`. Selected profiles are saved in a database transaction.
