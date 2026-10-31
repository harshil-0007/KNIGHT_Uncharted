// Lets DBug read a real project folder and its real `git diff`.
// Only works for requests coming from this same machine.
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const router = Router();

const READABLE = /\.(py|js|ts|tsx|jsx|mjs|cjs|json|env|ya?ml|toml|md|txt|html|css|go|rb|java|rs)$/i;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'venv', 'env', '__pycache__', 'coverage', 'target', 'vendor']);
const SKIP_FILES = /^(package-lock\.json|pnpm-lock\.yaml)$|\.min\.(js|css)$/i;
const MAX_FILE = 200_000;
const MAX_TOTAL = 1_200_000; // stays under the 2 MB JSON limit of POST /api/runs
const MAX_FILES = 500;

const bad = (status, error, message) => Object.assign(new Error(message), { status, error });
const readable = (name) => READABLE.test(name) || /^\.env(\..+)?$/.test(name);
const lf = (s) => s.replace(/\r\n/g, '\n');

router.use((req, res, next) => {
  const ip = req.socket.remoteAddress || '';
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
  res.status(403).json({ error: 'forbidden', message: 'Local project access is only available from this machine.' });
});

async function resolveDir(raw) {
  const text = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw bad(400, 'incomplete_input', 'Enter the full path of your project folder.');
  const dir = path.resolve(text);
  let st;
  try { st = await fs.stat(dir); } catch { throw bad(400, 'invalid_path', `Folder not found: ${dir}`); }
  if (!st.isDirectory()) throw bad(400, 'invalid_path', `That path is a file, not a folder: ${dir}`);
  return dir;
}

async function readProject(root) {
  const files = {};
  let total = 0, skipped = 0, truncated = false;
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (truncated) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) await visit(full);
        continue;
      }
      if (!e.isFile() || !readable(e.name) || SKIP_FILES.test(e.name)) continue;
      const st = await fs.stat(full);
      if (st.size > MAX_FILE) { skipped++; continue; }
      const text = lf(await fs.readFile(full, 'utf8'));
      if (text.includes('\u0000')) { skipped++; continue; }
      if (total + text.length > MAX_TOTAL || Object.keys(files).length >= MAX_FILES) { truncated = true; return; }
      files[path.relative(root, full).split(path.sep).join('/')] = text;
      total += text.length;
    }
  }
  await visit(root);
  return { files, skipped, truncated };
}

async function git(dir, args) {
  try {
    const { stdout } = await exec('git', ['-C', dir, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    if (err.code === 'ENOENT') throw bad(500, 'git_missing', 'Git is not installed or not on PATH.');
    throw err;
  }
}

router.get('/files', async (req, res, next) => {
  try {
    const dir = await resolveDir(req.query.dir);
    const { files, skipped, truncated } = await readProject(dir);
    if (!Object.keys(files).length) {
      throw bad(400, 'incomplete_input', 'No readable source files (.py, .js, .ts, .env ...) were found in that folder.');
    }
    let branch = null;
    try { branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); } catch { /* not a git repo */ }
    res.json({ dir, name: path.basename(dir), files, count: Object.keys(files).length, skipped, truncated, git: { branch } });
  } catch (err) { next(err); }
});

router.get('/diff', async (req, res, next) => {
  try {
    const dir = await resolveDir(req.query.dir);
    const range = req.query.mode === 'last' ? ['HEAD~1', 'HEAD'] : ['HEAD'];
    let out;
    try {
      out = await git(dir, ['diff', ...range, '--relative', '--no-color', '--no-ext-diff']);
    } catch (err) {
      if (err.status) throw err;
      if (/not a git repository/i.test(err.stderr || '')) throw bad(400, 'not_a_repo', 'That folder is not a git repository.');
      if (req.query.mode === 'last') throw bad(400, 'no_history', 'This repository needs at least two commits.');
      out = await git(dir, ['diff', '--relative', '--no-color', '--no-ext-diff']); // repo with no commits yet
    }
    const diff = lf(out);
    res.json({ diff, message: diff.trim() ? '' : 'No changes found. Edit a file (or stage it) and try again.' });
  } catch (err) { next(err); }
});

router.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ error: err.error || 'server_error', message: err.message });
});

export default router;
