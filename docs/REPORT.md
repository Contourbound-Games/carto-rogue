작업: PR #1 후속, 병합 규칙·모델 운영 규칙 수정과 서브에이전트 정의
결과: 검증 대기
다음 할 일: 작업 브랜치 `chore/dev-flow-ci`의 GitHub Actions 결과 확인

## 이번 작업: 병합·모델 운영 규칙

### 핵심 변경

- `CLAUDE.md`
  - 병합 규칙: "개발자가 GitHub에서 직접 병합"을 "개발자의 명시적 병합 지시가 있을 때만 Claude Code가 병합"으로 바꿨다.
    - 병합 전에 세 가지를 확인한다: 대상 PR과 base 브랜치, PR head 커밋의 최신 CI 성공, 고위험 변경의 Codex 리뷰 완료.
    - main 직접 push, 지시 없는 병합, auto-merge는 계속 금지한다.
    - 권한 규칙에 막히면 우회하지 않고 보고한다.
  - 모델 규칙(신규 "Models" 절)
    - 메인 세션 기본 모델은 Opus 5.5이다.
    - Fable 5.1은 개발자가 명시할 때만 쓰고, 전환은 개발자가 `/model`로 한다. 자동 전환은 가정하지 않는다.
  - 서브에이전트 사용 조건
    - 복잡한 구현만 필요할 때 `implementer`에 위임한다.
    - 새 컨텍스트 리뷰는 사소하지 않은 변경에만 `reviewer`로 한다.
  - Codex 고위험 리뷰, 진단 전용 rescue, 실패 3회 중단, CI, REPORT 규칙과 Steam·홍보 규칙은 그대로 두었다.
- `docs/DECISIONS.md`: 병합·모델 결정을 새 항목으로 추가했다. 기존 항목은 고치지 않고, 새 항목이 기존 병합 조항을 대체한다고 명시했다.
- `.claude/agents/implementer.md` (신규): Opus 5.5 구현 서브에이전트.
  - 브리프 범위 밖의 고위험 변경, 기존 테스트 수정, commit·push·병합, Codex 실행을 금지한다.
- `.claude/agents/reviewer.md` (신규): 새 컨텍스트 읽기 전용 리뷰 서브에이전트(Opus 5.5).
  - `disallowedTools`로 Edit, Write, NotebookEdit을 막았다.
- 게임 소스, 기존 테스트, Codex 설정·인증은 바꾸지 않았다.

### 모델 식별자 확인

- 공식 문서(sub-agents, model-config): 서브에이전트 `model`은 `sonnet`, `opus`, `haiku`, `fable`, 전체 모델 ID, `inherit`를 받는다. `opus`는 Anthropic이 권장하는 Opus 버전을 따라 바뀌는 별칭이다.
- 실제 확인: 설치된 Claude Code 2.1.296에서 `model: opus`로 띄운 서브에이전트가 `claude-opus-5-5`를 보고했다.
- 모델 매핑을 바꾸는 환경 변수(`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`)는 설정되어 있지 않다.
- `.claude/agents/`는 이번 세션 중에 새로 만든 폴더라 이 세션에서는 감시되지 않는다. 두 정의 파일은 다음 세션부터 로드된다.

### 권한상 직접 할 수 없었던 일 (우회하지 않음)

- **병합 권한**: `.claude/settings.local.json`에 `Bash(gh pr merge*)`, `PowerShell(gh pr merge*)`가 deny로 있다.
  - 개발자 지시가 있을 때 병합하려면 이 두 규칙을 `deny`에서 `ask`로 옮겨야 한다.
  - `gh api*/merge*`, `gh api*mergePullRequest*`, `gh api*AutoMerge*`는 deny로 두는 것을 권장한다. API 우회와 auto-merge를 막기 위해서다.
- **프로젝트 기본 모델**: 프로젝트 공유 설정 `.claude/settings.json`에 `"model": "opus"`를 넣으면 메인 기본 모델이 이 저장소에서 고정된다. 공식 문서상 지원된다.
  - 다만 Claude의 Edit/Write는 `.claude/settings*.json`에 쓸 수 없도록 deny되어 있어 만들지 못했다.
  - 현재는 사용자 설정 `~/.claude/settings.json`의 `"model": "opus"`가 적용되므로, 이 PC에서는 이미 메인 기본 모델이 Opus 5.5이다.

### GitHub main 보호 확인 (변경하지 않음)

- "Protect main" 룰셋(활성)에는 `deletion`, `non_fast_forward` 규칙만 있다.
- **PR 필수 규칙과 필수 체크 `Test and build`는 아직 없다.**

### 미추적 파일 조사 (변경하지 않음)

- `tests/advanced-sweep.test.ts`, `tests/support/advanced.ts`는 2026-10-04에 만든 "Experiment C: Advanced 정보 규칙" 검증 실험이다. 게임 코드는 바꾸지 않는 실험이다.
- 실험 고정 해시(`.sweep/c-locked-hashes.txt`, `ef505d8` 기준)와 현재 파일·지원 파일의 해시가 모두 일치한다.
- 상시 검사(3개 테스트)는 지금도 통과한다. 1000-seed 결과(`.sweep/c-adv-final.txt`)의 판정은 C1·C2·C3 모두 CONCERN이다.
- `docs/STEAM_1_0_SCOPE.md`에는 "커밋되지 않은 검증 실험만 존재, 런타임 모드 미승인"으로 기록되어 있다.
- 판단: 지금은 커밋도 삭제도 하지 않는다. Advanced 규칙의 범위 결정이 나면 그에 따라 정한다.
  - 진행하기로 하면 실험 브랜치에 커밋한다.
  - 폐기하기로 하면 결과를 보존한 뒤 삭제한다.

