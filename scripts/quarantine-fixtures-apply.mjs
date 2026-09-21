const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function buildQuarantineUpdate(ids) {
  if (!Array.isArray(ids) || ids.length === 0)
    throw new Error("Quarantine update requires at least one subscription id");
  if (ids.some((id) => typeof id !== "string" || !UUID.test(id)))
    throw new Error("Quarantine update requires UUID subscription ids");
  if (new Set(ids).size !== ids.length)
    throw new Error("Quarantine update must not repeat subscription ids");
  return {
    text: `UPDATE subscriptions
           SET state='inactive', updated_at=now()
           WHERE id = ANY($1::uuid[]) AND state = 'active'
           RETURNING id`,
    values: [ids],
  };
}
