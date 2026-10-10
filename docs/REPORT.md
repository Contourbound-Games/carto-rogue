작업: Claude Code 통합 개발 플로우 문서화 및 GitHub Actions CI 추가
결과: 검증 대기
다음 할 일: 작업 브랜치 `chore/dev-flow-ci`의 GitHub Actions 결과 확인

## 핵심 변경

- `CLAUDE.md`: 개발 플로우, 고위험 기준과 Codex 리뷰, 실패 처리, 작업 기록, CI 조항을 추가했다.
  - "Git and publishing"의 "Commit or push only when explicitly asked" 조항만 바꿨다. 작업 브랜치 commit·push·PR은 상시 허용하고, main 직접 commit·push와 PR 병합은 금지한다.
  - Steam, 홍보, 외부 게시 관련 조항은 바꾸지 않았다.
- `docs/DECISIONS.md` (신규): 승인된 결정 기록이다. 기존 결정 문서(Steam 1.0 Scope, Generator Versioning)를 연결하고, 2026-10-10 개발 플로우·CI 결정을 기록했다.
- `docs/REPORT.md` (신규): 이 파일이다.
- `.github/workflows/ci.yml` (신규): 모든 push와 pull_request에서 실행한다. 경로 필터와 AI API 호출은 없다.
  - Node 24에서 `npm ci` → lint → `npm test` (`vitest run`) → `npm run build` → `npm run build:steam` 순서로 실행한다. 제한 시간은 20분이다.
  - concurrency: 작업 브랜치와 PR은 같은 이벤트·ref의 이전 실행을 취소한다. main은 실행마다 고유 그룹이라 취소되지 않는다.
  - 체크 이름은 `Test and build`이다.

## 위험도 판단

- 저위험으로 분류했다. 운영 문서와 검사를 추가하는 CI만 바뀌었고, 게임 소스·테스트·빌드·패키지 설정(`package.json`, `vite.config.ts` 등)은 바꾸지 않았다.
- 새 컨텍스트 서브에이전트가 검토했다.
  - 필수 지적 2건을 반영했다. main 실행이 대기 중에 취소될 수 있던 concurrency 문제, 그리고 CI 실행을 커밋 SHA로 특정하지 않던 문제다.
  - 선택 지적 중 규칙의 모호함을 줄이는 항목도 반영했다. 빌드 설정 파일 목록, REPORT 형식, rescue 전후 비교 방법, 실패 횟수 정의다.
- Codex 리뷰 대상이 아니다.

## 로컬 검증 (Windows, Node 24.14.1)

- `npm test`: 커밋된 테스트 기준(미추적 `tests/advanced-sweep.test.ts` 제외) 30개 파일 통과, 1개 생략(`explorer-sweep`, `CARTO_SWEEP` 미설정 시 생략). 432개 통과, 2개 생략.
- `npm run build`, `npm run build:steam`: 통과.
- lint:
  - 커밋된 파일 기준(git이 무시하는 `promo/` 제외) 통과.
  - 로컬에서 `npm run lint`를 그대로 실행하면 `promo/tools/*.mjs` 때문에 130개 오류로 실패한다(아래 "미해결 문제" 참고).
- 워크플로 YAML 구문: 파싱 통과.

## GitHub Actions 결과

- 확인 중.

## 수행하지 못한 검증과 영향

- 로컬에는 Linux 환경이 없어 Ubuntu 실행 결과는 CI로만 확인한다.

## 미해결 문제

- `eslint.config.js`가 `promo/`를 무시하지 않아서, 로컬에서 `npm run lint`를 그대로 실행하면 실패한다.
  - CI에는 `promo/`가 없어서 영향이 없다.
  - 고치려면 빌드 설정 변경이 필요하므로 이번 범위에서 제외했다.
- GitHub "Protect main" 룰셋은 삭제와 강제 push만 막는다. PR 필수 규칙과 필수 상태 체크(`Test and build`)가 없다. 개발자가 GitHub에서 직접 설정해야 한다.
- 미추적 파일 `tests/advanced-sweep.test.ts`, `tests/support/advanced.ts`는 이번 작업과 무관해서 커밋하지 않았다.

## 커밋

- 확인 중.
