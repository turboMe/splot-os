import { MongoClient } from 'mongodb';
import fs from 'fs/promises';
import path from 'path';

export class DeltaIndexer {
  private client: MongoClient;
  private dbName = 'gastro_bridge';
  private collectionName = 'drafts_registry';

  constructor(mongoUri: string) {
    this.client = new MongoClient(mongoUri);
  }

  async sync(dirPath: string) {
    await this.client.connect();
    const db = this.client.db(this.dbName);
    const collection = db.collection(this.collectionName);

    const files = await this.recursiveRead(dirPath);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(file, 'utf-8');
        const metadata = JSON.parse(content);
        await collection.updateOne(
          { filePath: file },
          { $set: { ...metadata, filePath: file, updatedAt: new Date() } },
          { upsert: true }
        );
      }
    }
    await this.client.close();
  }

  private async recursiveRead(dir: string): Promise<string[]> {
    let results: string[] = [];
    const list = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of list) {
      const res = path.resolve(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(await this.recursiveRead(res));
      } else {
        results.push(res);
      }
    }
    return results;
  }
}
