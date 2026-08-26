#!/usr/bin/env node
/**
 * codemod: RoomConfig renames stub (plans/08 Phase 4.2, docs/guides/migration.md:11)
 * Table useLegacyTable analogue — run via jscodeshift when breaking renames land.
 * Today: dry-run text replacement stub; replace with jscodeshift transform at v0.2.
 * Usage: node codemods/room-config-rename.mjs [--write] [files...]
 * For changeset fixed groups see .changeset/config.json:7 and changeset version --dry-run.
 */
import { readFileSync, writeFileSync } from "node:fs";
const renames = [
  [/recordingEndpoint\s*:/g, "recording: { endpoint:"],
  [/sfuGateway\s*:/g, "sfu: { gateway:"],
  [/\biceServers\s*:/g, "rtc: { iceServers:"],
];
const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const write = process.argv.includes("--write");
if (!files.length) {
  console.log("RoomConfig codemod stub — renames: recordingEndpoint→recording.endpoint, sfuGateway→sfu.gateway, iceServers→rtc.iceServers");
  console.log("Pass file paths and --write to apply (jscodeshift wiring TODO). Example: node codemods/room-config-rename.mjs --write packages/*/src/*.ts");
  process.exit(0);
}
for (const f of files) {
  let src = readFileSync(f, "utf8");
  let out = src;
  for (const [re, repl] of renames) out = out.replace(re, repl);
  if (out !== src) {
    console.log(`${f}: would rename`);
    if (write) writeFileSync(f, out);
  }
}
