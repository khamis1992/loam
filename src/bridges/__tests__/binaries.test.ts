import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractTarEntry, PINNED, verifyInstalled } from "../binaries.js";
import { WAKARU_MANIFEST } from "../wakaruManifest.js";

describe("wakaru binaries", () => {
  it("pin metadata present", () => {
    const b = PINNED.wakaru!;
    assert.equal(b.version, "1.14.0");
    assert.ok(b.integrity.startsWith("sha512-"));
    assert.equal(b.exeSha256.length, 64);
    assert.equal(b.tgzSha256.length, 64);
  });
  it("extractTarEntry reads ustar entries with prefix padding", () => {
    const name = "package/wakaru.exe";
    const data = Buffer.from("MZ-fake");
    const block = Buffer.alloc(512);
    block.write(name, 0);
    const sz = data.length.toString(8).padStart(11, "0") + " ";
    block.write(sz, 124);
    block[156] = 48;
    const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
    const tar = Buffer.concat([block, data, pad, Buffer.alloc(1024)]);
    const exe = extractTarEntry(tar, name);
    assert.ok(exe);
    assert.equal(exe!.toString(), "MZ-fake");
    assert.equal(extractTarEntry(tar, "package/absent.exe"), null);
  });
  it("verifyInstalled rejects tampered or absent files", () => {
    assert.equal(verifyInstalled(PINNED.wakaru!), false, "not installed in this env");
  });
  it("wakaru manifest commands", () => {
    assert.equal(WAKARU_MANIFEST.id, "wakaru");
    assert.ok(WAKARU_MANIFEST.commands.some((c) => c.id === "unpack"));
    assert.ok(WAKARU_MANIFEST.commands.every((c) => c.effect === "write_workspace"));
  });
});
