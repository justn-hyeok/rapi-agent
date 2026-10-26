# n8n 연동

라피는 블로그 글이 공개되면 서명된 이벤트(`blog.published`)를 자동화 도구에 보낸다. n8n은
그 이벤트를 받아 외부로 잇는 자리다. 저장소에는 로컬 전용 n8n 구성과 워크플로 하나가 있다.
**운영 VM에는 아직 배포하지 않았다.** 아래 "운영에 올릴 때"를 소유자가 직접 결정한다.

## 흐름

```
블로그 PR 병합 ─▶ 워커(BlogService) ─▶ POST AUTOMATION_WEBHOOK_URL
                    서명: HMAC-SHA256("<timestamp>.<body>")
                                   │
                                   ▼
        n8n Webhook ─▶ Verify signature ─▶ Signature valid? ─예─▶ Format ─▶ Discord 공지
                       (HMAC 재계산·5분 이내)              └아니오─▶ 버림
```

- 이벤트는 `{"type":"blog.published","data":{"slug","title","url"},"at":"<ISO 시각>"}`다.
- 헤더 `x-rapi-timestamp`(초)와 `x-rapi-signature: sha256=<hex>`가 붙는다. 수신 쪽은 같은
  비밀로 `"<timestamp>.<원문 본문>"`의 HMAC을 다시 계산해 상수 시간으로 비교하고, 시각이
  5분 넘게 차이 나면 버린다(재전송 방지).
- 라피는 응답을 5초만 기다리고, 실패해도 게시나 DM에 영향이 없다. 경고만 로그에 남는다.
- 보낼 수 있는 곳은 `https` 주소 또는 이 기계의 `http`(127.0.0.1, localhost, ::1)뿐이다. 주소에
  사용자·비밀번호는 넣을 수 없고 리다이렉트는 따라가지 않는다.

## 파일

| 파일 | 역할 |
|---|---|
| `ops/n8n/compose.yaml` | n8n 2.43.3, `127.0.0.1:5678`에만 바인딩, 텔레메트리 끔 |
| `ops/n8n/rapi-blog-announce.workflow.json` | 서명 검증 후 Discord에 공지하는 워크플로 |
| `packages/agent/src/automation-events.ts` | 이벤트 발신(`AutomationNotifier`) |

## 설정

라피 `.env`(값은 출력하지 않는다):

```
AUTOMATION_WEBHOOK_URL=http://127.0.0.1:5678/webhook/rapi-blog
AUTOMATION_WEBHOOK_SECRET=<무작위 16자 이상>
```

URL과 비밀은 함께 설정해야 한다. 둘 다 없으면 이벤트를 보내지 않는다. 워커가 읽으므로
바꾼 뒤 `rapi-worker`를 재시작한다.

n8n env 파일(저장소 밖, 예: `/home/justn/secrets/n8n.env`, mode 0600):

```
N8N_ENCRYPTION_KEY=<무작위 32바이트 hex>
RAPI_AUTOMATION_SECRET=<위 AUTOMATION_WEBHOOK_SECRET과 같은 값>
DISCORD_ANNOUNCE_WEBHOOK=<공지할 채널의 Discord 웹훅 URL>
```

## 로컬 검증

```
docker compose --project-name rapi-n8n-local --env-file /path/to/n8n.env -f ops/n8n/compose.yaml up --detach
docker compose --project-name rapi-n8n-local exec n8n n8n import:workflow --input=/tmp/rapi-blog-announce.workflow.json
```

워크플로를 가져오려면 컨테이너 안에서 `n8n import:workflow --input=...`를 쓰고 `n8n update:workflow
--id=rapiBlogAnnounce1 --active=true` 뒤 컨테이너를 재시작한다.

**검증 기록(2026-10-27)**: compose가 고정한 n8n 2.43.3 컨테이너(새 볼륨)에서 워크플로를 가져와 활성화한 뒤,
서명된 요청 네 건을 보냈다. 틀린 비밀, 10분 지난 시각, 다른 이벤트 종류의 요청은 Discord 대역 서버에
아무것도 보내지 않았고, 올바른 요청만 `@`와 `<`, `>`가 제거된 제목과 `allowed_mentions: {parse: []}`가
붙은 공지를 보냈다. 서버가 완전히 뜨기 전에 `import:workflow`를 실행하면 마이그레이션이 깨지므로,
`/healthz`가 200이 된 뒤에 가져오고 활성화한 다음 컨테이너를 재시작한다. 이전(2026-10-26) 시험은 2.22.5였다.

워크플로를 가져온 뒤 n8n에서 활성화하고 `DISCORD_ANNOUNCE_WEBHOOK`을 시험용 주소로 둔 채,
서명된 이벤트를 `POST http://127.0.0.1:5678/webhook/rapi-blog`로 보내 실행 기록을 확인한다.
잘못된 서명, 오래된 시각, 다른 이벤트 종류는 "Rejected"로 끝나야 한다.

## 운영 배포 현황 (2026-10-27)

운영 VM에 올라가 있다.

- 컨테이너 `rapi-n8n-n8n-1`(프로젝트 `rapi-n8n`), 이미지 2.43.3, `127.0.0.1:5678`에만 바인딩. 데이터는 볼륨
  `rapi-n8n_n8n-data`.
- 비밀은 `/home/justn/secrets/n8n.env`(0600)에 있다. 라피 `.env`에는 `AUTOMATION_WEBHOOK_URL`과
  `AUTOMATION_WEBHOOK_SECRET`(위 파일의 `RAPI_AUTOMATION_SECRET`과 같은 값)이 있다.
- 공지 채널은 `#라피-블로그-공지`다. 서명된 시험 이벤트 한 건은 공지 하나가 되고, 틀린 서명은 버려졌다.
- 관리 화면은 `ssh -L 5678:127.0.0.1:5678 rapi-agent` 터널로 연다. 소유자 계정은 아직 만들지 않았다.

다시 올리거나 다른 기계에 옮길 때:

1. `n8n.env`를 만든다(비밀은 무작위로 생성하고 출력하지 않는다).
2. `docker compose --project-name rapi-n8n --env-file <n8n.env> -f ops/n8n/compose.yaml up --detach`.
3. `/healthz`가 200이 된 뒤에 워크플로를 가져와 활성화하고 컨테이너를 재시작한다(위 로컬 검증 참고).
4. 라피 `.env`에 위 두 값을 넣고 `rapi-worker`를 재시작한 뒤, 시험 이벤트로 공지가 한 번 가는지 확인한다.

n8n 이미지는 약 1.8GB다.
