# TODOS — Cygnus Terminal

## Phase 1 Critical

### SessionManager async 종료 처리
- **What:** `HashMap<TabId, SshSession>`에서 탭 닫을 때 tokio task를 안전하게 종료
- **Why:** Rust의 Drop trait은 async 코드 실행 불가. 미처리 시 좀비 task가 메모리 점유
- **How:** `tokio_util::sync::CancellationToken` 또는 `tokio::sync::mpsc` shutdown channel 사용
- **When:** Week 1-2 SSH 구현 시 반드시 포함
- **Depends on:** russh SSH 연결 구현

### Keychain 접근 불가 시 폴백 전략
- **What:** OS Keychain이 없는 환경(headless Linux, WSL)에서 비밀번호 저장 방식 결정
- **Why:** AES 계층 제거 후 Keychain이 유일한 비밀번호 저장소. 접근 불가 시 저장 불가능
- **Options:** (1) 매번 비밀번호 입력 요청 (2) 경고 후 평문 저장 (3) 환경 변수 기반
- **When:** Week 3-4 암호화 모듈 구현 시
- **Depends on:** keyring crate 플랫폼 테스트

## Phase 2

### DB 마이그레이션 실패 롤백 전략
- **What:** SQLite 스키마 업그레이드 실패 시 데이터 보호 방법
- **Why:** 마이그레이션 중간에 실패하면 DB가 불완전한 상태가 됨
- **How:** 마이그레이션 전 자동 백업 (data.db.bak) + 트랜잭션 기반 마이그레이션
- **Depends on:** Phase 1 스키마 안정화 후

### CI/CD 파이프라인 세팅
- **What:** GitHub Actions로 플랫폼별 바이너리 빌드 + 릴리즈 자동화
- **Why:** 수동 빌드는 릴리즈 장벽. 자동화해야 지속적 배포 가능
- **Depends on:** Phase 1 완료 + GitHub repo 생성
