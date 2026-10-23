import test from 'node:test';

import assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { createHash } from 'node:crypto';

import { SqliteStore } from '../server/store.mjs';

import app from '../dist/app.mjs';

test('armazenamento persiste e recusa atualizações concorrentes',async()=>{

  const dir=await mkdtemp(join(tmpdir(),'map-runtime-'));const path=join(dir,'test.sqlite');let store=new SqliteStore(path);

  try {

    const first=await store.put('data','{"value":1}',{onlyIf:new Headers({'if-none-match':'*'})});

    assert.equal(await store.put('data','{}',{onlyIf:new Headers({'if-none-match':'*'})}),null);

    const writes=await Promise.all([store.put('data','{"value":2}',{onlyIf:{etagMatches:first.etag}}),store.put('data','{"value":3}',{onlyIf:{etagMatches:first.etag}})]);

    assert.equal(writes.filter(Boolean).length,1);store.close();store=new SqliteStore(path);assert.equal((await(await store.get('data')).json()).value,2);

  }finally{store.close();await rm(dir,{recursive:true,force:true});}

});

test('acesso exige sessão própria e respeita o administrador',async()=>{

  const store=new SqliteStore(':memory:');const origin='https://map.example.test';

  const env={STORE:store,MAP_ORIGIN:origin,MAP_ADMIN_EMAILS:'admin@example.test',AUTH_ALLOWED_DOMAINS:'example.test',GOOGLE_SHEETS_ID:'abcdefghijklmnopqrstuv123456'};

  try{

    assert.equal((await app.fetch(new Request(origin+'/api/session',{headers:{'x-user-id':'forged','x-user-email':'admin@example.test'}}),env)).status,401);

    for(const [email,canEdit] of [['admin@example.test',true],['viewer@example.test',false]]){

      const token=(canEdit?'A':'B').repeat(43);const hash=createHash('sha256').update(token).digest('hex');

      await store.put('auth/sessions/'+hash,JSON.stringify({user:{userId:'google:'+email,email,displayName:'Teste'},expires:Date.now()+60000}));

      const headers={cookie:'__Host-mapa_session='+token};

      const session=await(await app.fetch(new Request(origin+'/api/session',{headers}),env)).json();assert.equal(session.canEdit,canEdit);assert.equal(!!session.sourceUrl,canEdit);

      assert.equal((await app.fetch(new Request(origin+'/api/data',{headers}),env)).status,200);

      const result=await app.fetch(new Request(origin+'/api/data',{method:'PUT',headers:{...headers,origin:'https://wrong.example','content-type':'application/json'},body:'{}'}),env);assert.equal(result.status,403);

    }

  }finally{store.close();}

});

