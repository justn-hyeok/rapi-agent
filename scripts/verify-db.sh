#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

compose=(docker compose)
if ! docker info >/dev/null 2>&1 && sudo -n docker info >/dev/null 2>&1; then
  compose=(sudo docker compose)
fi

for _ in $(seq 1 30); do
  if "${compose[@]}" exec -T postgres pg_isready -U rapi -d rapi >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

"${compose[@]}" exec -T postgres pg_isready -U rapi -d rapi >/dev/null

table_count=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public';")

if [[ "$table_count" -lt 21 ]]; then
  echo "Expected at least 21 public tables after migration, found $table_count." >&2
  exit 1
fi

webhook_table_count=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('webhook_connections','webhook_receipts');")
if [[ "$webhook_table_count" -ne 2 ]]; then
  echo "Expected both managed webhook tables, found $webhook_table_count." >&2
  exit 1
fi

index_count=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
  "SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('raw_events_external_id_unique', 'raw_events_payload_hash_unique');")

chatops_table_count=$("${compose[@]}" exec -T postgres psql -U rapi -d rapi -Atc \
  "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('chatops_runs', 'chatops_events', 'chatops_memory', 'chatops_memory_events');")

if [[ "$index_count" -ne 2 ]]; then
  echo "Expected both raw-event idempotency indexes, found $index_count." >&2
  exit 1
fi

if [[ "$chatops_table_count" -ne 4 ]]; then
  echo "Expected all 4 ChatOps capability tables, found $chatops_table_count." >&2
  exit 1
fi

echo "PostgreSQL migration verified: $table_count tables, 2 idempotency indexes, 4 ChatOps tables."
