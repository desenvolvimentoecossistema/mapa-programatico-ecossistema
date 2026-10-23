import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const source=await fs.readFile('server/google-sheets.js','utf8');
const {readGoogleSheets,sheetsWorkbook,sheetsCellHtml}=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {readGoogleSheets,sheetsWorkbook,sheetsCellHtml};').toString('base64'));
const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
const email='map-reader@project-test.iam.gserviceaccount.com';
const env={GOOGLE_SHEETS_ID:'abcdefghijklmnopqrstuv123456',GOOGLE_SHEETS_SERVICE_ACCOUNT:JSON.stringify({type:'service_account',client_email:email,private_key:pem})};
const metadata={properties:{title:'Fonte do mapa'},sheets:['Programas','Além do mapa programático'].map(title=>({properties:{title,gridProperties:{rowCount:1000,columnCount:26}}}))};
const cells={sheets:[{properties:{title:'Programas'},data:[{rowData:[{values:[{formattedValue:'Organização'},{formattedValue:'Programa'}]},{values:[{formattedValue:'Motriz'},{formattedValue:'Nome <seguro>',textFormatRuns:[{startIndex:0,format:{bold:true}},{startIndex:4,format:{bold:false}}]}]}]}]},{properties:{title:'Além do mapa programático'},data:[]}]};
const calls=[];
const fetcher=async(url,options)=>{
  calls.push(url);
  assert.equal(options.redirect,'manual');assert(options.signal);
  if(url==='https://oauth2.googleapis.com/token'){
    const form=new URLSearchParams(options.body),jwt=form.get('assertion'),[head,body,signature]=jwt.split('.');
    assert.equal(form.get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(JSON.parse(Buffer.from(head,'base64url')).alg,'RS256');
    const claims=JSON.parse(Buffer.from(body,'base64url'));
    assert.equal(claims.iss,email);assert.equal(claims.aud,url);assert.equal(claims.scope,'https://www.googleapis.com/auth/spreadsheets.readonly');assert.equal(claims.sub,undefined);assert.equal(claims.exp-claims.iat,600);
    assert(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',keys.publicKey,Buffer.from(signature,'base64url'),new TextEncoder().encode(head+'.'+body)));
    return Response.json({access_token:'test-token'});
  }
  assert.equal(options.headers.authorization,'Bearer test-token');
  const query=new URL(url).searchParams;
  if(!query.has('ranges'))return Response.json(metadata);
  assert.deepEqual(query.getAll('ranges'),["'Programas'!A1:Z1000","'Além do mapa programático'!A1:Z1000"]);
  return Response.json(cells);
};
const result=await readGoogleSheets(env,fetcher);
assert.equal(calls.length,3);assert.equal(result.title,'Fonte do mapa');assert.equal(result.workbook.Sheets.Programas.B2.h,'<strong>Nome</strong> &lt;seguro&gt;');
assert.equal(result.workbook.Sheets.Programas['!ref'],'A1:B2');
assert(!JSON.stringify(result).includes('test-token'));assert(!JSON.stringify(result).includes('PRIVATE KEY'));
assert.equal(sheetsCellHtml({effectiveFormat:{textFormat:{bold:true}}},'<img>'),'<strong>&lt;img&gt;</strong>');
assert.equal(sheetsCellHtml({textFormatRuns:[{},{startIndex:4,format:{bold:true}},{startIndex:8}]},'uma frase curta'),'uma <strong>fras</strong>e curta');
assert.equal(sheetsCellHtml({textFormatRuns:[{format:{bold:true}},{startIndex:4,format:{bold:false}}]},'Nome comum'),'<strong>Nome</strong> comum');
assert.throws(()=>sheetsCellHtml({textFormatRuns:[{startIndex:-1}]},'Texto'),/formatação/);
await assert.rejects(()=>readGoogleSheets({...env,GOOGLE_SHEETS_ID:'https://foreign.example'},()=>{throw Error('Must not fetch');}),/não foi configurada/);
await assert.rejects(()=>readGoogleSheets({...env,GOOGLE_SHEETS_SERVICE_ACCOUNT:'invalid'},()=>{throw Error('Must not fetch');}),/credencial/);
await assert.rejects(()=>readGoogleSheets(env,async()=>Response.json({error:'SENSITIVE_PROVIDER_BODY'},{status:403})),error=>error.status===503&&!error.message.includes('SENSITIVE'));
await assert.rejects(()=>readGoogleSheets(env,async()=>new Response('',{status:429})),error=>error.status===429);
let redirectCalls=0;
await assert.rejects(()=>readGoogleSheets(env,async()=>{redirectCalls++;return new Response('',{status:302,headers:{location:'https://unexpected.example'}});}),error=>error.status===503&&/redirecionamento/.test(error.message));
assert.equal(redirectCalls,1,'Never follow a redirect with credentials');
await assert.rejects(()=>readGoogleSheets(env,async()=>{throw Error('network secret');}),error=>!error.message.includes('secret'));
await assert.rejects(()=>readGoogleSheets(env,async(url,options)=>url.includes('/token')?fetcher(url,options):Response.json({sheets:[]})),/Programas/);
assert.throws(()=>sheetsWorkbook({sheets:[{properties:{title:'Programas'},data:[{startRow:5001,rowData:[{values:[{formattedValue:'extra'}]}]}]}]}),/limite/);
assert.throws(()=>sheetsWorkbook({sheets:[{properties:{title:'Programas'},data:[{startColumn:32,rowData:[{values:[{formattedValue:'extra'}]}]}]}]}),/limite/);
const workerSource=await fs.readFile('worker/index.js','utf8');
const worker=(await import('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64'))).default;
const origin='https://map.example.test',runtime={SITE_AUTH_MODE:'sites',MAP_ORIGIN:origin,MAP_ADMIN_EMAILS:'admin@example.test'};
const admin={'oai-authenticated-user-id':'admin','oai-authenticated-user-email':'admin@example.test',origin};
for(const [headers,status] of [[{},401],[{...admin,'oai-authenticated-user-email':'viewer@example.test'},403],[{...admin,origin:'https://foreign.example'},403]]){
  const response=await worker.fetch(new Request(origin+'/api/sheets/preview',{method:'POST',headers}),runtime);assert.equal(response.status,status);
}
let response=await worker.fetch(new Request(origin+'/api/sheets/preview',{method:'GET',headers:admin}),runtime);assert.equal(response.status,405);
response=await worker.fetch(new Request(origin+'/api/sheets/preview',{method:'POST',headers:admin}),runtime);assert.equal(response.status,503);assert((await response.json()).error.includes('não foi configurada'));
console.log('PASS — Sheets JWT signature and read-only scope, bounded ranges, rich text escaping, private credentials, provider failures, limits, server authorization and same-origin checks.');
