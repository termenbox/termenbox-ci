import test from "node:test";
import assert from "node:assert/strict";
import { problems } from "./verify_origin.mjs";

const page = '<script type="module" src="/assets/a-1.js"></script><link rel="stylesheet" href="/assets/a-1.css">';
function site(over = {}) {
  const files = {
    "/": ["text/html; charset=utf-8", page],
    "/assets/a-1.js": ["application/javascript", "x"],
    "/assets/a-1.css": ["text/css; charset=utf-8", "x"],
    "/sw.js": ["application/javascript", "x"],
    "/manifest.webmanifest": ["application/manifest+json", "{}"],
    "/i": ["text/plain; charset=utf-8", "MIN_BUNDLE_VERSION=1"],
    ...over,
  };
  return async (url) => {
    const path = new URL(url).pathname;
    const f = files[path];
    if (f === null) return new Response("<html>app</html>", { status: 200, headers: { "content-type": "text/html", "cache-control": "public, max-age=31536000, immutable" } });
    if (!f) return new Response("nope", { status: 404, headers: { "content-type": "text/html", "cache-control": "no-store" } });
    return new Response(f[1], { status: 200, headers: { "content-type": f[0] } });
  };
}
const run = (over, channel = "beta") => problems("https://o.example", channel, site(over));

test("a usable origin has no problems", async () => assert.deepEqual(await run({}), []));
test("a stylesheet answered with the app page is named", async () => {
  const p = await run({ "/assets/a-1.css": ["text/html", "<html>"] });
  assert.deepEqual(p, ["/assets/a-1.css answers a page"]);
});
test("a missing asset is named by status", async () => {
  assert.deepEqual(await run({ "/assets/a-1.js": undefined }), ["/assets/a-1.js answers 404"]);
});
test("a fallback page for a missing file is named, with its cache mark", async () => {
  const ok = site({});
  const q = await problems("https://o.example", "beta", async (u) => (new URL(u).pathname.startsWith("/assets/missing-")
    ? new Response("<html>", { status: 200, headers: { "content-type": "text/html", "cache-control": "public, immutable" } }) : ok(u)));
  assert.deepEqual(q, ["a missing /assets/ file answers 200", "a missing /assets/ file is marked immutable"]);
});
test("the installer is not required on nightly", async () => assert.deepEqual(await run({ "/i": undefined }, "nightly"), []));
test("the installer must be text on stable", async () => assert.equal((await run({ "/i": ["text/html", "<html>"] }, "stable")).length, 1));
