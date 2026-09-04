/**
 * Injectable connection for the V2 durable orchestration store.
 *
 * The substrate needs a replica-set-capable, injectable client (transactions),
 * unlike the production-standalone singleton in `lib/mongo.ts`. Tests point this
 * at the ephemeral replica set (`scripts/ephemeral-mongo-rs.sh`); production will
 * point it at the real replica set. The store never assumes a global singleton.
 */
import { MongoClient, type Db } from 'mongodb';

export interface V2Store {
  client: MongoClient;
  db: Db;
  close: () => Promise<void>;
}

export async function connectV2Store(opts: { uri?: string; dbName?: string } = {}): Promise<V2Store> {
  const uri = opts.uri
    ?? process.env.MONGODB_URI_V2
    ?? 'mongodb://localhost:27018/?replicaSet=rs0';
  const dbName = opts.dbName ?? process.env.MONGODB_DB_V2 ?? 'orchestration_v2';
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    await client.connect();
  } catch (connectError) {
    try {
      await client.close();
    } catch (closeError) {
      throw new AggregateError(
        [connectError, closeError],
        'Mongo connection failed and its client could not be closed',
      );
    }
    throw connectError;
  }
  return { client, db: client.db(dbName), close: () => client.close() };
}
