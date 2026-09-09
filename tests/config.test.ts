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
    });
    assert.deepEqual(config.DISCORD_ALLOWED_USER_IDS, ["100", "200"]);
    assert.deepEqual(config.DISCORD_SUPERADMIN_USER_IDS, ["100"]);
    assert.deepEqual(config.DISCORD_ADMIN_ROLE_IDS, ["300"]);
    assert.deepEqual(config.DISCORD_USER_ROLE_IDS, ["400", "500"]);
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
});
