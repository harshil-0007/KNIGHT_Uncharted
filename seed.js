// RippleGuard demo helper. Put this file in the project root (next to package.json).
//
//   node seed.js        -> wipe demo data, then insert 4 runs (server must be running)
//   node seed.js live   -> add ONE new run (use this during the demo to trigger change streams)
//   node seed.js reset  -> wipe demo data only
//
// Use projectId "demo-shop" in the UI.

import 'dotenv/config';
import { MongoClient } from 'mongodb';

const PROJECT = 'demo-shop';
const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3847}`;
const mode = process.argv[2] || 'seed';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Reusable findings (same fp = same issue across runs) ----
const F = {
  stripeKey: {
    fp: 'hardcoded-stripe-secret-key::src/payments.js',
    severity: 'critical', kind: 'key', name: 'Hardcoded Stripe secret key',
    path: 'src/payments.js', line: 12,
    shown: "const STRIPE_KEY = 'sk_live_****************';",
    fix: 'Move the key to an environment variable and rotate it.'
  },
  sqli: {
    fp: 'sql-injection-string-concat::src/orders.js',
    severity: 'high', kind: 'issue', name: 'SQL built with string concatenation',
    path: 'src/orders.js', line: 41,
    shown: "db.query('SELECT * FROM orders WHERE id = ' + req.params.id)",
    fix: 'Use parameterized queries.'
  },
  evalCall: {
    fp: 'eval-on-user-input::src/utils.js',
    severity: 'medium', kind: 'issue', name: 'eval() on user input',
    path: 'src/utils.js', line: 7,
    shown: 'eval(req.body.formula)',
    fix: 'Parse the input safely instead of evaluating it.'
  },
  cors: {
    fp: 'cors-wildcard-origin::src/server.js',
    severity: 'medium', kind: 'issue', name: 'CORS allows every origin',
    path: 'src/server.js', line: 18,
    shown: "app.use(cors({ origin: '*' }))",
    fix: 'Restrict origin to your real frontend domain.'
  },
  jwt: {
    fp: 'weak-jwt-secret::src/auth.js',
    severity: 'high', kind: 'issue', name: 'Weak JWT secret',
    path: 'src/auth.js', line: 5,
    shown: "jwt.sign(payload, 'secret123')",
    fix: 'Use a long random secret from the environment.'
  },
  redirect: {
    fp: 'open-redirect::src/routes.js',
    severity: 'medium', kind: 'issue', name: 'Unvalidated redirect target',
    path: 'src/routes.js', line: 63,
    shown: 'res.redirect(req.query.next)',
    fix: 'Allow only known relative paths.'
  }
};

// Story across runs (oldest -> newest). Latest vs previous shows:
//   fixed:    sqli
//   returned: stripeKey (it was in v1.0, fixed in v1.1, came back in v1.3)
//   new:      jwt
const RUNS = [
  { commit: 'v1.0', label: 'v1.0 initial release', verdict: 'block', findings: [F.stripeKey, F.sqli, F.evalCall] },
  { commit: 'v1.1', label: 'v1.1 key moved to env', verdict: 'block', findings: [F.sqli, F.evalCall] },
  { commit: 'v1.2', label: 'v1.2 refactor', verdict: 'warn', findings: [F.sqli, F.cors] },
  { commit: 'v1.3', label: 'v1.3 payments feature', verdict: 'block', findings: [F.cors, F.stripeKey, F.jwt] }
];

const LIVE_FINDINGS = [F.cors, F.jwt, F.redirect];

function filesFor(label) {
  return {
    'src/payments.js': `// ${label}\nexport function charge() {}\n`,
    'src/orders.js': `// ${label}\nexport function getOrder() {}\n`
  };
}

async function post(run) {
  const res = await fetch(`${BASE}/api/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: PROJECT, kind: 'scan', files: filesFor(run.label), ...run })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${run.label}: ${res.status} ${data.message || data.error || ''}`);
  console.log(`  ok  ${run.label} (${run.findings.length} findings)`);
}

async function reset() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(); // database name comes from the URI (/rippleguard)
  const r = await db.collection('runs').deleteMany({ projectId: PROJECT });
  const f = await db.collection('findings').deleteMany({ projectId: PROJECT });
  await client.close();
  console.log(`Cleared ${r.deletedCount} runs and ${f.deletedCount} findings for "${PROJECT}".`);
}

async function checkServer() {
  try {
    const res = await fetch(`${BASE}/api/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    throw new Error(`Server not reachable at ${BASE}. Run "npm start" in another terminal first.`);
  }
}

async function main() {
  if (mode === 'reset') return reset();

  await checkServer();

  if (mode === 'live') {
    const commit = `live-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
    await post({ commit, label: `live check ${commit.slice(5)}`, verdict: 'warn', findings: LIVE_FINDINGS });
    console.log('Live run sent. The dashboard should update right now.');
    return;
  }

  await reset();
  console.log('Seeding runs...');
  for (const run of RUNS) {
    await post(run);
    await sleep(150); // keeps createdAt in the right order
  }
  console.log(`Done. Open the app and use projectId "${PROJECT}".`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
