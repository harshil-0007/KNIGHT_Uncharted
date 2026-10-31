import { createHash } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function runId(projectId, commit) {
  return sha256(`${projectId}\0${commit}`);
}

export function findingId(projectId, commit, path, line, fingerprint) {
  return sha256(`${projectId}\0${commit}\0${path}\0${line}\0${fingerprint}`);
}

export function contentCommit(kind, body) {
  return `${kind}-${sha256(body).slice(0, 12)}`;
}

export function hashFingerprint(raw) {
  return sha256(`fp\0${raw}`);
}
