import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectMongo, getDb, mongoState, watchRuns } from './db.js';
import { contentCommit, findingId, hashFingerprint, runId } from './ids.js';
import localRoutes from './local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3847;
const READABLE = /\.(py|js|ts|tsx|jsx|mjs|cjs|json|env|ya?ml|toml|md|txt|html|css|go|rb|java|rs)$/i;
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
// Reads folders from the machine's own disk, so it is local-only: never mount it on a hosted server.
if (process.env.NODE_ENV !== 'production') app.use('/api/local', localRoutes);

function fail(res, status, error, message) {
  return res.status(status).json({ error, message });
}

function requireMongo(req, res, next) {
  try {
    req.db = getDb();
    next();
  } catch (err) {
    fail(res, err.status || 503, 'mongo_unavailable', err.message);
  }
}

app.get('/api/health', (_req, res) => {
  res.json(mongoState());
});

app.get('/api/runs', requireMongo, async (req, res) => {
  const projectId = String(req.query.projectId || '').trim();
  const filter = projectId ? { projectId } : {};
  const runs = await req.db.collection('runs')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();
  res.json({ runs });
});

app.get('/api/runs/:id', requireMongo, async (req, res) => {
  const run = await req.db.collection('runs').findOne({ _id: req.params.id });
  if (!run) return fail(res, 404, 'not_found', 'No run with that id.');
  const findings = await req.db.collection('findings')
    .find({ projectId: run.projectId, commit: run.commit })
    .toArray();
  res.json({ run, findings });
});

app.get('/api/compare', requireMongo, async (req, res) => {
  const projectId = String(req.query.projectId || '').trim();
  if (!projectId) return fail(res, 400, 'incomplete_input', 'projectId is required to compare runs.');

  const recent = await req.db.collection('runs').aggregate([
    { $match: { projectId } },
    { $sort: { createdAt: -1 } },
    { $limit: 2 },
    {
      $lookup: {
        from: 'findings',
        let: { projectId: '$projectId', commit: '$commit' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$projectId', '$$projectId'] },
                  { $eq: ['$commit', '$$commit'] }
                ]
              }
            }
          },
          { $project: { fingerprint: 1, severity: 1, details: 1 } }
        ],
        as: 'findings'
      }
    }
  ]).toArray();

  if (recent.length < 2) {
    return res.json({
      enough: false,
      message: recent.length
        ? 'Need a second run before a comparison is meaningful.'
        : 'No runs stored yet.',
      latest: recent[0] || null,
      previous: null,
      newCount: 0,
      fixedCount: 0,
      returnedCount: 0,
      newFindings: [],
      fixedFindings: [],
      returnedFindings: []
    });
  }

  const [latest, previous] = recent;
  const prevSet = new Set(previous.findings.map((f) => f.fingerprint));
  const latestSet = new Set(latest.findings.map((f) => f.fingerprint));
  const newcomers = latest.findings.filter((f) => !prevSet.has(f.fingerprint));
  const fixed = previous.findings.filter((f) => !latestSet.has(f.fingerprint));
  const newFingerprints = newcomers.map((f) => f.fingerprint);

  const seenBefore = newFingerprints.length
    ? await req.db.collection('findings').distinct('fingerprint', {
      projectId,
      fingerprint: { $in: newFingerprints },
      commit: { $nin: [latest.commit, previous.commit] }
    })
    : [];
  const returnedSet = new Set(seenBefore);
  const returned = newcomers.filter((f) => returnedSet.has(f.fingerprint));
  const brandNew = newcomers.filter((f) => !returnedSet.has(f.fingerprint));

  res.json({
    enough: true,
    latest: { _id: latest._id, commit: latest.commit, label: latest.label, createdAt: latest.createdAt },
    previous: { _id: previous._id, commit: previous.commit, label: previous.label, createdAt: previous.createdAt },
    newCount: brandNew.length,
    fixedCount: fixed.length,
    returnedCount: returned.length,
    newFindings: brandNew,
    fixedFindings: fixed,
    returnedFindings: returned
  });
});