### 리뷰

- 새 컨텍스트 리뷰(Opus 5.5)에서 필수 지적 4건이 나왔고 모두 반영했다.
  1. 병합 전 CI 조건: 현재 head 커밋의 `push`·`pull_request` 실행이 모두 성공하고 대기 중인 실행이 없어야 하며(`gh pr checks`), `--match-head-commit`으로 확인한 커밋을 고정한다.
  2. Codex 리뷰 조건: 리뷰가 최종 고위험 변경을 다뤄야 하고, 그 필수 지적이 반영·기록되어 있어야 한다.
  3. 우회 금지 범위: 권한 규칙뿐 아니라 브랜치 보호와 필수 체크로 막힌 경우에도 `--admin`, `gh api` 병합, 로컬 병합 후 push를 금지한다.
  4. `implementer` 실패 처리: 같은 문제로 2회 실패하면 멈추고 메인 세션에 보고한다. rescue와 3회 중단 규칙은 메인 세션이 적용한다.
- 선택 지적 중 다음을 반영했다.
  - 병합 지시는 채팅으로 받은 것만 인정한다.
  - base 브랜치를 명시한다.
  - 서브에이전트는 REPORT.md와 DECISIONS.md를 편집하지 않는다.
  - 고위험 변경은 사소한 변경으로 보지 않는다.
  - Fable 전환은 개발자가 하고, 서브에이전트에 모델을 임의로 지정하지 않는다.
  - DECISIONS에 대체 대상 항목을 링크하고 모델을 "Opus (currently 5.5)"로 표기했다.
  - `implementer` 검사 목록에 CI 범위의 lint를 추가했다.
  - `CARTO_SWEEP` 사용을 금지했다.

### 로컬 검증

- 서브에이전트 정의 2개의 frontmatter YAML 파싱 통과: name, model `opus`, tools, disallowedTools.
- CLAUDE.md의 Steam·홍보 조항: `main`과 동일함을 diff로 확인했다.
- 유지 대상 규칙이 남아 있음을 확인했다: Codex 리뷰 게이트 비활성, 읽기 전용 rescue 문구, 3회 실패 중단, CI, REPORT 형식.
- `.claude/agents/*.md`는 git 제외 규칙에 걸리지 않는다. `.claude/settings.local.json`과 백업 파일은 커밋하지 않는다.
- 게임 소스와 테스트를 바꾸지 않아 로컬 테스트·빌드는 다시 돌리지 않았다. CI가 전체를 실행한다.

### GitHub Actions 결과

- 확인 중.

### 커밋

- 확인 중.

## 이전 작업: 개발 플로우 문서화와 GitHub Actions CI 추가 (같은 PR)

### 핵심 변경

- `CLAUDE.md`: 개발 플로우, 고위험 기준과 Codex 리뷰, 실패 처리, 작업 기록, CI 조항을 추가했다. Steam, 홍보, 외부 게시 관련 조항은 바꾸지 않았다.
- `docs/DECISIONS.md`, `docs/REPORT.md` (신규).
- `.github/workflows/ci.yml` (신규): 모든 push와 pull_request에서 실행한다. 경로 필터와 AI API 호출은 없다.
  - Windows(`windows-latest`), Node 24에서 `npm ci` → lint → `npm test -- --testTimeout=60000` → `npm run build` → `npm run build:steam` 순서로 실행한다. 제한 시간은 20분이다.
  - concurrency: 작업 브랜치와 PR은 같은 이벤트·ref의 이전 실행을 취소한다. main은 실행마다 고유 그룹이라 취소되지 않는다. 체크 이름은 `Test and build`이다.
- 저위험으로 분류했다. 새 컨텍스트 서브에이전트 리뷰에서 나온 필수 지적 2건(main 대기 실행 취소, CI 실행 특정)을 반영했다.

### GitHub Actions 결과

- `96be310` (ubuntu-latest), run 38013318263: 실패.
  - `desktop-protocol` 테스트가 Windows 경로 규칙을 전제로 해서 Linux에서 실패했다. 데스크톱 빌드는 win x64 전용이다.
  - CI를 `windows-latest`로 옮겼다. 테스트와 프로토콜 코드는 바꾸지 않았다.
- `058c084` (windows-latest), run 38013470796: 실패.
  - `map.test.ts`의 테스트 하나가 러너에서 6.7초 걸려 5초 기본 제한을 넘었다(로컬 1.6초).
  - CI에서만 `--testTimeout=60000`을 쓴다. 시간을 검사하는 assertion은 없다.
- `022d6dd` (windows-latest), run 38013701955: 성공. lint, 테스트 432개 통과·2개 생략, 두 빌드 모두 통과했다.

### 미해결 문제

- `eslint.config.js`가 `promo/`를 무시하지 않아서, 로컬에서 `npm run lint`를 그대로 실행하면 실패한다. CI에는 영향이 없다. 고치려면 빌드 설정 변경이 필요하므로 범위에서 제외했다.

### 커밋

- `96be310`, `058c084`, `022d6dd`, `90b7f04`(보고서만 변경)
