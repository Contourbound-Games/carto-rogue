작업: Claude Code 통합 개발 플로우 문서화 및 GitHub Actions CI 추가
결과: 완료
다음 할 일: 개발자가 GitHub "Protect main" 룰셋에 PR 필수와 필수 체크 `Test and build`를 추가한 뒤, PR을 검토·병합

## 핵심 변경

- `CLAUDE.md`: 개발 플로우, 고위험 기준과 Codex 리뷰, 실패 처리, 작업 기록, CI 조항을 추가했다.
  - "Git and publishing"의 "Commit or push only when explicitly asked" 조항만 바꿨다. 작업 브랜치 commit·push·PR은 상시 허용하고, main 직접 commit·push와 PR 병합은 금지한다.
  - Steam, 홍보, 외부 게시 관련 조항은 바꾸지 않았다.
- `docs/DECISIONS.md` (신규): 승인된 결정 기록이다. 기존 결정 문서(Steam 1.0 Scope, Generator Versioning)를 연결하고, 2026-10-10 개발 플로우·CI 결정을 기록했다.
- `docs/REPORT.md` (신규): 이 파일이다.
- `.github/workflows/ci.yml` (신규): 모든 push와 pull_request에서 실행한다. 경로 필터와 AI API 호출은 없다.
  - Windows(`windows-latest`), Node 24에서 `npm ci` → lint → `npm test -- --testTimeout=60000` (`vitest run`) → `npm run build` → `npm run build:steam` 순서로 실행한다. 제한 시간은 20분이다.
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

- `96be310` (ubuntu-latest), run 38013318263: **실패 (1회째)**.
  - `npm ci`와 lint는 통과했다.
  - `tests/desktop-protocol.test.ts` > "never resolves outside the web build"에서 테스트 1건이 실패했다.
  - 원인: 이 테스트는 Windows 경로 규칙을 전제로 한다. `..\..\package.json`과 `C:\Windows\win.ini`가 웹 빌드 밖으로 나가는지 검사한다. Linux에서는 `\`가 일반 파일명 문자라서 `resolveAppFile`이 루트 안의 경로를 반환한다.
  - 제품 결함이 아니라 실행 플랫폼 차이다. 데스크톱 빌드는 win x64 전용이다.
  - 조치: 기존 테스트나 프로토콜 코드는 바꾸지 않았다(고위험). CI 실행 환경을 배포 플랫폼인 `windows-latest`로 바꿨다.
- `058c084` (windows-latest), run 38013470796: **실패**.
  - `desktop-protocol`은 통과했다.
  - `tests/map.test.ts` > "samples a continuous, bounded field"가 6.7초 걸려 vitest의 기본 테스트 제한 시간(5초)을 넘었다. 로컬(12코어)에서는 1.6초 걸린다. 앞의 실패와는 다른 문제다.
  - 원인: 호스팅 러너의 CPU가 느리고, 병렬로 실행되는 테스트 파일들과 경합한다.
  - 조치: 테스트와 `vite.config.ts`는 바꾸지 않았다(고위험). CI에서만 `npm test -- --testTimeout=60000`을 쓴다.
    - 시간을 검사하는 테스트는 없어서 어떤 assertion도 바뀌지 않는다.
    - 전체 실행은 여전히 job의 `timeout-minutes: 20`으로 제한된다.
- `022d6dd` (windows-latest), run 38013701955: **성공**.
  - `npm ci`, lint, 테스트(30개 파일 통과·1개 생략, 432개 통과·2개 생략), itch 빌드, Steam 빌드가 모두 통과했다.
  - 테스트 단계는 74초 걸렸다.
- 이 보고서는 코드 변경 커밋(`022d6dd`)까지의 CI 결과만 기록한다. 보고서만 갱신한 push의 CI는 확인만 하고 여기에 다시 쓰지 않는다.

## 수행하지 못한 검증과 영향

- Linux에서는 `desktop-protocol` 테스트가 실패하므로 CI는 Windows에서만 실행한다. Linux 데스크톱은 배포 대상이 아니라서 영향이 없다.

## 미해결 문제

- `eslint.config.js`가 `promo/`를 무시하지 않아서, 로컬에서 `npm run lint`를 그대로 실행하면 실패한다.
  - CI에는 `promo/`가 없어서 영향이 없다.
  - 고치려면 빌드 설정 변경이 필요하므로 이번 범위에서 제외했다.
- GitHub "Protect main" 룰셋은 삭제와 강제 push만 막는다. PR 필수 규칙과 필수 상태 체크(`Test and build`)가 없다. 개발자가 GitHub에서 직접 설정해야 한다.
- 미추적 파일 `tests/advanced-sweep.test.ts`, `tests/support/advanced.ts`는 이번 작업과 무관해서 커밋하지 않았다.

## 커밋 (브랜치 `chore/dev-flow-ci`)

- `96be310` ci: add test and build workflow and Claude Code dev flow
- `058c084` ci: run on Windows, the shipping platform
- `022d6dd` ci: allow slow hosted runners a longer per-test timeout
- 이후 커밋: 이 보고서의 최종 갱신(보고서만 변경)
