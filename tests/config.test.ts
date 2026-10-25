import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEnvironment } from "../packages/config/src/index.js";

const validEnvironment = {
  RAPI_ENV: "test",
  DATABASE_URL: "postgresql://rapi:rapi@localhost:5432/rapi",
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_APPLICATION_ID: "1234567890",
  DISCORD_PUBLIC_KEY: "a".repeat(64),
  DISCORD_ALLOWED_USER_IDS: "100,200",
};

describe("environment configuration", () => {
  it("keeps the isolated public agent disabled until configured", () => {
    assert.equal(loadEnvironment(validEnvironment).PUBLIC_AGENT_ENABLED, false);
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        PUBLIC_AGENT_ENABLED: "true",
      }).PUBLIC_AGENT_ENABLED,
      true,
    );
  });

  it("ignores leftover OMP_* keys from an older .env", () => {
    const config = loadEnvironment({
      ...validEnvironment,
      OMP_ENDPOINT: "http://127.0.0.1:3200",
      OMP_CALLBACK_SECRET: "x",
      OMP_READY_URL: "not-a-url",
    });
    assert.equal(config.DATABASE_URL, validEnvironment.DATABASE_URL);
  });

  it("keeps the learner experiment off and requires its secrets when on", () => {
    assert.equal(
      loadEnvironment(validEnvironment).LEARNER_EXPERIMENT_ENABLED,
      false,
    );
    assert.throws(() =>
      loadEnvironment({
        ...validEnvironment,
        LEARNER_EXPERIMENT_ENABLED: "true",
      }),
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        LEARNER_EXPERIMENT_ENABLED: "true",
        DISCORD_SUPERADMIN_USER_IDS: "100",
        WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
        RAPI_PUBLIC_BASE_URL: "https://rapi.example",
      }).LEARNER_EXPERIMENT_ENABLED,
      true,
    );
  });

  it("keeps harness updates off and requires a SUPERADMIN when on", () => {
    const config = loadEnvironment(validEnvironment);
    assert.equal(config.HARNESS_UPDATES_ENABLED, false);
    assert.equal(config.HARNESS_UPDATES_BASE_BRANCH, "main");
    assert.throws(() =>
      loadEnvironment({ ...validEnvironment, HARNESS_UPDATES_ENABLED: "true" }),
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        HARNESS_UPDATES_ENABLED: "true",
        DISCORD_SUPERADMIN_USER_IDS: "100",
      }).HARNESS_UPDATES_ENABLED,
      true,
    );
  });

  it("keeps blog publishing and drafts off and requires a SUPERADMIN when on", () => {
    const config = loadEnvironment(validEnvironment);
    assert.equal(config.BLOG_PUBLISH_ENABLED, false);
    assert.equal(config.BLOG_DRAFTS_ENABLED, false);
    for (const flag of ["BLOG_PUBLISH_ENABLED", "BLOG_DRAFTS_ENABLED"]) {
      assert.throws(() =>
        loadEnvironment({ ...validEnvironment, [flag]: "true" }),
      );
      assert.equal(
        loadEnvironment({
          ...validEnvironment,
          [flag]: "true",
          DISCORD_SUPERADMIN_USER_IDS: "100",
        })[flag as "BLOG_PUBLISH_ENABLED"],
        true,
      );
    }
  });

  it("parses allowlists before application startup", () => {
    const config = loadEnvironment({
      ...validEnvironment,
      DISCORD_SUPERADMIN_USER_IDS: "100",
      DISCORD_ADMIN_ROLE_IDS: "300",
      DISCORD_USER_ROLE_IDS: "400,500",
      DISCORD_GUILD_MEMBERS_ARE_USERS: "true",
    });
    assert.deepEqual(config.DISCORD_ALLOWED_USER_IDS, ["100", "200"]);
    assert.deepEqual(config.DISCORD_SUPERADMIN_USER_IDS, ["100"]);
    assert.deepEqual(config.DISCORD_ADMIN_ROLE_IDS, ["300"]);
    assert.deepEqual(config.DISCORD_USER_ROLE_IDS, ["400", "500"]);
    assert.equal(config.DISCORD_GUILD_MEMBERS_ARE_USERS, true);
  });

  it("enables delivery by default and parses DELIVERY_ENABLED strictly", () => {
    assert.equal(loadEnvironment(validEnvironment).DELIVERY_ENABLED, true);
    assert.equal(
      loadEnvironment({ ...validEnvironment, DELIVERY_ENABLED: "true" })
        .DELIVERY_ENABLED,
      true,
    );
    assert.equal(
      loadEnvironment({ ...validEnvironment, DELIVERY_ENABLED: "false" })
        .DELIVERY_ENABLED,
      false,
    );
    assert.throws(
      () => loadEnvironment({ ...validEnvironment, DELIVERY_ENABLED: "yes" }),
      /DELIVERY_ENABLED/,
    );
  });

  it("reports invalid fields without exposing values", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          DATABASE_URL: "sqlite://local",
        }),
      /DATABASE_URL must use postgresql:\/\//,
    );
  });

  it("requires an encryption key for fixed managed webhook endpoints", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
        }),
      /WEBHOOK_ENCRYPTION_KEY and RAPI_PUBLIC_BASE_URL/,
    );
    const config = loadEnvironment({
      ...validEnvironment,
      RAPI_PUBLIC_BASE_URL: "https://rapi.example.com",
      WEBHOOK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    });
    assert.equal(config.DB_POOL_MAX, 5);
    assert.equal(config.DB_QUERY_TIMEOUT_MS, 5000);
  });

  it("requires SMTP credentials when SMTP is enabled in production", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          RAPI_ENV: "production",
          EMAIL_TRANSPORT: "smtp",
        }),
      /SMTP_HOST is required for SMTP/,
    );
  });

  it("requires certificate verification for production database connections", () => {
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          RAPI_ENV: "production",
          DATABASE_URL: "postgresql://rapi:rapi@example.com:5432/rapi",
        }),
      /sslmode=verify-full or verify-ca/,
    );
    assert.doesNotThrow(() =>
      loadEnvironment({
        ...validEnvironment,
        RAPI_ENV: "production",
      }),
    );
    assert.doesNotThrow(() =>
      loadEnvironment({
        ...validEnvironment,
        RAPI_ENV: "production",
        DATABASE_URL:
          "postgresql://rapi:rapi@example.com:5432/rapi?sslmode=verify-full",
      }),
    );
  });
});

