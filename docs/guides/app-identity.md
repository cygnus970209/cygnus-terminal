# Application identity / 앱 식별자

Cygnus Terminal uses `io.github.cygnus970209.cygnus-terminal` as its application identifier and keychain service name. The visible application/product name remains `cygnus-terminal`.

## 한국어

이전 식별자 `com.intocns.cygnus-terminal`로 배포된 설치에서 업데이트할 때:

- 새 앱 데이터 폴더에 DB가 없으면 이전 폴더의 `cygnus.db`를 SQLite 백업 API로 복사합니다. WAL에 기록된 커밋도 포함하며 연결, 비밀번호 암호문, Vault, 연결 매핑, 히스토리, 북마크, 스니펫 등 DB 전체를 유지합니다.
- 원본 DB를 이동하거나 삭제하지 않습니다. 새 DB가 이미 있으면 덮어쓰거나 이전 DB와 병합하지 않습니다. 구버전과 신버전의 이후 변경 사항은 서로 동기화되지 않습니다.
- DB 복사에 실패하면 빈 DB로 대신 실행하지 않습니다. 원본 데이터는 남겨 둡니다.
- 키체인은 시작할 때 읽지 않습니다. 인증 정보가 실제로 필요한 시점에 안내·승인 흐름을 거친 뒤 새 키체인 항목을 확인합니다. 없으면 이전 항목에서 **동일한 암호화 키**를 가져와 새 이름으로 저장합니다.
- 기존 키체인 항목도 유지합니다. 이전 과정에서는 macOS 창에 이전 이름이 나타나거나 새 항목 권한을 요청할 수 있습니다. 이 변경이 macOS 권한 창을 항상 한 번만 표시하도록 보장하지는 않습니다.
- 기존 암호문이 있는데 새 항목과 이전 항목에서 키를 찾을 수 없으면 대체 키를 만들지 않고 오류를 표시합니다. 접근 거부·손상된 키·저장 실패 역시 새 키 생성으로 우회하지 않습니다.
- Windows MSI의 Upgrade Code는 기존 `3932911e-9221-53e9-b993-8ea8b956da4f`로 고정합니다. 제품 이름과 업데이터 서명 키·배포 주소는 유지합니다.

브라우저 저장소에만 있는 테마, 글꼴, 즐겨찾기 등의 화면 설정은 DB 복사 대상이 아닙니다. 운영체제의 WebView 저장소가 새 식별자에 따라 분리되면 이 설정은 다시 지정해야 할 수 있습니다. 서명된 macOS 앱과 Windows 설치 파일의 실제 구버전→신버전 업데이트는 배포 검증에서 별도로 확인해야 합니다.

## English

When upgrading an installation published as `com.intocns.cygnus-terminal`, the new application snapshots the legacy SQLite database only if its destination database does not exist. The SQLite backup API includes committed WAL data. The original remains intact; existing destination databases are never overwritten or merged. The two versions do not synchronize subsequent edits. A failed migration does not silently create an empty replacement.

Keychain access remains deferred until credentials are needed. After the explanation/authorization flow, the application reads the new service first and falls back to the old service only when the new entry is absent. The exact existing encryption key is copied to the new service; the old entry is retained for compatibility. macOS may display the former name during migration or request permission for the new item. This identity change does not guarantee a single OS prompt.

If encrypted credentials exist but both keys are missing, the app refuses to generate a replacement key. Denied access, malformed keys and failed migration writes are propagated as errors, never treated as missing entries.

The Windows MSI Upgrade Code is pinned to `3932911e-9221-53e9-b993-8ea8b956da4f`. Product name, updater verification key and release endpoint remain stable.

WebView-only preferences (themes, fonts, favorites and similar UI settings) are outside the database migration. They may need to be configured again if the OS separates browser storage by the new identifier. Signed macOS and Windows installer upgrade paths still require release validation on each platform.
