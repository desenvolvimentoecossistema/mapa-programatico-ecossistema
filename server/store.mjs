import { DatabaseSync } from 'node:sqlite';

import { mkdirSync } from 'node:fs';

import { dirname, resolve } from 'node:path';

import { randomUUID } from 'node:crypto';

export class SqliteStore {

  constructor(filename) {

    if (filename !== ':memory:') { filename = resolve(filename); mkdirSync(dirname(filename), { recursive: true, mode: 0o700 }); }

    this.db = new DatabaseSync(filename);

    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, body TEXT NOT NULL, etag TEXT NOT NULL)');

  }

  async get(key) { const row=this.db.prepare('SELECT body,etag FROM objects WHERE key=?').get(key); return row ? {etag:row.etag,json:async()=>JSON.parse(row.body)} : null; }

  async put(key, body, options={}) {

    this.db.exec('BEGIN IMMEDIATE');

    try {

      const row=this.db.prepare('SELECT etag FROM objects WHERE key=?').get(key);

      const condition=options.onlyIf;

      const absent=condition instanceof Headers && condition.get('if-none-match')==='*';

      if ((absent&&row)||(condition?.etagMatches!==undefined&&row?.etag!==condition.etagMatches)) { this.db.exec('ROLLBACK'); return null; }

      const etag=randomUUID();

      this.db.prepare('INSERT INTO objects VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,etag=excluded.etag').run(key,String(body),etag);

      this.db.exec('COMMIT'); return {etag};

    } catch(error) { this.db.exec('ROLLBACK'); throw error; }

  }

  async delete(key) { this.db.prepare('DELETE FROM objects WHERE key=?').run(key); }

  close() { this.db.close(); }

}

