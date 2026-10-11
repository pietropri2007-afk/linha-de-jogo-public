// Copy only this file, static-artifact.mjs and deploy.json into the dedicated publication repo.
import { readFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { unpackArtifact, limits } from './static-artifact.mjs';
const pointer = JSON.parse(readFileSync('deploy.json', 'utf8'));
if (
  pointer.schema !== 1 ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pointer.repository) ||
  !/^public-[a-f0-9]{24}$/.test(pointer.tag) ||
  pointer.asset !== 'site.json.gz' ||
  !/^[a-f0-9]{64}$/.test(pointer.sha256) ||
  pointer.bytes > limits.compressed
)
  throw new Error('Invalid release pointer');
if (existsSync('site') || existsSync('site-staging'))
  throw new Error('Build workspace must be clean');
const response = await fetch(
  `https://github.com/${pointer.repository}/releases/download/${pointer.tag}/${pointer.asset}`,
  { signal: AbortSignal.timeout(120000) },
);
if (!response.ok || Number(response.headers.get('content-length')) > limits.compressed)
  throw new Error('Public artifact unavailable');
let size = 0;
const chunks = [];
for await (const chunk of response.body) {
  size += chunk.length;
  if (size > limits.compressed) throw new Error('Download too large');
  chunks.push(chunk);
}
if (size !== pointer.bytes) throw new Error('Truncated download');
mkdirSync('site-staging');
unpackArtifact(Buffer.concat(chunks), pointer.sha256, 'site-staging');
renameSync('site-staging', 'site');
console.log(`Verified static artifact ${pointer.sha256}; ${size} compressed bytes.`);
