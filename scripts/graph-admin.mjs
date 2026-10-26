// Read-only helper for the knowledge graph.
//
//   node --env-file=.env scripts/graph-admin.mjs estimate   documents left to extract and the model cost
//   node --env-file=.env scripts/graph-admin.mjs report     entities and relations found so far
//
// estimate uses MODEL_FOR_GRAPH_EXTRACT (else MODEL_DEFAULT) and ops/model-prices.json;
// pass --input-usd=<per 1M> --output-usd=<per 1M> to price a model that is not in the table.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const pg = createRequire(import.meta.url)("pg");
const say = (line) => process.stdout.write(`${line}\n`);
const flag = (name) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];

// Prompt and reply sizes of GraphExtractor: fixed system text plus the post, a JSON answer.
const PROMPT_TOKENS = 260;
const REPLY_TOKENS = 450;
const CHARS_PER_TOKEN = 2.5;

const command = process.argv[2];
if (!["estimate", "report"].includes(command ?? "")) {
  say("usage: graph-admin.mjs estimate|report");
  process.exit(2);
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  if (command === "estimate") {
    const { rows } = await client.query(
      `SELECT count(*)::int AS documents,
              COALESCE(sum(least(char_length(d.title),200)+least(char_length(d.summary),600)),0)::int AS chars
         FROM archive_documents d LEFT JOIN graph_extractions x ON x.document_key=d.key
        WHERE x.document_key IS NULL OR x.content_hash <> md5(d.title||E'\\n'||d.summary)`,
    );
    const { documents, chars } = rows[0];
    const inputTokens =
      Math.ceil(chars / CHARS_PER_TOKEN) + documents * PROMPT_TOKENS;
    const outputTokens = documents * REPLY_TOKENS;
    say(`documents to extract: ${documents}`);
    say(`estimated tokens: ${inputTokens} in, ${outputTokens} out`);
    const model =
      process.env.MODEL_FOR_GRAPH_EXTRACT || process.env.MODEL_DEFAULT;
    let input = flag("input-usd") && Number(flag("input-usd"));
    let output = flag("output-usd") && Number(flag("output-usd"));
    if (!input || !output) {
      try {
        const table = JSON.parse(
          readFileSync(
            process.env.MODEL_PRICES_FILE || "ops/model-prices.json",
            "utf8",
          ),
        ).models?.[model ?? ""];
        if (table) {
          input = table.inputMicroUsdPerMillion / 1e6;
          output = table.outputMicroUsdPerMillion / 1e6;
        }
      } catch {
        // No readable price table: fall through to the flags message below.
      }
    }
    if (input && output) {
      const usd = (inputTokens * input + outputTokens * output) / 1e6;
      say(
        `model ${model ?? "(flags)"}: about $${usd.toFixed(3)} (rough, +/-50%)`,
      );
    } else {
      say(
        `no price known for ${model ?? "any model"}; pass --input-usd and --output-usd`,
      );
    }
  } else {
    const entities = await client.query(
      `SELECT e.name,e.kind,count(m.*)::int AS posts
         FROM graph_entities e LEFT JOIN graph_mentions m ON m.entity_id=e.id
        GROUP BY e.id ORDER BY posts DESC, e.name LIMIT 50`,
    );
    say(`top entities (${entities.rowCount}):`);
    for (const row of entities.rows)
      say(`  ${row.name} [${row.kind}] x${row.posts}`);
    const edges = await client.query(
      `SELECT s.name AS source,e.relation,t.name AS target,count(*)::int AS posts
         FROM graph_edges e JOIN graph_entities s ON s.id=e.source_id
         JOIN graph_entities t ON t.id=e.target_id
        GROUP BY 1,2,3 ORDER BY posts DESC, 1 LIMIT 50`,
    );
    say(`relations (${edges.rowCount}):`);
    for (const row of edges.rows)
      say(`  ${row.source} -[${row.relation}]-> ${row.target} x${row.posts}`);
    const done = await client.query(
      "SELECT count(*)::int AS n FROM graph_extractions",
    );
    say(`documents extracted: ${done.rows[0].n}`);
  }
} finally {
  await client.end();
}