describe("model gateway configuration", () => {
  it("is off by default and keeps the codex summarizer", () => {
    const config = loadEnvironment(validEnvironment);
    assert.equal(config.MODEL_API_BASE_URL, undefined);
    assert.equal(config.MODEL_API_KEY, undefined);
    assert.equal(config.MODEL_MONTHLY_BUDGET_USD, undefined);
    assert.equal(config.SUMMARIZER_BACKEND, "codex");
  });

  it("allows plain http only on loopback", () => {
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        MODEL_API_BASE_URL: "http://127.0.0.1:4000/v1",
      }).MODEL_API_BASE_URL,
      "http://127.0.0.1:4000/v1",
    );
    assert.throws(
      () =>
        loadEnvironment({
          ...validEnvironment,
          MODEL_API_BASE_URL: "http://gateway.example.com/v1",
        }),
      /HTTPS/,
    );
  });

  it("requires a configured client for the api summarizer", () => {
    assert.throws(
      () => loadEnvironment({ ...validEnvironment, SUMMARIZER_BACKEND: "api" }),
      /SUMMARIZER_BACKEND/,
    );
    assert.equal(
      loadEnvironment({
        ...validEnvironment,
        SUMMARIZER_BACKEND: "api",
        MODEL_API_BASE_URL: "https://api.openai.com/v1",
        MODEL_API_KEY: "k",
        MODEL_DEFAULT: "gpt-4o-mini",
        MODEL_MONTHLY_BUDGET_USD: "20",
      }).MODEL_MONTHLY_BUDGET_USD,
      20,
    );
  });
});
