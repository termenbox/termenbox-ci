#!/usr/bin/env node
// node sweep/check-ci-image-age.mjs : the browser legs of ci.yaml pull the CI image by digest, and the weekly ci-image run
// says on the `CI failures` issue when a new build has a new digest. This check fails when that bump is overdue: the
// pinned digest is no longer the newest build (`:latest`) and the pinned build is more than SWEEP_CI_IMAGE_DAYS (default
// 60) days old. The weekly rebuild replaces a build within a week, so the age of the pinned build is the lateness of the
// bump plus at most seven days. It also fails when ci.yaml names the image by tag, names two digests or names none.
// It reads the public registry without a credential and prints nothing; the exit status is the verdict.
//   SWEEP_REGISTRY  registry base URL, default https://ghcr.io (the tests point it at a local server)
//   TERMENBOX_WORKFLOWS_DIR  the workflows directory, default .github/workflows
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IMAGE = 'termenbox/termenbox-ci';
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(',');

/** The one digest ci.yaml pulls the image by, or null when it names a tag, two digests or none. */
export function pinnedDigest(text) {
  if (new RegExp(`${IMAGE}:[A-Za-z0-9_.-]`).test(text)) return null;
  const pins = new Set([...text.matchAll(new RegExp(`${IMAGE}@(sha256:[0-9a-f]{64})`, 'g'))].map((m) => m[1]));
  return pins.size === 1 ? [...pins][0] : null;
}

/** True when the pin is the newest build, or was built at most `days` days before `now` (both in ms). */
export function inTime({ pin, latest, created, now, days }) {
  if (pin === latest) return true;
  const at = Date.parse(created ?? '');
  return Number.isFinite(at) && at <= now + 86400e3 && now - at <= days * 86400e3;
}

/** Reads the registry: the digest of `:latest` and the build time of the pinned digest. */
export async function readRegistry(base, pin) {
  let auth = {};
  try {
    const t = await fetch(`${base}/token?scope=repository:${IMAGE}:pull`);
    if (t.ok) auth = { Authorization: `Bearer ${(await t.json()).token}` };
  } catch { /* a registry without a token endpoint is read without one */ }
  const get = async (path, accept = ACCEPT) => {
    const r = await fetch(`${base}/v2/${IMAGE}/${path}`, { headers: { ...auth, Accept: accept } });
    if (!r.ok) throw new Error(`registry ${r.status}`);
    return r;
  };
  const latest = (await get('manifests/latest')).headers.get('docker-content-digest');
  if (latest === pin) return { latest };
  let manifest = await (await get(`manifests/${pin}`)).json();
  if (Array.isArray(manifest.manifests)) {
    const image = manifest.manifests.find((m) => m.platform && m.platform.os !== 'unknown');
    if (!image) throw new Error('no image in the index');
    manifest = await (await get(`manifests/${image.digest}`)).json();
  }
  const config = await (await get(`blobs/${manifest.config.digest}`, '*/*')).json();
  return { latest, created: config.created };
}

export async function main(env = process.env) {
  const dir = env.TERMENBOX_WORKFLOWS_DIR || fileURLToPath(new URL('../.github/workflows/', import.meta.url));
  const pin = pinnedDigest(readFileSync(join(dir, 'ci.yaml'), 'utf8'));
  if (!pin) return false;
  const { latest, created } = await readRegistry(env.SWEEP_REGISTRY || 'https://ghcr.io', pin);
  return inTime({ pin, latest, created, now: Date.now(), days: Number(env.SWEEP_CI_IMAGE_DAYS || 60) });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((ok) => process.exit(ok ? 0 : 1), () => process.exit(1));
}
