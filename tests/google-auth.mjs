import assert from 'node:assert/strict';

import {readFile} from 'node:fs/promises';

const source=await readFile('dist/app.mjs','utf8');

const worker=(await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))).default;

const objects=new Map();

const bucket={get:async key=>objects.has(key)?{json:async()=>JSON.parse(objects.get(key))}:null,put:async(key,value)=>{objects.set(key,value);return {etag:'test'};},delete:async key=>objects.delete(key)};

const base='https://mapa.example.test';

const env={STORE:bucket,MAP_ORIGIN:base,MAP_ADMIN_EMAILS:'admin@fundacaolemann.org.br',AUTH_ALLOWED_DOMAINS:'fundacaolemann.org.br,motriz.org',GOOGLE_CLIENT_ID:'test-client',GOOGLE_CLIENT_SECRET:'test-only'};

const request=(path,options={})=>worker.fetch(new Request(base+path,options),env);

let response=await request('/');assert.equal(response.status,303);assert.equal(response.headers.get('location'),'/login');

for(const path of ['/api/data','/api/session']){

  response=await request(path,{headers:{'x-user-id':'forged','x-user-email':env.MAP_ADMIN_EMAILS}});assert.equal(response.status,401);

  assert(!(await response.text()).includes('snapshot'));

}

response=await request('/login');const login=await response.text();assert(login.includes('Entrar com Google'));assert(!login.includes('const DIMENSIONS'));assert(!login.includes('test-only'));

for(const path of ['/auth/start/microsoft','/auth/callback/microsoft'])assert.equal((await request(path)).status,404);

assert.equal((await request('/auth/start/google',{method:'POST'})).status,405);

const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);

const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'test-key',alg:'RS256',use:'sig'};

const b64=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');

const makeToken=async claims=>{const data=b64({alg:'RS256',kid:'test-key'})+'.'+b64(claims);const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(data));return data+'.'+Buffer.from(signature).toString('base64url');};

const originalFetch=globalThis.fetch;

let claims,exchanges=0;

globalThis.fetch=async(url,options)=>{

  if(String(url)==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[jwk]});

  assert.equal(String(url),'https://oauth2.googleapis.com/token');assert(options.body.get('code_verifier'));assert.equal(options.body.get('redirect_uri'),base+'/auth/callback/google');exchanges++;return Response.json({id_token:await makeToken(claims)});

};

async function begin(){const r=await request('/auth/start/google');assert.equal(r.status,303);const target=new URL(r.headers.get('location'));assert.equal(target.origin,'https://accounts.google.com');assert.equal(target.searchParams.get('scope'),'openid email profile');assert.equal(target.searchParams.get('code_challenge_method'),'S256');return {state:target.searchParams.get('state'),nonce:target.searchParams.get('nonce'),cookie:r.headers.get('set-cookie').split(';')[0]};}

function identity(nonce,overrides={}){const now=Math.floor(Date.now()/1000);return {iss:'https://accounts.google.com',aud:'test-client',nonce,sub:'subject-1',email:env.MAP_ADMIN_EMAILS,email_verified:true,hd:'fundacaolemann.org.br',iat:now,exp:now+3600,...overrides};}

try{

  let start=await begin();claims=identity(start.nonce);

  response=await request('/auth/callback/google?code=test&state='+start.state,{headers:{cookie:'__Host-mapa_state=wrong'}});assert.equal(response.headers.get('location'),'/login?error=login');assert.equal(exchanges,0);

  response=await request('/auth/callback/google?code=test&state='+start.state,{headers:{cookie:start.cookie}});assert.equal(response.headers.get('location'),'/');

  const cookies=response.headers.getSetCookie();const session=cookies.find(x=>x.startsWith('__Host-mapa_session='));assert(session.includes('HttpOnly; Secure; SameSite=Lax'));const cookie=session.split(';')[0];

  response=await request('/api/session',{headers:{cookie}});assert.equal((await response.json()).canEdit,true);

  assert.equal((await request('/',{headers:{cookie}})).status,200);

  assert.equal((await request('/api/data',{headers:{cookie}})).status,200);

  assert.equal((await request('/auth/callback/google?code=test&state='+start.state,{headers:{cookie:start.cookie}})).headers.get('location'),'/login?error=login');

  await request('/auth/logout',{headers:{cookie}});assert.equal((await request('/api/data',{headers:{cookie}})).status,401);

  for(const overrides of [{hd:'outside.org',email:'person@outside.org'},{email:'person@motriz.org.br',hd:'motriz.org.br'},{hd:'motriz.org'},{email_verified:false},{aud:'other-client'},{nonce:'wrong'},{exp:0}]){

    start=await begin();claims=identity(start.nonce,overrides);response=await request('/auth/callback/google?code=test&state='+start.state,{headers:{cookie:start.cookie}});assert.equal(response.headers.get('location'),'/login?error=denied');assert(!response.headers.getSetCookie().some(x=>x.startsWith('__Host-mapa_session=')));

  }

  start=await begin();claims=identity(start.nonce,{email:'viewer@motriz.org',hd:'motriz.org'});response=await request('/auth/callback/google?code=test&state='+start.state,{headers:{cookie:start.cookie}});const viewerCookie=response.headers.getSetCookie().find(x=>x.startsWith('__Host-mapa_session=')).split(';')[0];

  assert.equal((await (await request('/api/session',{headers:{cookie:viewerCookie}})).json()).canEdit,false);

  assert.equal((await request('/api/data',{method:'PUT',headers:{cookie:viewerCookie,origin:base,'content-type':'application/json'},body:'{}'})).status,403);

  const stateKey=[...objects.keys()].find(x=>x.startsWith('auth/states/'));if(stateKey){const pending=JSON.parse(objects.get(stateKey));pending.expires=0;objects.set(stateKey,JSON.stringify(pending));}

  const sessionKey=[...objects.keys()].find(x=>x.startsWith('auth/sessions/'));const saved=JSON.parse(objects.get(sessionKey));saved.expires=0;objects.set(sessionKey,JSON.stringify(saved));assert.equal((await request('/api/session',{headers:{cookie:viewerCookie}})).status,401);

}finally{globalThis.fetch=originalFetch;}

console.log('PASS — página/API protegidas, OAuth PKCE/state/nonce, assinatura Google, domínios, papéis, expiração, logout e rejeição de replay.');

