const DATA_KEY = 'mapa-ecossistema/current.json';
const BODY_LIMIT = 2 * 1024 * 1024;
function json(body,status=200) {
  return Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
}
function canEdit(user,env) {
  const allowed=String(env.MAP_ADMIN_EMAILS||'').split(/[;,]/).map(x=>x.trim().toLowerCase()).filter(Boolean);
  return !!user && allowed.includes(user.email);
}
async function readBody(request) {
  if(!request.body)throw Error('Envie os dados da atualização.');
  const reader=request.body.getReader(),chunks=[];
  let count=0;
  while(true){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>BODY_LIMIT){await reader.cancel();throw Error('A atualização excede 2 MB.');}chunks.push(value);}
  const bytes=new Uint8Array(count);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
async function handleData(request,env,user) {
  if(!env.BUCKET)return json({error:'O armazenamento compartilhado está indisponível. Tente novamente mais tarde.'},503);
  if(request.method==='GET'){
    try{
      const object=await env.BUCKET.get(DATA_KEY);
      if(!object)return json({snapshot:INITIAL_SNAPSHOT,revision:null,updatedAt:null});
      const stored=await object.json();
      const snapshot=validateSnapshot(stored.snapshot);
      return json({snapshot,revision:object.etag,updatedAt:stored.updatedAt});
    }catch(_){return json({error:'Não foi possível carregar a versão compartilhada. A versão atual não foi alterada.'},503);}
  }
  if(request.method!=='PUT')return json({error:'Método não permitido.'},405);
  if(!canEdit(user,env))return json({error:'Sua conta não tem permissão para publicar atualizações.'},403);
  const origin=request.headers.get('origin'),expected=env.MAP_ORIGIN||new URL(request.url).origin;
  if(origin!==expected||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem da solicitação não permitida.'},403);
  if(!request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return json({error:'Formato de solicitação inválido.'},415);
  let body,snapshot;
  try{
    body=await readBody(request);
    if(!body || (body.revision!==null && (typeof body.revision!=='string'||!/^[a-zA-Z0-9-]{1,128}$/.test(body.revision))))throw Error('A versão da atualização é inválida. Recarregue o mapa.');
    if(!body.snapshot || ['dims','ext','colors','extra'].some(key=>!Object.hasOwn(body.snapshot,key)))throw Error('A atualização está incompleta. Nenhum dado foi salvo.');
    snapshot=validateSnapshot(body.snapshot);
  }catch(err){return json({error:err.message||'Dados inválidos. Nenhuma alteração foi salva.'},400);}
  try{
    const updatedAt=new Date().toISOString();
    // R2 evaluates the condition atomically, including the first write.
    const saved=await env.BUCKET.put(DATA_KEY,JSON.stringify({snapshot,updatedAt}),{
      onlyIf:body.revision===null?new Headers({'If-None-Match':'*'}):{etagMatches:body.revision},
      httpMetadata:{contentType:'application/json',cacheControl:'no-store'}
    });
    if(!saved)return json({error:'Outra atualização foi salva enquanto você trabalhava. Baixe sua cópia antes de recarregar o mapa e conferir as mudanças.'},409);
    return json({snapshot,revision:saved.etag,updatedAt});
  }catch(_){return json({error:'Não foi possível salvar. Sua prévia foi preservada; tente novamente ou baixe uma cópia.'},503);}
}
export default {
  async fetch(request,env){
    const pathname=new URL(request.url).pathname;
    let authentication;
    try{authentication=await mapSSO(env).handle(request)??await authRoute(request,env);}catch{
      if(pathname.startsWith('/auth/sso/'))return redirect('/login?sso=skip');
      return json({error:'O login está temporariamente indisponível. Tente novamente.'},503);
    }
    if(authentication)return authentication;
    if(!['/','/api/session','/api/data','/api/sheets/preview'].includes(pathname))return new Response('Não encontrado',{status:404});
    let user;
    try{user=await sessionUser(request,env);}catch{return json({error:'Não foi possível verificar a sessão. Tente novamente.'},503);}
    if(!user){
      if(pathname==='/')return redirect('/login');
      return json({error:'Entre com sua conta institucional para acessar o mapa.'},401);
    }
    if(pathname==='/api/session'&&request.method==='GET'){
      const editor=canEdit(user,env);
      const sourceUrl=editor&&/^[A-Za-z0-9_-]{20,150}$/.test(env.GOOGLE_SHEETS_ID||'')?'https://docs.google.com/spreadsheets/d/'+env.GOOGLE_SHEETS_ID+'/edit':null;
      return json({canEdit:editor,sourceUrl});
    }
    if(pathname==='/api/sheets/preview'){
      if(!canEdit(user,env))return json({error:'Sua conta não tem permissão para atualizar o mapa.'},403);
      if(request.method!=='POST')return json({error:'Método não permitido.'},405);
      const expected=env.MAP_ORIGIN||new URL(request.url).origin;
      if(request.headers.get('origin')!==expected||request.headers.get('sec-fetch-site')==='cross-site')return json({error:'Origem da solicitação não permitida.'},403);
      try{return json(await readGoogleSheets(env));}
      catch(error){return json({error:error.status?error.message:'Não foi possível ler a fonte do Google Sheets. Os dados publicados foram preservados.'},error.status||503);}
    }
    if(pathname==='/api/data')return handleData(request,env,user);
    if(pathname!=='/'||!['GET','HEAD'].includes(request.method))return new Response('Não encontrado',{status:404});
    return new Response(request.method==='HEAD'?null:PAGE,{headers:{
      'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'x-content-type-options':'nosniff','referrer-policy':'same-origin'
    }});
  }
};
