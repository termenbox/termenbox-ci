// node release/verify_origin.mjs <origin> <channel> [seconds]
// Reads a deployed client origin the way a browser would and fails when it is not usable: the page names assets that do
// not answer with a script or a stylesheet, the worker or manifest is missing, the installer is not served as text, or a
// file that does not exist is answered with a page or marked as cacheable for good. It retries until the time is up
// (a new deployment can take a moment to reach every edge) and prints paths and status codes only.
const [origin, channel, seconds = "120"] = process.argv.slice(2);

const KIND = { js: /javascript/i, mjs: /javascript/i, css: /^text\/css/i, svg: /svg/i, json: /json/i, webmanifest: /json/i };

export async function problems(origin, channel, get = (url) => fetch(url, { headers: { "cache-control": "no-cache" }, redirect: "manual" })) {
  const out = [];
  const read = async (path) => {
    const res = await get(origin + path);
    return { status: res.status, type: res.headers.get("content-type") ?? "", cache: res.headers.get("cache-control") ?? "", text: await res.text() };
  };
  const home = await read("/");
  if (home.status !== 200 || !/text\/html/i.test(home.type)) out.push(`/ answers ${home.status} ${home.type}`);
  const assets = [...home.text.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map((m) => m[1]);
  if (!assets.length) out.push("/ names no /assets/ file");
  for (const a of assets) {
    const r = await read(a);
    const ext = a.split(".").pop();
    if (r.status !== 200) out.push(`${a} answers ${r.status}`);
    else if (/text\/html/i.test(r.type)) out.push(`${a} answers a page`);
    else if (KIND[ext] && !KIND[ext].test(r.type)) out.push(`${a} answers ${r.type}`);
  }
  for (const p of ["/sw.js", "/manifest.webmanifest"]) {
    const r = await read(p);
    if (r.status !== 200 || /text\/html/i.test(r.type)) out.push(`${p} answers ${r.status} ${r.type}`);
  }
  if (channel !== "nightly") {
    const r = await read("/i");
    if (r.status !== 200 || /text\/html/i.test(r.type) || !r.text.includes("MIN_BUNDLE_VERSION")) out.push(`/i answers ${r.status} ${r.type}`);
  }
  const miss = await read(`/assets/missing-${Date.now()}.css`);
  if (miss.status !== 404) out.push(`a missing /assets/ file answers ${miss.status}`);
  if (/immutable/i.test(miss.cache)) out.push("a missing /assets/ file is marked immutable");
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin ?? "") || !channel) { console.error("usage: verify_origin.mjs https://host channel [seconds]"); process.exit(2); }
  const end = Date.now() + Number(seconds) * 1000;
  let list;
  for (;;) {
    try { list = await problems(origin, channel); } catch (e) { list = [`request failed: ${e.cause?.code ?? e.name}`]; }
    if (!list.length || Date.now() > end) break;
    await new Promise((r) => setTimeout(r, 10000));
  }
  for (const p of list) console.log(p);
  if (list.length) process.exit(1);
  console.log(`${origin} serves a usable client`);
}
