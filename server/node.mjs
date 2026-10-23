import { createServer } from 'node:http';

import app from '../dist/app.mjs';

import { SqliteStore } from './store.mjs';

const publicOrigin=new URL(process.env.MAP_ORIGIN || 'https://mapa.exemplo.org').origin;

const store=new SqliteStore(process.env.DATABASE_PATH || './data/mapa.sqlite');

const env={...process.env,MAP_ORIGIN:publicOrigin,STORE:store};

const server=createServer(async(req,res)=>{

  try {

    if(!req.url?.startsWith('/')||req.url.startsWith('//')) {res.writeHead(400);res.end();return;}

    const chunks=[];let size=0;

    for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024){res.writeHead(413);res.end();return;}chunks.push(chunk);}

    const headers=new Headers();for(const [name,value] of Object.entries(req.headers)){if(value)headers.set(name,Array.isArray(value)?value.join(','):value);}

    const response=await app.fetch(new Request(publicOrigin+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)}),env);

    res.statusCode=response.status;

    response.headers.forEach((value,name)=>{if(name!=='set-cookie')res.setHeader(name,value);});

    const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('set-cookie',cookies);

    res.end(req.method==='HEAD'?undefined:Buffer.from(await response.arrayBuffer()));

  } catch { if(!res.headersSent)res.writeHead(500,{'content-type':'text/plain; charset=utf-8'});res.end('Não foi possível concluir a solicitação.'); }

});

server.requestTimeout=30000;server.headersTimeout=15000;

server.listen(Number(process.env.PORT||3001),process.env.HOST||'127.0.0.1',()=>console.log('Servidor do mapa iniciado.'));

for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();process.exit(0);}));

