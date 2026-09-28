# GitHub 및 운영 보강

이 문서는 2026-09-28에 승인된 GitHub 정리와 운영 보강의 실행 범위를 기록한다.

## GitHub

기존 기본 브랜치 `codex/rapi-product-docs`의 별도 운영 커밋 2개와 완료 브랜치의
수집·발송·공개 커뮤니티 변경을 병합해 이력을 보존한다. `main`을 기본 브랜치로
설정하고 `verify`, `secret-scan`, `blog-browser` 성공을 요구한다. 단독 소유자
저장소이므로 PR은 요구하되 다른 사람의 승인을 필수로 하지 않는다. 관리자에도
규칙을 적용하고 강제 push와 브랜치 삭제를 차단한다. 기존 브랜치는 삭제하지 않는다.

첫 릴리스는 package.json의 버전에 맞춘 `v0.1.0`이다. 정확한 대상 SHA의 CI 성공과
서버 스테이징 검증 후 annotated tag와 GitHub Release를 만든다. 릴리스 소스는
비밀 설정을 포함하지 않으며 서버 환경과 계정 인증은 별도 유지한다.

## 서버 밖 장애 감시

`External monitor` Actions 워크플로는 5분 간격으로 공개 `/blog/`의 HTML과
서명 없는 `POST /interactions`의 401 거부를 확인한다. VM·터널 전체 중단도 감지할
수 있다. 내부 프로세스별 readiness는 기존 서버 monitor가 확인한다.

감시 상태는 GitHub Actions 봇이 만든 지정 marker의 이슈에 보존한다. 지속 장애는
한 번만 알리고 복구 때 알림 후 이슈를 닫는다. 운영 장애와 self-test는 별도 marker를
쓴다. 작업 concurrency를 1로 제한하고 기본 브랜치에서만 실행한다.
웹훅은 비공개 `라피-알림` 채널 전용이며 GitHub Actions secret에만 저장한다.
알림의 mentions는 비활성화한다. 웹훅 값과 원문 API 오류는 로그에 출력하지 않는다.

예약 Actions는 지연될 수 있으므로 엄격한 5분 탐지 SLA를 제공하지 않는다.
공개 저장소가 60일 동안 활동이 없으면 GitHub가 예약 실행을 비활성화할 수 있다.
워크플로 실패 알림과 Actions 실행 기록도 운영자가 확인해야 한다.
Discord 발송 직후 GitHub 상태 기록이 실패하면 다음 시도에서 중복 알림이 생길 수
있다. 두 서비스에 걸친 exactly-once 발송은 보장하지 않는다.

테스트는 서버를 중단하지 않고 GitHub runner의 닫힌 localhost 포트를 실제로
요청하는 `self-test-fail`과 실제 공개 origin을 확인하는 `self-test-recover`를 쓴다.
장애 테스트를 연속 두 번 실행해 중복 억제를 확인한 뒤 복구 알림과 이슈 종료를
확인한다. 실제 VM 전원 차단 테스트와 구분한다.

## 백업 및 원본 데이터 보관

백업은 성공한 새 dump를 저장한 후 이름의 UTC 생성 시각으로 30일이 지난
`rapi-YYYYMMDDTHHMMSSZ.dump` 일반 파일만 만료한다. 심볼릭 링크, 잘못된 날짜,
이름이 다른 복구 증거 파일은 보존한다. 기존 7개 개수 기준은 제거한다.
백업 서비스는 검증된 `rapi-releases/current`의 스크립트를 사용하고 기존 canonical
백업 폴더와 상태 파일을 유지한다.

원본 DB 정책은 [보존 정책](security/data-retention.md)의 공개 90일·비공개 30일,
요약·분류 180일, 발송·작업 감사 1년을 기준으로 매일 read-only 만료 대상을 계산한다.
수신자 식별자 축소 대상은 90일이다. 원문·주소·credential을 보고서에 넣지 않는다.
공개 여부가 불명확한 raw envelope는 보수적으로 비공개 30일로 계산한다.

inventory 자체는 본문을 삭제하지 않는다. `v0.1.1`의 별도
`rapi-source-expiry.service`가 매일 04:05 UTC에 원본 본문과 연결된 요약·분류를
만료한다. 발송 중인 항목은 보류하고 완료된 공개 게시물은 함께 철회한다.
철회 목록은 `/var/lib/rapi/blog-withdrawals.json`에 atomic rename으로 저장하고
gateway가 게시물·목록·RSS에서 제외한다. DB commit보다 먼저 철회 상태를 적용해
중단 시에도 만료 본문이 공개로 남지 않게 한다. 상태 파일 오류 시 공개 블로그는
404로 닫히며 영속 파일은 이전 코드로 되돌려도 유지한다.

실행은 최근 26시간 이내 성공한 실제 백업을 요구한다. 만료 작업의 실패나
26시간 넘는 미실행은 monitor가 `source_expiry` 장애로 감지한다. 원문·credential은
실행 보고서에 넣지 않는다. 1년 감사 메타데이터의 최종 제거, 수신자 축소와 사용자
삭제 요청 추적은 아직 inventory 범위다. 전체 정책을 실행한 것으로 해석하지 않는다.

운영 설치 대상은 `rapi-backup.service`, `rapi-retention-report.service`,
`rapi-retention-report.timer`, `rapi-source-expiry.service`, `rapi-source-expiry.timer`,
gateway·monitor의 `20-source-expiry.conf`다. 서비스 설치 후 daemon-reload, timer enable,
수동 최초 실행과 journal 확인을 실시한다.

`scripts/launch-public-gateway.mjs`는 `/usr/local/lib/rapi/`에 설치한다. 이 영속
launcher가 `current`를 한 번만 실제 immutable 경로로 해석하고 같은 경로에서
검사와 gateway를 import한다. 시작 도중 포인터가 바뀌어도 서로 다른 버전이
검사·실행되는 일이 없다. 철회 기능이 없는 이전 버전은 검사 단계에서 닫힌다.
