# 독립 crawler 연결

Go/Playwright `rapi-crawler`와 연결하는 CrawlerCollector를 구현했다. runtime의 collection loop에서 `CRAWLER_ENDPOINT`와 `CRAWLER_CALLER_TOKEN`으로 client를 생성한다. 크롤러에는 본체 DB credential을 전달하지 않는다.

먼저 기존 migration 절차로 `0014_crawler_collection.sql`을 적용한다. source collection_policy의 crawler에는 enabled, 독립 registry sourceId, tenantId, requirements, pipeline, limits를 명시한다. browser가 포함된 source는 기존 `kind='aside'`, private, ownerId를 사용해 owner-only subscription/delivery 경계를 유지한다. RSS-only source는 기존 RSS kind를 사용할 수 있다.

요청을 DB에 저장하고 그 UUID를 Idempotency-Key로 사용한다. 결과 page ingestion, 기존 raw/normalized item 저장, receipt와 cursor는 같은 transaction이다. 요구 수준보다 낮은 listing은 detail 원문으로 저장하지 않는다. source policy hash를 제출·ingestion 때 다시 검사한다. 전환된 출처는 native RSS/GitHub collector에서 제외된다. Mac Aside collector는 제거됐다(D-011).

source 삭제는 DB trigger가 remote cleanup UUID를 outbox에 먼저 남겨 local binding이 cascade 삭제돼도 취소·purge를 계속한다. source 변경/비활성화는 신규 ingestion을 차단하고 remote job을 취소한다. 종료 후 DELETE items로 중간 원문을 purge한다. 본체 자료의 삭제/보존/tombstone은 기존 privacy 경로가 담당한다. 전환 시 기존 worker의 drain을 먼저 수행한다. 이번 작업에서 운영 source policy를 바꾸거나 운영 worker를 재시작하지 않았다.

client의 재현 가능한 설치 파일은 vendor/rapi-crawler-client-0.2.0.tgz이며 OpenAPI를 포함한다. 갱신은 crawler에서 `npm pack ./node --pack-destination /path/to/rapi-agent/vendor`, 본체에서 `npm install --save-exact ./vendor/rapi-crawler-client-0.2.0.tgz`로 한다. 실제 실행 설정과 예시는 sibling crawler의 docs/operations.md를 참고한다.

통합 검증은 별도 `_test` PostgreSQL과 임시 schema에서 수행한다. crawler checkout의 scripts/agent-integration.mts가 Go 서버·fixture·Chromium worker를 시작하고 이 본체의 tests/e2e/crawler-collection.test.ts를 실행한다. 실제 원문 ingestion, 중복 방지, transaction rollback, private source/tombstone 보존과 disabled-source 취소를 검증한다. 운영 서비스 배포와 뉴스레터 발송은 별도 작업이다.

공개 원문 실수집 통합 검사는 `tests/e2e/crawler-public-sources.test.ts`다. crawler의 newsletter-smoke가 실제 endpoint와 별도 `_test` DB를 전달하면 Hugging Face·GitHub Changelog·Cloudflare에서 새 수집 작업을 제출하고 15건 원문 ingestion·반복 receipt·private 경계를 확인한다. `@rapi/crawler-client/issue`는 최신성·원문 근거·최소 건수·서로 다른 출처 도메인을 검증하고 `hold` 또는 `ready_for_editorial_review`를 반환한다. 아직 runtime의 실제 발송 결정에 붙이지 않았으므로 운영 발송 경로를 바꾸었다고 해석하지 않는다.
