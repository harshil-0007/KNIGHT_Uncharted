import { MongoClient } from 'mongodb';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const findingsValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['projectId', 'commit', 'severity', 'fingerprint'],
    additionalProperties: true,
    properties: {
      projectId: { bsonType: 'string', minLength: 1 },
      commit: { bsonType: 'string', minLength: 1 },
      severity: { enum: SEVERITIES },
      fingerprint: { bsonType: 'string', minLength: 8 },
      details: { bsonType: 'object' }
    }
  }
};

const runsValidator = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['projectId', 'commit', 'createdAt'],
    additionalProperties: true,
    properties: {
      projectId: { bsonType: 'string', minLength: 1 },
      commit: { bsonType: 'string', minLength: 1 },
      createdAt: { bsonType: 'date' }
    }
  }
};

let client;
let db;
let changeStreamsOk = false;

export function mongoState() {
  return {
    configured: Boolean(process.env.MONGODB_URI),
    connected: Boolean(db),
    changeStreams: changeStreamsOk
  };
}

export function getDb() {
  if (!db) {
    const err = new Error('MongoDB is not connected. Set MONGODB_URI in .env (Atlas free tier works).');
    err.status = 503;
    throw err;
  }
  return db;
}

async function ensureCollection(database, name, validator) {
  const existing = await database.listCollections({ name }).toArray();
  if (!existing.length) {
    await database.createCollection(name, {
      validator,
      validationLevel: 'moderate',
      validationAction: 'error'
    });
    return;
  }
  try {
    await database.command({
      collMod: name,
      validator,
      validationLevel: 'moderate',
      validationAction: 'error'
    });
  } catch (err) {
    console.warn(`Could not update validation on ${name}:`, err.message);
  }
}

export async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri || uri.includes('USER:PASSWORD')) {
    console.warn('MONGODB_URI is missing. The UI will load; History will stay empty until you add an Atlas connection string.');
    return null;
  }

  client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, family: 4 });
  await client.connect();
  db = client.db();

  await ensureCollection(db, 'runs', runsValidator);
  await ensureCollection(db, 'findings', findingsValidator);

  await db.collection('runs').createIndex({ projectId: 1, createdAt: -1 });
  await db.collection('findings').createIndex({ fingerprint: 1 });
  await db.collection('findings').createIndex({ projectId: 1, commit: 1 });

  try {
    const probe = db.collection('runs').watch([], { maxAwaitTimeMS: 1000 });
    await probe.close();
    changeStreamsOk = true;
  } catch (err) {
    changeStreamsOk = false;
    console.warn('Change streams unavailable (needs a replica set, which Atlas provides):', err.message);
  }

  console.log('MongoDB connected. Change streams:', changeStreamsOk ? 'yes' : 'no');
  return db;
}

export async function watchRuns(projectId, onChange) {
  const database = getDb();
  if (!changeStreamsOk) {
    const err = new Error('Change streams are not available on this MongoDB deployment.');
    err.status = 501;
    throw err;
  }
  const pipeline = projectId
    ? [{ $match: { 'fullDocument.projectId': projectId } }]
    : [];
  const stream = database.collection('runs').watch(pipeline, {
    fullDocument: 'updateLookup'
  });
  stream.on('change', onChange);
  return stream;
}

export function closeMongo() {
  return client?.close();
}
