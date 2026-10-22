import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const fixture=JSON.parse(execFileSync(process.env.PYTHON||'python3',['tests/read-fixture.py'],{encoding:'utf8'}));
const context=vm.createContext({TextDecoder,Uint8Array,Uint32Array,DataView,Blob,DecompressionStream});
vm.runInContext(fs.readFileSync('site/xlsx-reader.js','utf8'),context);
const reader=context.NativeXLSX;
const bytes=fs.readFileSync('tests/fixtures/dados.xlsx');
const workbook=await reader.read(bytes);
assert.deepEqual([...workbook.SheetNames],Object.keys(fixture.sheets));
let checked=0;
for(const [name,cells] of Object.entries(fixture.sheets))for(const [address,expected] of Object.entries(cells)){
  if(address==='!ref')continue;
  assert.equal(String(workbook.Sheets[name][address]?.v??''),String(expected.v??''),name+'!'+address);checked++;
}
assert.equal(reader.utils.sheet_to_json(workbook.Sheets.Programas,{blankrows:false}).length,38);
await assert.rejects(()=>reader.read(new Uint8Array([1,2,3])),/inválido/);
const damaged=Uint8Array.from(bytes);
const worksheetNameOffset=bytes.lastIndexOf(Buffer.from('xl/worksheets/sheet2.xml'));
assert(worksheetNameOffset>46);
damaged[worksheetNameOffset-30]^=1; // Corrupt the central directory's worksheet CRC.
await assert.rejects(()=>reader.read(damaged));
console.log('PASS — actual local XLSX parsing: '+checked+' cells; malformed and corrupted files rejected.');

const workerSource=fs.readFileSync('worker/index.js','utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64'))).default;
let stored=null,etag=null,writes=0;
const bucket={
  async get(){return stored===null?null:{etag,json:async()=>JSON.parse(stored)};},
  async put(key,body,options){
    const condition=options.onlyIf;
    if(condition instanceof Headers){assert.equal(condition.get('If-None-Match'),'*');if(stored!==null)return null;}
    else if(etag!==condition.etagMatches)return null;
    stored=body;etag=createHash('md5').update(body).digest('hex');writes++;
    return {etag};
  }
};
const origin='https://mapa.example.test';
const env={SITE_AUTH_MODE:'sites',BUCKET:bucket,MAP_ADMIN_EMAILS:'owner@example.test',MAP_ORIGIN:origin};
const owner={'oai-authenticated-user-id':'owner-id','oai-authenticated-user-email':'owner@example.test'};
const fetch=(path,options={})=>worker.fetch(new Request(origin+path,{...options,headers:options.headers??owner}),env,{});
let response=await fetch('/api/data'),initial=await response.json();
assert.equal(response.status,200);assert.equal(initial.revision,null);
assert.equal(Object.values(initial.snapshot.dims).reduce((n,org)=>n+Object.keys(org).length,0),38);
response=await fetch('/api/session',{headers:owner});assert.equal((await response.json()).canEdit,true);
response=await fetch('/api/session',{headers:{...owner,'oai-authenticated-user-email':'viewer@example.test'}});
assert.equal((await response.json()).canEdit,false);
const payload={snapshot:structuredClone(initial.snapshot),revision:null};
payload.snapshot.dims.abc['EpV — Educar pra Valer'].desc+=' Atualização de teste.';
const options=(body,headers=owner)=>({method:'PUT',headers:{...headers,'content-type':'application/json',origin},body:JSON.stringify(body)});
response=await fetch('/api/data',options(payload,{}));assert.equal(response.status,401);
response=await fetch('/api/data',options(payload,{...owner,'oai-authenticated-user-email':'viewer@example.test'}));assert.equal(response.status,403);
response=await fetch('/api/data',options(payload));assert.equal(response.status,200);
const foreign=options(payload);foreign.headers.origin='https://foreign.example';
response=await fetch('/api/data',foreign);assert.equal(response.status,403);
assert.equal(writes,1);
response=await fetch('/api/data',options(payload));assert.equal(response.status,409);
response=await fetch('/api/data');const shared=await response.json();
assert.equal(shared.snapshot.dims.abc['EpV — Educar pra Valer'].desc,payload.snapshot.dims.abc['EpV — Educar pra Valer'].desc);
assert(shared.revision);assert(shared.updatedAt);
const incomplete={snapshot:{dims:{}},revision:shared.revision};
response=await fetch('/api/data',options(incomplete));assert.equal(response.status,400);assert.equal(writes,1);
response=await fetch('/api/data',options({...payload,revision:shared.revision}));assert.equal(response.status,200);assert.equal(writes,2);
response=await fetch('/');assert.equal(response.status,200);
const page=await response.text();assert(!page.includes('data-publish-btn'));assert(!page.includes('data-refresh-btn'));assert(page.includes('NativeXLSX'));
const unavailable={...env,BUCKET:{get:async()=>{throw Error('offline')},put:async()=>{throw Error('offline')}}};
response=await worker.fetch(new Request(origin+'/api/data',{headers:owner}),unavailable,{});assert.equal(response.status,503);
response=await worker.fetch(new Request(origin+'/api/data',options(payload)),unavailable,{});assert.equal(response.status,503);
assert.equal(writes,2);
console.log('PASS — shared state, authorization, origin checks, concurrent updates and storage failures.');
