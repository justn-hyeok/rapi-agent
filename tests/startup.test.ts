import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startBot } from "../apps/bot/src/main.js";

describe("bot startup", () => {
  it("rejects invalid configuration before connecting the runtime", async () => {
    let connected = false;

    await assert.rejects(
      startBot(
        {
          connect: () => {
            connected = true;
            return Promise.resolve();
          },
        },
        {},
      ),
      /Invalid environment configuration/,
    );

    assert.equal(connected, false);
  });
});
