# DBug

Scan a Python or JavaScript project for exposed keys and risky code, then keep each scan as a run in MongoDB.

## Run it

1. Copy `.env.example` to `.env`.
2. Create a [MongoDB Atlas](https://www.mongodb.com/atlas) free cluster, allow your IP, and paste the connection string into `MONGODB_URI`. The database name can sit in the path (`...mongodb.net/rippleguard`).
3. Install and start:

```bash
npm install
npm start
```

Open [http://localhost:3847](http://localhost:3847). Atlas is a replica set, so the History page can listen with a change stream.

## Demo steps → UI

| Demo step | What you do |
| --- | --- |
| 1. Run the tool on a real or generated project | **Code**: Load demo (or paste / choose your files) and click **Scan**. Findings open, and a run is upserted in MongoDB. |
| 2. Show the history captured in MongoDB | **History**: lists runs for the project id, with timestamps and version (`commit`). |
| 3. Second scenario with a meaningful change | **Check a change**: **Small edit** (Clear), then **Leaks a key** (Blocked). Each sample is saved as a run. Stay on **History** — it updates live. |
| 4. Practical failure | Pick one below. |

### Failure cases

- **Duplicate event:** on **Check a change**, click **Small edit**, then **Submit again**. Same project + version hash → one `runs` document (HTTP 200, `duplicate: true`).
- **Incomplete input:** click **Diff with no file names**. The page explains that `+++ b/path` is missing instead of treating it as a clean pass.
- **Invalid configuration:** on **Code**, click **Try a .png**, or on **Check a change** click **Diff of a .png**. The tool names the file type it cannot read.

**Move Stripe key** then **Key returns** is the history comparison: newest vs previous is aggregated into “N new, N fixed, N came back”.

## MongoDB mapping

| Brief | Implementation |
| --- | --- |
| Stable ids, timestamps, project/version | `runs._id` = SHA-256(`projectId` + `commit`). `commit` is a short hash of the files or the diff. `createdAt` is set once (`$setOnInsert`). |
| Finding identity | `findings._id` = SHA-256(project, commit, file, line, hashed fingerprint). Raw secrets are hashed before storage; `details` keeps the masked snippet. |
| Indexes | `{ projectId, createdAt }` on runs (recent history). `{ fingerprint }` on findings (seen before). |
| Aggregation | `GET /api/compare` joins the last two runs to their findings, then marks fingerprints that vanished (fixed), appeared (new), or appeared and existed in an older run (came back). |
| Schema validation | Collections require `projectId`, `commit`, `createdAt` on runs, and `projectId`, `commit`, `severity`, `fingerprint` on findings, with a flexible `details` object. |
| Change streams | `GET /api/stream` watches `runs` and pushes SSE events. History falls back to polling if streams are unavailable. |
| Safe repeated ingestion | `updateOne(..., { upsert: true })` on the stable `_id`. Resubmitting the same scan or diff does not create a second run. |
