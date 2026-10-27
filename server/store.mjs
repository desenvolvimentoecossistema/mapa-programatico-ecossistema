import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
export class SqliteStore {
  constructor(filename) {
    if(filename!==':memory:'){filename=resolve(filename);mkdirSync(dirname(filename),{recursive:true,mode:0o700});}
    this.db=new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS objects (key TEXT PRIMARY KEY, body TEXT NOT NULL, etag TEXT NOT NULL)');
    const columns=this.db.prepare('PRAGMA table_info(objects)').all();
    if(!columns.some(c=>c.name==='expires_at'))this.db.exec('ALTER TABLE objects ADD COLUMN expires_at INTEGER');
    this.db.exec('CREATE INDEX IF NOT EXISTS objects_expiry ON objects(expires_at)');
    for(const row of this.db.prepare("SELECT key,body FROM objects WHERE key LIKE 'auth/%' AND expires_at IS NULL").all()){
      const expiry=this.expiry(row.key,row.body);if(expiry!==null)this.db.prepare('UPDATE objects SET expires_at=? WHERE key=?').run(expiry,row.key);
    }
    this.cleanupExpired();
    this.sweeper=setInterval(()=>{try{this.cleanupExpired();}catch{console.warn('map-store: authentication-cleanup-failed');}},300000);
    this.sweeper.unref();
  }
  expiry(key,body) {
    if(!key.startsWith('auth/'))return null;
    try{const value=JSON.parse(body),expiry=value.expires??value.expiresAt;return Number.isFinite(expiry)?expiry:null;}catch{return null;}
  }
  cleanupExpired(now=Date.now()) {
    return this.db.prepare('DELETE FROM objects WHERE key IN (SELECT key FROM objects WHERE expires_at IS NOT NULL AND expires_at<=? LIMIT 500)').run(now).changes;
  }
  async get(key) {
    const row=this.db.prepare('SELECT body,etag,expires_at FROM objects WHERE key=?').get(key);
    if(row?.expires_at!==null&&row?.expires_at!==undefined&&row.expires_at<=Date.now()){await this.delete(key);return null;}
    return row?{etag:row.etag,json:async()=>JSON.parse(row.body)}:null;
  }
  async put(key,body,options={}) {
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare('SELECT etag FROM objects WHERE key=?').get(key),condition=options.onlyIf;
      const absent=condition instanceof Headers&&condition.get('if-none-match')==='*';
      if((absent&&row)||(condition?.etagMatches!==undefined&&row?.etag!==condition.etagMatches)){this.db.exec('ROLLBACK');return null;}
      const etag=randomUUID(),text=String(body);
      this.db.prepare('INSERT INTO objects (key,body,etag,expires_at) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,etag=excluded.etag,expires_at=excluded.expires_at').run(key,text,etag,this.expiry(key,text));
      this.db.exec('COMMIT');return {etag};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  async delete(key){this.db.prepare('DELETE FROM objects WHERE key=?').run(key);}
  close(){clearInterval(this.sweeper);this.db.close();}
}
