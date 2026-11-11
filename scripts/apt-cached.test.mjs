// node --test scripts/apt-cached.test.mjs : the apt-cached action's script, run against stub apt-get, dpkg and sudo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../.github/actions/apt-cached/apt-cached.sh", import.meta.url).pathname;

function sandbox({ aptFails = 0, dpkgFails = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), "apt-"));
  const bin = join(d, "bin"), archives = join(d, "archives"), debs = join(d, "debs");
  mkdirSync(bin); mkdirSync(archives);
  const sh = (name, body) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  // apt-get update fails `aptFails` times; install drops a .deb into the archive and logs the call.
  sh("apt-get", `echo "apt-get $*" >> "${d}/log"
if [ "$1" = update ]; then n=$(cat "${d}/n" 2>/dev/null || echo 0); echo $((n+1)) > "${d}/n"; [ "$n" -ge ${aptFails} ]; exit; fi
touch "${archives}/p.deb"`);
  sh("dpkg", `if [ "$1" = --print-architecture ]; then echo amd64; exit 0; fi
echo "dpkg $*" >> "${d}/log"; ${dpkgFails ? "exit 1" : "exit 0"}`);
  const run = (...args) => {
    const out = join(d, "out");
    const r = spawnSync("sh", [script, ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, GITHUB_OUTPUT: out, APT_DEBS: debs, APT_ARCHIVES: archives, APT_WAITS: "0 0 0", APT_SUDO: "", APT_SOURCES: join(d, "none"), ImageVersion: "20261101.1" },
      encoding: "utf8",
    });
    let o = ""; try { o = readFileSync(out, "utf8"); } catch {}
    let log = ""; try { log = readFileSync(join(d, "log"), "utf8"); } catch {}
    return { status: r.status, out: o, log, debs, archives };
  };
  return { run, debs };
}

test("the key names group, architecture, image and packages", () => {
  const r = sandbox().run("key", "static", "musl-tools cmake");
  assert.equal(r.status, 0);
  assert.match(r.out, /^key=apt-static-[a-z0-9_]+-20261101\.1-musl-tools-cmake\n$/);
});

test("a miss installs with apt-get and keeps the .deb files", () => {
  const r = sandbox().run("install", "tmux", "false");
  assert.equal(r.status, 0);
  assert.match(r.log, /apt-get install -y tmux/);
  assert.match(r.out, /saved=true/);
});

test("a hit installs from the files and does not call apt-get", () => {
  const s = sandbox();
  mkdirSync(s.debs); writeFileSync(join(s.debs, "a.deb"), "");
  const r = s.run("install", "tmux", "true");
  assert.equal(r.status, 0);
  assert.match(r.log, /dpkg -i .*a\.deb/);
  assert.doesNotMatch(r.log, /apt-get/);
  assert.equal(r.out, "");
});

test("a hit that does not install falls back to apt-get", () => {
  const s = sandbox({ dpkgFails: true });
  mkdirSync(s.debs); writeFileSync(join(s.debs, "a.deb"), "");
  const r = s.run("install", "tmux", "true");
  assert.equal(r.status, 0);
  assert.match(r.log, /apt-get install -y tmux/);
  assert.match(r.out, /saved=true/);
});

test("an apt-get that fails twice is retried", () => {
  const r = sandbox({ aptFails: 2 }).run("install", "tmux", "false");
  assert.equal(r.status, 0);
  assert.equal((r.log.match(/apt-get update/g) || []).length, 3);
});

test("an apt-get that never works fails the step", () => {
  assert.notEqual(sandbox({ aptFails: 99 }).run("install", "tmux", "false").status, 0);
});
