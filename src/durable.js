import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node';
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { mkdir, realpath } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { FileStore } from './store.js';
import { fingerprint } from './shared.js';

export * from '@earendil-works/pi-durable';
export { openNodeSqliteStorage, openNodeJsonlStorage, BACKGROUND_CONTEXT };

export async function openRedMapleHarness({ file, directory, models, registry = createRegistry(),
  readOnly = false, recoverLock = false, extensions = [], ...options }) {
  for (const extension of extensions) registry.install(extension);
  const target = resolve(directory || file);
  await mkdir(dirname(target), { recursive: true });
  const canonical = await realpath(target).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return realpath(dirname(target)).then(parent => resolve(parent, basename(target)));
  });
  const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
  const owner = await FileStore.open(dirname(canonical), `durable-${fingerprint(key)}`, { recoverLock });
  let storage;
  let database;
  try {
    if (directory) storage = await openNodeJsonlStorage(canonical, BACKGROUND_CONTEXT, { fsync: true, readOnly });
    else {
      database = await openNodeSqliteDatabase(canonical);
      await database.exec('PRAGMA synchronous=FULL');
      storage = await SqliteStorage.open(database);
    }
    const close = storage.close.bind(storage);
    let closing;
    storage.close = () => closing ||= (async () => { await close(); await owner.close(); })();
    return await Harness.open(storage, { ...options, models, registry, readOnly }, BACKGROUND_CONTEXT);
  } catch (error) {
    if (storage) await storage.close();
    else { await database?.close(); await owner.close(); }
    throw error;
  }
}
