import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {SqliteStore} from '../server/store.mjs';
import app from '../dist/app.mjs';
const dir=await mkdtemp(join(tmpdir(),'map-quality-')),filename=join(dir,'old.sqlite');
let store;
try {
 const old=new DatabaseSync(filename);old.exec('CREATE TABLE objects (key TEXT PRIMARY KEY,body TEXT NOT NULL,etag TEXT NOT NULL)');
 old.prepare('INSERT INTO objects VALUES (?,?,?)').run('auth/states/expired',JSON.stringify({expires:Date.now()-1000}),'old');
 old.prepare('INSERT INTO objects VALUES (?,?,?)').run('mapa-ecossistema/current.json','{"preserved":true}','data');old.close();
 store=new SqliteStore(filename);assert.equal(await store.get('auth/states/expired'),null);assert.equal((await(await store.get('mapa-ecossistema/current.json')).json()).preserved,true);
 await store.put('auth/sso/old',JSON.stringify({expiresAt:Date.now()-1000}));assert.equal(store.cleanupExpired(),1);
 const token='A'.repeat(43),hash=createHash('sha256').update(token).digest('hex');await store.put('auth/sessions/'+hash,JSON.stringify({user:{email:'user@example.test',userId:'google:test',displayName:'Teste'},expires:Date.now()+60000}));
 const origin='https://map.example.test',env={STORE:store,MAP_ORIGIN:origin,AUTH_ALLOWED_DOMAINS:'example.test'},headers={cookie:'__Host-mapa_session='+token};
 const response=await app.fetch(new Request(origin,{headers}),env),page=await response.text();assert.equal(response.status,200);assert(response.headers.get('content-security-policy').includes("frame-ancestors 'self'"));assert.equal(response.headers.get('x-frame-options'),'SAMEORIGIN');assert(page.includes('<script nonce="'));assert(!page.includes('data:font/ttf;base64,'));assert(Buffer.byteLength(page)<500000);
 const asset=page.match(/\/assets\/[a-f0-9]+\.ttf/)[0];assert.equal((await app.fetch(new Request(origin+asset),env)).status,401);
 const image=await app.fetch(new Request(origin+asset,{headers}),env);assert.equal(image.status,200);assert(image.headers.get('cache-control').startsWith('private,'));assert((await image.arrayBuffer()).byteLength>0);
 assert.equal((await app.fetch(new Request(origin+asset,{headers:{...headers,'if-none-match':image.headers.get('etag')}}),env)).status,304);
 assert.match(await readFile(new URL('../README.md',import.meta.url),'utf8'),/43 a 128/);
 console.log('PASS — migração preserva dados, limpeza por validade, página protegida, CSP, recursos autenticados e cache privado.');
} finally {store?.close();await rm(dir,{recursive:true,force:true});}
