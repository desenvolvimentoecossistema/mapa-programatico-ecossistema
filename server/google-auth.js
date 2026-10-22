const SESSION_COOKIE='__Host-mapa_session', STATE_COOKIE='__Host-mapa_state';
const STATE_LIFETIME=600, SESSION_LIFETIME=8*60*60;
const domains=env=>String(env.AUTH_ALLOWED_DOMAINS||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
const permitted=(user,env)=>!!user && domains(env).includes(user.email?.split('@')[1]);
const random=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const cookie=(name,value,age)=>`${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
function readCookie(request,name){const parts=(request.headers.get('cookie')||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(name+'='));return parts.length===1?parts[0].slice(name.length+1):'';}
function origin(env){try{const u=new URL(env.MAP_ORIGIN);return u.protocol==='https:'&&u.pathname==='/'&&!u.search&&!u.hash?u.origin:null;}catch{return null;}}
function redirect(path,cookies=[]){const headers=new Headers({'location':path,'cache-control':'no-store','referrer-policy':'no-referrer'});for(const value of cookies)headers.append('set-cookie',value);return new Response(null,{status:303,headers});}
function ready(env){return !!(origin(env)&&env.BUCKET&&env.GOOGLE_CLIENT_ID&&env.GOOGLE_CLIENT_SECRET&&domains(env).length);}
async function record(bucket,key){const value=await bucket.get(key);return value?value.json():null;}
async function sessionUser(request,env){
  if(env.SITE_AUTH_MODE==='sites'){
    const id=request.headers.get('oai-authenticated-user-id'),email=request.headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
    return id&&email?{userId:id,email}:null;
  }
  const token=readCookie(request,SESSION_COOKIE);
  if(!/^[A-Za-z0-9_-]{43}$/.test(token)||!env.BUCKET)return null;
  const key='auth/sessions/'+await digest(token),stored=await record(env.BUCKET,key);
  if(!stored)return null;
  if(stored.expires<=Date.now()||!permitted(stored.user,env)){await env.BUCKET.delete(key);return null;}
  return { ...stored.user, sessionExpiresAt: stored.expires };
}
async function authRoute(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(!['/login','/auth/start/google','/auth/callback/google','/auth/logout'].includes(path))return null;
  if(request.method!=='GET')return json({error:'Método não permitido.'},405);
  if(path==='/login'){
    if(await sessionUser(request,env))return redirect('/');
    if(env.SSO_AUTO_LOGIN==='true'&&mapSSO(env).enabled&&!url.searchParams.has('error')&&url.searchParams.get('sso')!=='skip')return redirect('/auth/sso/start');
    const messages={denied:'Esta conta não tem acesso ao mapa. Use sua conta institucional.',login:'Não foi possível concluir o login. Tente novamente.'};
    const message=messages[url.searchParams.get('error')]||'';
    const action=ready(env)?'<a class="google login-button" href="/auth/start/google" target="_top">Entrar com Google <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14m-6-6 6 6-6 6"/></svg></a>':'<p role="status">O login Google está em configuração. Tente novamente em breve.</p>';
    // Consume the skip on arrival, so a later reload can discover a new peer session.
    const nonce=random();
    const cleanup=url.searchParams.get('sso')==='skip'?`<script nonce="${nonce}">(()=>{const url=new URL(location.href);url.searchParams.delete('sso');history.replaceState(history.state,'',url.pathname+url.search+url.hash);})();</script>`:'';
    const login=LOGIN_PAGE.replace('<!--LOGIN_ACTION-->',action).replace('<!--LOGIN_ERROR-->',message?'<p class="error" role="alert">'+message+'</p>':'').replace('</body>',cleanup+'</body>');
    return new Response(login,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'self'`}});
  }
  if(path==='/auth/logout'){
    const token=readCookie(request,SESSION_COOKIE);
    if(/^[A-Za-z0-9_-]{43}$/.test(token)&&env.BUCKET)await env.BUCKET.delete('auth/sessions/'+await digest(token));
    return redirect(mapSSO(env).logoutTarget(url.searchParams.get('sso')==='return'),[cookie(SESSION_COOKIE,'',0),cookie(STATE_COOKIE,'',0),cookie('__Host-mapa_sso_state','',0)]);
  }
  if(!ready(env))return json({error:'Login Google indisponível. A configuração está incompleta.'},503);
  if(path==='/auth/start/google'){
    const state=random(),nonce=random(),verifier=random();
    await env.BUCKET.put('auth/states/'+await digest(state),JSON.stringify({nonce,verifier,expires:Date.now()+STATE_LIFETIME*1000}),{httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
    const challenge=btoa(String.fromCharCode(...hash)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const authorize=new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authorize.search=new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,redirect_uri:origin(env)+'/auth/callback/google',response_type:'code',scope:'openid email profile',state,nonce,code_challenge:challenge,code_challenge_method:'S256',prompt:'select_account'}).toString();
    return redirect(authorize.href,[cookie(STATE_COOKIE,state,STATE_LIFETIME)]);
  }
  const state=url.searchParams.get('state'),browserState=readCookie(request,STATE_COOKIE);
  const clear=[cookie(STATE_COOKIE,'',0)];
  if(!state||!/^[A-Za-z0-9_-]{43}$/.test(state)||state!==browserState){console.warn('map-auth: state-invalid',browserState?'mismatch':'cookie-missing');return redirect('/login?error=login',clear);}
  const key='auth/states/'+await digest(state),pending=await record(env.BUCKET,key);
  await env.BUCKET.delete(key);
  const code=url.searchParams.get('code');
  if(!pending||pending.expires<=Date.now()||!code||code.length>4096||url.searchParams.has('error')){console.warn('map-auth: authorization-invalid',!pending?'state-missing':pending.expires<=Date.now()?'expired':'code-missing-or-denied');return redirect('/login?error=login',clear);}
  try{
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,code,code_verifier:pending.verifier,grant_type:'authorization_code',redirect_uri:origin(env)+'/auth/callback/google'}),signal:AbortSignal.timeout(15000)});
    if(!response.ok){const result=await response.json().catch(()=>({}));const category=['invalid_client','invalid_grant','invalid_request','unauthorized_client'].includes(result.error)?result.error:'other';console.warn('map-auth: token-exchange-rejected',response.status,category);return redirect('/login?error=login',clear);}
    const tokens=await response.json(),user=await verifyIdentityToken(tokens.id_token,'google',env.GOOGLE_CLIENT_ID,pending.nonce,domains(env));
    if(!permitted(user,env))return redirect('/login?error=denied',clear);
    const token=random();
    await env.BUCKET.put('auth/sessions/'+await digest(token),JSON.stringify({user,expires:Date.now()+SESSION_LIFETIME*1000}),{httpMetadata:{contentType:'application/json',cacheControl:'no-store'}});
    return redirect('/',[...clear,cookie(SESSION_COOKIE,token,SESSION_LIFETIME)]);
  }catch{console.warn('map-auth: token-exchange-or-session-storage-failed');return redirect('/login?error=login',clear);}
}
