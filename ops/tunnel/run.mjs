import { spawn } from "node:child_process";

const botToken = process.env.DISCORD_BOT_TOKEN;
if (!botToken) throw new Error("DISCORD_BOT_TOKEN is required");

const tunnel = spawn(
  "/usr/bin/cloudflared",
  ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:3000"],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let output = "";
let configuring = false;

async function configureDiscord(origin) {
  if (configuring) return;
  configuring = true;
  const endpoint = `${origin}/interactions`;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(
        "https://discord.com/api/v10/applications/@me",
        {
          method: "PATCH",
          headers: {
            authorization: `Bot ${botToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ interactions_endpoint_url: endpoint }),
        },
      );
      if (response.ok) {
        process.stdout.write(
          `Discord interaction endpoint configured: ${endpoint}\n`,
        );
        return;
      }
      await response.arrayBuffer();
    } catch {
      // The quick tunnel can take a few seconds to accept public traffic.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  process.stderr.write(
    "Could not configure the Discord interaction endpoint\n",
  );
  tunnel.kill("SIGTERM");
  process.exitCode = 1;
}

function consume(chunk) {
  const text = chunk.toString();
  process.stdout.write(text);
  output = (output + text).slice(-20_000);
  const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  if (match) void configureDiscord(match[0]);
}

tunnel.stdout.on("data", consume);
tunnel.stderr.on("data", consume);
tunnel.on("error", (error) => {
  process.stderr.write(`cloudflared failed: ${error.message}\n`);
  process.exitCode = 1;
});
tunnel.on("exit", (code, signal) => {
  if (signal) process.stderr.write(`cloudflared stopped by ${signal}\n`);
  process.exit(code ?? 1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => tunnel.kill(signal));
}
