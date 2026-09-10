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
