// node --test worker/app-token.test.mjs : the dispatcher app's token is minted with a valid signature, limited to the
// ci repo and its permissions, reused until near expiry, and a failure throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { installationToken } from "./app-token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const NOW = 1_800_000_000;
const expires = new Date((NOW + 3600) * 1000).toISOString();

function fake(log, { instStatus = 200, tokStatus = 201 } = {}) {
  return async (url, init = {}) => {
    log.push({ url, init });
    if (url.endsWith("/installation")) return { ok: instStatus === 200, status: instStatus, json: async () => ({ id: 42 }) };
    return { ok: tokStatus === 201, status: tokStatus, json: async () => ({ token: "ghs_minted", expires_at: expires }) };
  };
}

test("mints a token limited to one repository and permission, signed by the app", async () => {
  const log = [];
  const t = await installationToken({ appId: 123, pem, repo: "termenbox/termenbox-ci", permissions: { contents: "write" }, fetchFn: fake(log), now: NOW });
  assert.equal(t, "ghs_minted");
  assert.equal(log[0].url, "https://api.github.com/repos/termenbox/termenbox-ci/installation");
  assert.equal(log[1].url, "https://api.github.com/app/installations/42/access_tokens");
  assert.deepEqual(JSON.parse(log[1].init.body), { repositories: ["termenbox-ci"], permissions: { contents: "write" } });
  const [h, b, s] = log[0].init.headers.authorization.replace("Bearer ", "").split(".");
  assert.deepEqual(JSON.parse(Buffer.from(b, "base64url")), { iat: NOW - 60, exp: NOW + 540, iss: "123" });
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "RS256");
  assert.ok(createVerify("RSA-SHA256").update(`${h}.${b}`).verify(publicKey, Buffer.from(s, "base64url")));
});

test("a token is reused until five minutes before it expires", async () => {
  const log = [];
  const args = { appId: 124, pem, repo: "termenbox/termenbox-ci", permissions: { contents: "write" }, fetchFn: fake(log) };
  await installationToken({ ...args, now: NOW });
  await installationToken({ ...args, now: NOW + 3000 });
  assert.equal(log.length, 2);
  await installationToken({ ...args, now: NOW + 3400 });
  assert.equal(log.length, 4);
});

test("a refused lookup or token request throws", async () => {
  const base = { pem, repo: "termenbox/termenbox-ci", permissions: { contents: "write" }, now: NOW };
  await assert.rejects(installationToken({ ...base, appId: 125, fetchFn: fake([], { instStatus: 404 }) }), /installation lookup failed: 404/);
  await assert.rejects(installationToken({ ...base, appId: 126, fetchFn: fake([], { tokStatus: 403 }) }), /token request failed: 403/);
});
