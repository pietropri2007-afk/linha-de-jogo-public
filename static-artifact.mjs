import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
export const digest = (v) => createHash('sha256').update(v).digest('hex');
export const limits = {
  bytes: 256 * 1024 * 1024,
  fileBytes: 24 * 1024 * 1024,
  files: 18000,
  compressed: 50 * 1024 * 1024,
};
export function safePath(p) {
  return (
    typeof p === 'string' &&
    /^[A-Za-z0-9_./-]+$/.test(p.replaceAll('$d$id', 'dynamic-id').replaceAll('[id]', 'id')) &&
    !p.startsWith('/') &&
    !p.split('/').some((s) => !s || s === '.' || s === '..' || s.startsWith('.')) &&
    (p === '_headers' || /\.(html|txt|json|js|css|svg|png|ico|xml|woff2?|webmanifest)$/.test(p)) &&
    !/(^|\/)(?:api|backups|logs|node_modules|src)(\/|$)/.test(p) &&
    !/\.map$/.test(p)
  );
}
export function packArtifact(out) {
  const walk = (dir) =>
    readdirSync(dir)
      .sort()
      .flatMap((name) => {
        const f = resolve(dir, name),
          st = lstatSync(f);
        if (st.isSymbolicLink()) throw new Error('Symlink forbidden');
        return st.isDirectory() ? walk(f) : [f];
      });
  const entries = walk(out).map((file) => {
    const bytes = readFileSync(file);
    return {
      path: relative(out, file).replaceAll('\\', '/'),
      sha256: digest(bytes),
      bytes: bytes.length,
      encoding: /\.(png|ico|woff2?)$/.test(file) ? 'base64' : 'utf8',
      data: /\.(png|ico|woff2?)$/.test(file) ? bytes.toString('base64') : bytes.toString('utf8'),
    };
  });
  const inventory = entries.find((e) => e.path === 'artifact-manifest.json');
  if (inventory) {
    const expected = JSON.parse(inventory.data).entries;
    if (
      !Array.isArray(expected) ||
      expected.length !== entries.length - 1 ||
      expected.some(
        (e) =>
          !entries.some(
            (actual) =>
              actual.path === e.path && actual.sha256 === e.sha256 && actual.bytes === e.bytes,
          ),
      )
    )
      throw new Error('Site changed after validation; rebuild before publishing');
  }
  validateEntries(entries);
  const blobs = Object.fromEntries(
    entries.map((e) => [e.sha256, { data: e.data, encoding: e.encoding }]),
  );
  const archive = gzipSync(
    JSON.stringify({
      schema: 2,
      entries: entries.map(({ path, sha256, bytes }) => ({ path, sha256, bytes })),
      blobs,
    }),
    { level: 9 },
  );
  if (archive.length > limits.compressed) throw new Error('Compressed artifact too large');
  return {
    archive,
    sha256: digest(archive),
    bytes: archive.length,
    files: entries.length,
    decodedBytes: entries.reduce((n, e) => n + e.bytes, 0),
  };
}
export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > limits.files)
    throw new Error('Invalid file count');
  let total = 0;
  const names = new Set();
  for (const e of entries) {
    if (
      !safePath(e.path) ||
      names.has(e.path) ||
      !Number.isInteger(e.bytes) ||
      e.bytes < 0 ||
      e.bytes > limits.fileBytes ||
      typeof e.data !== 'string'
    )
      throw new Error('Invalid public file');
    names.add(e.path);
    if (!['utf8', 'base64'].includes(e.encoding ?? 'base64')) throw new Error('Invalid encoding');
    const data = Buffer.from(e.data, e.encoding ?? 'base64');
    if (data.length !== e.bytes || digest(data) !== e.sha256)
      throw new Error('Artifact hash mismatch');
    total += e.bytes;
    if (total > limits.bytes) throw new Error('Artifact too large');
  }
  if (
    !names.has('index.html') ||
    !names.has('404.html') ||
    !names.has('_headers') ||
    !names.has('data/manifest.json')
  )
    throw new Error('Incomplete artifact');
  return entries;
}
export function unpackArtifact(bytes, sha256, target) {
  if (bytes.length > limits.compressed || digest(bytes) !== sha256)
    throw new Error('Invalid archive');
  const parsed = JSON.parse(gunzipSync(bytes, { maxOutputLength: limits.bytes * 2 }).toString());
  if (parsed.schema !== 2 || !Array.isArray(parsed.entries) || !parsed.blobs)
    throw new Error('Unsupported artifact schema');
  const entries = validateEntries(parsed.entries.map((e) => ({ ...e, ...parsed.blobs[e.sha256] })));
  for (const e of entries) {
    const path = resolve(target, e.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(e.data, e.encoding), { flag: 'wx' });
  }
  return entries.length;
}
export function publicationDecision(state, revision, now = Date.now()) {
  if (state.pendingCommit) return { allowed: false, reason: 'awaiting-cloudflare-check' };
  if (state.lastRevision === revision) return { allowed: false, reason: 'unchanged' };
  const attempts = (state.attempts ?? []).filter((at) => now - at < 86400000);
  if (attempts.some((at) => at > now) || (state.retryAt ?? 0) > now)
    return { allowed: false, reason: 'backoff-or-clock' };
  if (attempts.length >= 4) return { allowed: false, reason: 'four-per-rolling-day' };
  if (attempts.length && now - Math.max(...attempts) < 6 * 3600000)
    return { allowed: false, reason: 'six-hour-spacing' };
  return { allowed: true, reason: 'changed' };
}
export function cloudflareCheckState(checks) {
  const relevant = checks.filter((c) =>
    /cloudflare/i.test([c.app?.slug, c.name, c.context].join(' ')),
  );
  if (
    !relevant.length ||
    relevant.some(
      (c) => c.status === 'queued' || c.status === 'in_progress' || c.state === 'pending',
    )
  )
    return 'pending';
  return relevant.every((c) => c.conclusion === 'success' || c.state === 'success')
    ? 'success'
    : 'failure';
}
