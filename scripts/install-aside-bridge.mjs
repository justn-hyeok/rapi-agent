import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { managedPreviousVersion } from "./aside-install-guard.mjs";

if (process.platform !== "darwin")
  throw new Error("Aside bridge requires this Mac's Aside installation");
const root = join(
  homedir(),
  "Library",
  "Application Support",
  "Rapi",
  "aside-bridge",
);
const label = "me.justn.rapi-aside-bridge";
const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
const configPath = join(root, "config.json");
const scripts = dirname(fileURLToPath(import.meta.url));
const files = await Promise.all(
  ["aside-bridge.mjs", "aside-browser.mjs"].map(async (name) => ({
    name,
    contents: await readFile(join(scripts, name)),
  })),
);
const digest = createHash("sha256")
  .update(Buffer.concat(files.map((file) => file.contents)))
  .digest("hex");
const versionPath = join(root, digest);
const config = {
  sshHost: "rapi-agent",
  asideBinary: join(homedir(), ".local", "bin", "aside"),
  statusFile: join(root, "status.json"),
  instructions: join(
    homedir(),
    ".agents",
    "skills",
    "aside-local-qa",
    "SKILL.md",
  ),
  mechanics: join(
    homedir(),
    ".agents",
    "skills",
    "aside-local-qa",
    "references",
    "aside-mechanics.md",
  ),
};
for (const name of ["asideBinary", "instructions", "mechanics"])
  await access(config[name]);
const json = JSON.stringify(config, null, 2) + "\n";
let oldConfig;
try {
  oldConfig = await readFile(configPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (oldConfig && oldConfig !== json)
  throw new Error(
    "Existing Aside bridge settings differ; refusing to overwrite",
  );
const xml = (text) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const args = [
  process.execPath,
  join(versionPath, "aside-bridge.mjs"),
  configPath,
];
const payload = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(root, "bridge.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(root, "bridge-error.log"))}</string>
</dict></plist>\n`;
let oldPlist;
try {
  oldPlist = await readFile(plist, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (oldPlist && oldPlist !== payload) {
  const existing = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], {
      encoding: "utf8",
    }),
  );
  // Verify fixed fields against our own payload, never trust existing policy.
  const expectedPolicy = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: payload,
      encoding: "utf8",
    }),
  );
  const oldVersion = managedPreviousVersion(
    existing,
    expectedPolicy,
    root,
  );
  const oldFiles = await Promise.all(
    files.map((file) => readFile(join(oldVersion, file.name))),
  );
  if (
    createHash("sha256").update(Buffer.concat(oldFiles)).digest("hex") !==
    oldVersion.slice(oldVersion.lastIndexOf("/") + 1)
  )
    throw new Error("Existing managed Aside bridge files were modified");
}
for (const file of files) {
  try {
    const installed = await readFile(join(versionPath, file.name));
    if (!installed.equals(file.contents))
      throw new Error("Installed Aside bridge digest differs");
    file.installed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
// Validate every refusal condition before touching the live installation.
// Both runtime files live in an immutable version directory referenced by plist.
await mkdir(versionPath, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
for (const file of files) {
  if (!file.installed)
    await writeFile(join(versionPath, file.name), file.contents, {
      flag: "wx",
      mode: 0o600,
    });
}
await writeFile(configPath, json, { mode: 0o600 });
await mkdir(dirname(plist), { recursive: true });
await writeFile(plist, payload, { mode: 0o600 });
execFileSync("/usr/bin/plutil", ["-lint", plist], { stdio: "ignore" });
const domain = `gui/${process.getuid()}`;
let loaded = true;
try {
  execFileSync("/bin/launchctl", ["print", `${domain}/${label}`], {
    stdio: "ignore",
  });
} catch {
  loaded = false;
}
if (loaded && oldPlist !== payload) {
  execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`], {
    stdio: "ignore",
  });
  loaded = false;
}
if (!loaded)
  execFileSync("/bin/launchctl", ["bootstrap", domain, plist], {
    stdio: "ignore",
  });
process.stdout.write(JSON.stringify({ installed: true, label, root }) + "\n");
