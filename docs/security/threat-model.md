# 위협 모델

## 보호 대상

- Discord, GitHub, 이메일, 모델 공급자, OMP 자격 증명
- 비공개 원문과 사용자 식별자
- 승인 revision, 권한 범위, 발송·실행 감사 기록
- 공개 블로그의 공개 범위 무결성

## 신뢰 경계와 주요 위협

외부 webhook, GitHub, feed, Discord 입력은 신뢰하지 않는다. 서명 검증, 크기 제한,
schema 검증 뒤에만 core로 전달한다. OMP callback도 서명, receipt 연결, 단조 증가하는
state version을 확인한다.

가장 큰 위험은 입력을 통한 명령 주입, 이벤트 재전송, 권한 없는 Discord 사용자,
승인 후 명세 변경, 비공개 데이터의 공개 승격, 로그의 자격 증명 노출이다. 이에 대해
결정론적 allowlist, DB unique constraint, revision에 묶인 승인, 공개 범위 hard deny,
구조화 로그 마스킹을 적용한다.

## Phase 0 보안 기준

- 실제 비밀값은 환경이나 secret manager에서만 주입한다.
- GitHub 읽기 자격 증명과 실행 쓰기 자격 증명을 분리한다.
- Discord 사용자·guild·channel ID allowlist를 기동 전에 검증한다.
- 외부 입력과 callback은 인증 실패 시 상태를 변경하지 않는다.
- 외부 실행은 task revision과 정확히 일치하는 유효한 승인 없이는 dispatch하지 않는다.
- 로그에서 token, authorization, cookie, password, payload 원문을 기본 제거한다.

## 재검토 조건

새 수집원, 새 공개 채널, 결제 기능, 다중 사용자, 관리형 실행기, 외부 object storage를
추가할 때 이 문서와 공격 경로를 다시 검토한다.
