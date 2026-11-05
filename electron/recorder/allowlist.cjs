/*
 * Explicit allow-list for Loam Recorder IPC. There is no generic passthrough:
 * a channel that is not in methods.json is rejected by main and by the host.
 */
const fs = require("node:fs");
const path = require("node:path");

const METHODS = Object.freeze(
  JSON.parse(fs.readFileSync(path.join(__dirname, "methods.json"), "utf8")).methods,
);

function isRecorderChannel(channel) {
  return typeof channel === "string" && METHODS.includes(channel);
}

module.exports = { METHODS, isRecorderChannel };
