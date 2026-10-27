import {createHash} from 'node:crypto';

// Content-addressed resources keep the protected document small and allow private caching.
export function pageAssets(html) {
  const assets=Object.create(null);
  const page=html.replace(/data:(image\/(?:png|webp)|font\/ttf);base64,([A-Za-z0-9+/=]+)/g,(_,type,base64)=>{
    const bytes=Buffer.from(base64,'base64'),hash=createHash('sha256').update(bytes).digest('hex');
    const ext=type==='font/ttf'?'ttf':type.split('/')[1],path='/assets/'+hash+'.'+ext;
    assets[path]={type,base64,etag:hash};
    return path;
  }).replace(/<img class="map-img"/g,'<img loading="lazy" decoding="async" class="map-img"');
  return {page,assets};
}
