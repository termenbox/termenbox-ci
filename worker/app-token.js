// An installation token of a GitHub app, minted from the app's id and PKCS#8 private key (a Worker secret) and kept until
// shortly before it expires. The token is limited to the repositories and permissions asked for here, never the app's all.
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const text = (s) => new TextEncoder().encode(s);

async function appJwt(appId, pem, now) {
  const der = Uint8Array.from(atob(pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = b64url(text(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const body = b64url(text(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, text(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

const cache = new Map();

// repo is "owner/name"; permissions is e.g. { contents: "write" }. `fetchFn` and `now` (seconds) are for the tests.
export async function installationToken({ appId, pem, repo, permissions, fetchFn = fetch, now = Math.floor(Date.now() / 1000) }) {
  const id = `${appId}/${repo}/${JSON.stringify(permissions)}`;
  const hit = cache.get(id);
  if (hit && hit.exp - now > 300) return hit.token;
  const headers = { accept: "application/vnd.github+json", "user-agent": "termenbox-ci-hook", authorization: `Bearer ${await appJwt(appId, pem, now)}` };
  const inst = await fetchFn(`https://api.github.com/repos/${repo}/installation`, { headers });
  if (!inst.ok) throw new Error(`installation lookup failed: ${inst.status}`);
  const { id: installation } = await inst.json();
  const res = await fetchFn(`https://api.github.com/app/installations/${installation}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions }),
  });
  if (!res.ok) throw new Error(`token request failed: ${res.status}`);
  const { token, expires_at } = await res.json();
  cache.set(id, { token, exp: Math.floor(Date.parse(expires_at) / 1000) });
  return token;
}