app.get('/api/stream', requireMongo, async (req, res) => {
  if (!mongoState().changeStreams) {
    return fail(res, 501, 'no_change_streams', 'Change streams need a replica set. Atlas provides one; until then History polls.');
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const projectId = String(req.query.projectId || '').trim();
  let stream;
  try {
    stream = await watchRuns(projectId, (change) => {
      const doc = change.fullDocument;
      if (projectId && doc && doc.projectId !== projectId) return;
      res.write(`data: ${JSON.stringify({
        operationType: change.operationType,
        runId: doc?._id || change.documentKey?._id,
        projectId: doc?.projectId,
        commit: doc?.commit,
        label: doc?.label
      })}\n\n`);
    });
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
    return res.end();
  }

  const ping = setInterval(() => res.write(':\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    stream.close().catch(() => {});
  });
});

app.post('/api/validate-diff', (req, res) => {
  const diff = String(req.body?.diff || '');
  const result = inspectDiff(diff);
  if (result.error) return fail(res, 400, result.error, result.message);
  res.json({ ok: true, files: result.files });
});

app.post('/api/validate-files', (req, res) => {
  const files = req.body?.files;
  const result = inspectFiles(files);
  if (result.error) return fail(res, 400, result.error, result.message);
  res.json({ ok: true, count: result.paths.length });
});

app.post('/api/runs', requireMongo, async (req, res) => {
  const body = req.body || {};
  const projectId = String(body.projectId || '').trim();
  const kind = body.kind === 'diff' ? 'diff' : 'scan';
  const label = String(body.label || kind).slice(0, 80);
  const verdict = ['pass', 'warn', 'block'].includes(body.verdict) ? body.verdict : null;
  const findingsIn = Array.isArray(body.findings) ? body.findings : [];

  if (!projectId) return fail(res, 400, 'incomplete_input', 'Each run needs a projectId.');

  if (kind === 'diff') {
    const diffCheck = inspectDiff(String(body.diff || ''));
    if (diffCheck.error) return fail(res, 400, diffCheck.error, diffCheck.message);
  } else {
    const fileCheck = inspectFiles(body.files);
    if (fileCheck.error) return fail(res, 400, fileCheck.error, fileCheck.message);
  }

  const source = kind === 'diff' ? String(body.diff || '') : serializeFiles(body.files);
  if (!source.trim()) {
    return fail(res, 400, 'incomplete_input', kind === 'diff'
      ? 'Paste a git diff before saving a run.'
      : 'Load or paste project files before scanning.');
  }

  const commit = String(body.commit || contentCommit(kind, source));
  const id = runId(projectId, commit);

  const prepared = [];
  for (const raw of findingsIn) {
    const severity = String(raw.severity || raw.sev || '').toLowerCase();
    const fingerprint = hashFingerprint(String(raw.fp || raw.fingerprint || [raw.name, raw.path, raw.line].join(':')));
    const pathName = String(raw.path || raw.details?.path || '');
    const line = Number(raw.line || raw.details?.line || 0);
    if (!SEVERITIES.has(severity) || fingerprint.length < 8) {
      return fail(res, 400, 'invalid_finding', 'Every finding needs projectId, commit, severity, and fingerprint.');
    }
    prepared.push({
      _id: findingId(projectId, commit, pathName, line, fingerprint),
      projectId,
      commit,
      severity,
      fingerprint,
      details: {
        kind: raw.kind || 'issue',
        name: raw.name || 'Finding',
        path: pathName,
        line,
        shown: raw.shown || '',
        fn: raw.fn || null,
        fix: raw.fix || ''
      }
    });
  }

  const now = new Date();
  const summary = {
    keys: prepared.filter((f) => f.details.kind === 'key').length,
    issues: prepared.filter((f) => f.details.kind !== 'key').length,
    highOrCritical: prepared.filter((f) => f.severity === 'critical' || f.severity === 'high').length
  };

  const runs = req.db.collection('runs');
  const existing = await runs.findOne({ _id: id });
  await runs.updateOne(
    { _id: id },
    {
      $set: {
        projectId,
        commit,
        kind,
        label,
        verdict,
        summary,
        updatedAt: now
      },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );

  if (prepared.length) {
    const ops = prepared.map((doc) => ({
      updateOne: {
        filter: { _id: doc._id },
        update: { $set: doc, $setOnInsert: { createdAt: now } },
        upsert: true
      }
    }));
    await req.db.collection('findings').bulkWrite(ops, { ordered: false });
  }

  const run = await runs.findOne({ _id: id });
  res.status(existing ? 200 : 201).json({
    duplicate: Boolean(existing),
    runId: id,
    commit,
    createdAt: run.createdAt,
    message: existing
      ? 'Same project and version — MongoDB kept one run (upsert).'
      : 'Run stored.'
  });
});

function serializeFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files)) return '';
  return Object.entries(files).map(([p, t]) => `### ${p}\n${t}`).join('\n');
}

function inspectFiles(files) {
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) {
    return { error: 'incomplete_input', message: 'No files to scan. Paste code with ### path/file.py lines, or choose files.' };
  }
  const paths = Object.keys(files);
  const bad = paths.find((p) => !READABLE.test(p) && !/^\.env(?:\..+)?$/.test(p.split(/[/\\]/).pop()));
  if (bad) {
    const ext = path.extname(bad) || 'this type';
    return {
      error: 'invalid_configuration',
      message: `DBug cannot read ${ext} files (${bad}). Use source files such as .py, .js, .ts, or .env.`
    };
  }
  return { paths };
}

function inspectDiff(diff) {
  if (!String(diff).trim()) {
    return { error: 'incomplete_input', message: 'Paste a git diff before checking a change.' };
  }
  const files = [];
  for (const line of diff.split('\n')) {
    const m = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (m && m[1] !== '/dev/null') files.push(m[1].trim());
  }
  if (!files.length) {
    return {
      error: 'incomplete_input',
      message: 'This diff has no file names. Use git diff output that includes lines like +++ b/path/to/file.py.'
    };
  }
  const bad = files.find((p) => !READABLE.test(p) && !/^\.env(?:\..+)?$/.test(p.split(/[/\\]/).pop()));
  if (bad) {
    const ext = path.extname(bad) || 'this type';
    return {
      error: 'invalid_configuration',
      message: `DBug cannot read ${ext} files (${bad}). Point the change at source files it can parse.`
    };
  }
  return { files };
}

app.use((err, _req, res, _next) => {
  console.error(err);
  fail(res, 500, 'server_error', err.message || 'Unexpected error');
});

try {
  await connectMongo();
} catch (err) {
  console.warn('MongoDB connection failed:', err.message);
}

app.listen(PORT, () => {
  console.log(`DBug at http://localhost:${PORT}`);
});
