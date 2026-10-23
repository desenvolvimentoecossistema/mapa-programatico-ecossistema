const fs = require('fs'), vm = require('vm'), assert = require('assert');
const path=require('path'), cp=require('child_process');
const fixture=JSON.parse(cp.execFileSync(process.env.PYTHON||'python3',[path.join(__dirname,'read-fixture.py')],{encoding:'utf8'}));
// A deliberately small DOM double for unit tests, not a browser or visual test.
class Element {
  constructor(tag='div') {
    this.tagName=tag; this.attributes={}; this.dataset={}; this.style={}; this.children=[]; this.events={}; this.value=''; this._html=''; this.scrollTop=0; this.className='';
    const classes=()=>new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList={contains:x=>classes().has(x),add:x=>{const set=classes();set.add(x);this.className=[...set].join(' ');},remove:x=>{const set=classes();set.delete(x);this.className=[...set].join(' ');},toggle:(x,force)=>{const on=force??!classes().has(x);this.classList[on?'add':'remove'](x);return on;}};
  }
  set innerHTML(v){this._html=String(v);this.children=[];}
  get innerHTML(){return this._html+this.children.map(e=>e.outerHTML).join('');}
  get outerHTML(){const attrs=Object.entries(this.attributes).map(([k,v])=>' '+k+'="'+String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'"').join('');return '<'+this.tagName+attrs+'>'+this.innerHTML+(this.textContent||'')+'</'+this.tagName+'>';}
  appendChild(e){e.parentElement=this;this.children.push(e);return e;}
  addEventListener(n,cb){(this.events[n]??=[]).push(cb);}
  matches(selector){
    if(selector==='[data-focus-key]')return !!this.dataset.focusKey;
    const match=selector.match(/^([a-z]+)?(?:\.([\w-]+))?$/);
    return !!match&&(!match[1]||match[1]===this.tagName)&&(!match[2]||this.classList.contains(match[2]));
  }
  querySelectorAll(selector){return this.children.flatMap(e=>[...(e.matches(selector)?[e]:[]),...e.querySelectorAll(selector)]);}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  setAttribute(k,v){this.attributes[k]=v;if(k==='class')this.className=v;else this[k]=v;}
  getAttribute(k){return this.attributes[k]??this[k]??null;}
  focus(){document.activeElement=this;}
  select(){}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(e=>e!==this);}
  click(){(this.events.click||[]).forEach(f=>f({target:this,preventDefault(){},stopPropagation(){}}));}
}
const els=new Map();
const document={getElementById:id=>{if(!els.has(id))els.set(id,new Element());return els.get(id)},querySelectorAll:()=>[],querySelector:s=>s==='.programs-wrap'?new Element():null,createElement:t=>new Element(t),createElementNS:(ns,t)=>new Element(t),addEventListener:()=>{},body:new Element(),head:new Element('head'),createTreeWalker:()=>({nextNode:()=>false})};
const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const ctx=vm.createContext({document,localStorage:storage,sessionStorage:storage,console,unescape,encodeURIComponent,NodeFilter:{SHOW_TEXT:4},setTimeout:()=>0,clearTimeout:()=>{},Blob,URL,Uint8Array,Uint32Array,DataView,TextDecoder,DecompressionStream,location:{reload:()=>{}}});
const html=fs.readFileSync(process.argv[2] || path.join(__dirname,'../site/index.html'),'utf8');
const js=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
vm.runInContext(js,ctx);
const nativeReader=ctx.NativeXLSX;
const run=s=>vm.runInContext(s,ctx);
assert.equal(run('Object.values(DIMENSIONS).reduce((n,p)=>n+Object.keys(p).length,0)'),38);
console.log('Programs by tab:',run('JSON.stringify({educacao:tabCount("educacao"),liderancas:tabCount("liderancas")})'));
assert.equal(run('progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)).length'),run('tabCount("educacao")'));
assert.equal(run('Object.values(DIMENSIONS).flatMap(o=>Object.values(o)).flatMap(d=>validateEstrategias(d.estrategias).invalid).length'),0);
assert.equal(run('Object.values(MAP_HOTSPOTS).flat().filter(h=>!STRAT_CATALOG[h.k]).length'),0);
for (const tab of ['educacao','liderancas']) {
  run(`switchTab('${tab}'); clearKw();`);
  const keys=run(`Object.keys(STRAT_CATALOG).filter(k=>progEntries.some(e=>e.estrKeys.includes(k)))`);
  for(const key of keys){
    run(`progFilterGroups.forEach(g=>{g.state=makeFilterState(g.optionValues);g.touched=false}); syncStrategyGroup();`);
    run(`filterByEstrategia(${JSON.stringify(key)},'mapa-alfa')`);
    assert(run('progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)).length')>0,key);
    assert.equal(run('progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)).length'),run('programsPerEstrategia()['+JSON.stringify(key)+']'),key+' map count must equal filtered programs');
    assert(run(`progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)).every(e=>e.estrKeys.includes(${JSON.stringify(key)}))`),key);
  }
  console.log('Strategy links passed:',tab,keys.length);
  run('progFilterGroups.forEach(initGroup);syncStrategyGroup();kwQuery="alfabetizacao"');
  assert(run('progEntries.filter(kwMatch).every(e=>e.searchText.includes("alfabetizacao"))'));
}
ctx.rows=fixture.programRows;
assert.equal(run('rowsToDimensions(rows).skipped'),0);
assert.equal(run('rowsToDimensions(rows).invalidEstr.length'),0);
assert.equal(run('rowsToDimensions(rows).invalidPub.length'),0);
console.log('Workbook rows, canonical audiences and strategies passed');
ctx.extRows=fixture.extRows;
ctx.XLSX={utils:{sheet_to_json:(sheet,opts)=>opts?.header===1?[fixture.extHeaders]:sheet}};ctx.NativeXLSX=ctx.XLSX;
assert.equal(run('parseExtSheet({Sheets:{[EXT_SHEET]:extRows}}).warnings.length'),0);
for(const [marker, variable] of [['let MAP_EXT = ','MAP_EXT'],['let EXT_COLORS = ','EXT_COLORS'],['let MAP_ORGS_EXTRA = ','MAP_ORGS_EXTRA']]){
  const parsed=run("parseExtSheet({Sheets:{[EXT_SHEET]:extRows}})");
  run("applySnapshot({dims:DIMENSIONS,...parseExtSheet({Sheets:{[EXT_SHEET]:extRows}})})");
  const raw=html.split(marker)[1].split(/;\r?\n/)[0];
  const expected=JSON.parse(raw), actual=JSON.parse(run(`JSON.stringify(${variable})`));
  assert.deepEqual(actual,expected,variable+' must match workbook');
}
console.log('External organizations, colors and extra strategy labels match workbook');
if(run('typeof escapeHtml')==='function'){
  assert.equal(run('escapeHtml("<img src=x onerror=alert(1)>")'),'&lt;img src=x onerror=alert(1)&gt;');
  assert(!run('safeDescription("<img src=x onerror=alert(1)><strong onclick=x>Texto</strong>")').includes('<img'));
  assert.equal(run('safeDescription("<strong onclick=x>Texto</strong>")'),'<strong>Texto</strong>');
  assert.throws(()=>run('rowsToDimensions([rows[0],rows[0]])'),/duplicado/);
  console.log('Imported markup and duplicate validation passed');
}
run('switchTab("educacao");progFilterGroups.forEach(initGroup);syncStrategyGroup();const sg=progGroup("estrategia");sg.touched=true;sg.state=new Set();autoFillUntouched(progFilterGroups,progEntries);syncStrategyGroup();');
assert.equal(run('progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)).length'),0);
run('sg.touched=false;autoFillUntouched(progFilterGroups,progEntries);syncStrategyGroup();');
assert.equal(run('progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)).length'),27);
assert.equal(run('validateEstrategias(["constructor","__proto__"]).valid.length'),0);
assert.equal(run('rowsToDimensions([{...rows[0],"Estratégias do mapa de atuação":rows[0]["Estratégias do mapa de atuação"]+";"+rows[0]["Estratégias do mapa de atuação"]}]).dims.abc[rows[0].Programa].estrategias.length'),7);
assert.throws(()=>run('rowsToDimensions([{...rows[0],"Organização":"não existe"}])'),/não reconhecido/);
assert.throws(()=>run('validateSnapshot({dims:{abc:{Incompleto:{}}}})'),/Campo inválido/);
assert.throws(()=>run('validateSnapshot({dims:{}})'),/Nenhum programa/);
assert.equal(run('safeDescription("A &amp; B\\n<strong>x</strong>")'),'A &amp; B<br><strong>x</strong>');
assert.equal(run('richHtmlToStrongMarkup("<span style=\\"font-weight: bold;\\">Negrito</span>")'),'<strong>Negrito</strong>');
console.log('Filter restore, inherited keys, deduplicated counts and rich text passed');

const panel=document.getElementById('programs-filters');
run('buildFilterUI(document.getElementById("programs-filters"),progFilterGroups,progEntries,renderProgramsGrid)');
const checkbox=panel.querySelectorAll('input').find(el=>el.type==='checkbox');
checkbox.focus();checkbox.checked=false;checkbox.events.change[0]();
assert.equal(document.activeElement.dataset.focusKey,checkbox.dataset.focusKey);
assert.notEqual(document.activeElement,checkbox);
console.log('Filter rebuild restores keyboard focus');

const maps=[];
for(const mk of ['alfa','fund2','lid']){
  const view=new Element();view.className='l2-view-mapa';
  const canvas=new Element();canvas.className='map-canvas';canvas.dataset.map=mk;view.appendChild(canvas);
  const image=new Element('img');image.className='map-img';image.src='data:image/webp;base64,TEST';canvas.appendChild(image);
  ctx.testCanvas=canvas;ctx.testView=view;ctx.mk=mk;
  run('renderMapTags(testCanvas,mk);renderMapList(testView,mk,programsPerEstrategia())');
  const config=run('MAP_TAGS[mk]');
  const rects=canvas.querySelectorAll('rect');
  assert(rects.length>0);
  const overlaps=[]; for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){ const a=rects[i].attributes,b=rects[j].attributes;const dx=Math.min(+a.x + +a.width,+b.x + +b.width)-Math.max(+a.x,+b.x);const dy=Math.min(+a.y + +a.height,+b.y + +b.height)-Math.max(+a.y,+b.y);if(dx>0.2&&dy>0.2)overlaps.push([i,j,dx*dy]);} assert.equal(overlaps.length,0,mk+' tags must not overlap');

  const outside=rects.filter(r=>Number(r.attributes.x)<0||Number(r.attributes.y)<0||Number(r.attributes.x)+Number(r.attributes.width)>config.vb[0]||Number(r.attributes.y)+Number(r.attributes.height)>config.vb[1]);
  assert.equal(outside.length,0,mk+' tags must stay inside the map');
  assert.equal(view.querySelectorAll('article').length,run('MAP_HOTSPOTS[mk].length'));
  maps.push({view,mk});
}
console.log('Map label bounds and accessible lists passed for all 127 strategies');

// This adapter supplies parsed worksheet cells from the actual fixture.
// It intentionally does not claim to test the third-party XLSX binary reader.
function decodeCell(address){const match=address.match(/^([A-Z]+)(\d+)$/);let col=0;for(const c of match[1])col=col*26+c.charCodeAt(0)-64;return {r:Number(match[2])-1,c:col-1};}
function encodeCell(cell){let col=cell.c+1,label='';while(col){col--;label=String.fromCharCode(65+col%26)+label;col=Math.floor(col/26);}return label+(cell.r+1);}
function decodeRange(ref){const [start,end=start]=ref.split(':');return {s:decodeCell(start),e:decodeCell(end)};}
const utils={
  decode_range:decodeRange,encode_cell:encodeCell,
  sheet_to_json(sheet,options={}){
    const range=decodeRange(sheet['!ref']), grid=[];
    for(let r=range.s.r;r<=range.e.r;r++){const row=[];for(let c=range.s.c;c<=range.e.c;c++)row.push(sheet[encodeCell({r,c})]?.v??'');if(row.some(Boolean))grid.push(row);}
    if(options.header===1)return grid;
    return grid.slice(1).map(row=>Object.fromEntries(grid[0].map((key,i)=>[key,row[i]??'']).filter(entry=>entry[0])));
  }
};
ctx.XLSX={utils};ctx.NativeXLSX=ctx.XLSX;
const quietConsole={...console,error:()=>{}};ctx.console=quietConsole;
(async()=>{
  const stored={v:run('DATA_VERSION'),dims:{abc:{Broken:{}}}};
  const context2=vm.createContext({...ctx,localStorage:{getItem:()=>JSON.stringify(stored),removeItem:()=>{}}});
  vm.runInContext(js,context2);
  assert.equal(vm.runInContext('tabCount("educacao")',context2),27);
  assert.equal(vm.runInContext('usingLocalData',context2),false);
  const blobs=[];ctx.URL={createObjectURL:blob=>{blobs.push(blob);return 'blob:test'},revokeObjectURL:()=>{}};
  for(const {view} of maps){ctx.downloadView=view;run('downloadCurrentMap(downloadView,{preventDefault(){}})');}
  for(const blob of blobs){const svg=await blob.text();assert(svg.includes('font-family='));assert(svg.includes('<rect'));assert(svg.includes('<circle'));assert(svg.includes('data:image/webp;base64,TEST'));}
  console.log('Corrupted cache and map exports passed');
  const workerSource=fs.readFileSync(path.join(__dirname,'../worker/index.js'),'utf8');
  const worker=(await import('data:text/javascript;base64,'+Buffer.from(workerSource).toString('base64'))).default;
  let sharedBody=null,sharedETag=null,sharedWrites=0;
  let workbook={Sheets:structuredClone(fixture.sheets)};
  let upstreamFailure=false;
  const origin='https://integration.example';
  const bucket={get:async()=>sharedBody?{etag:sharedETag,json:async()=>JSON.parse(sharedBody)}:null,put:async(key,body,options)=>{
    if(options.onlyIf instanceof Headers?sharedBody!==null:options.onlyIf.etagMatches!==sharedETag)return null;
    sharedBody=body;sharedETag='revision-'+(++sharedWrites);return {etag:sharedETag};
  }};
  const env={SITE_AUTH_MODE:'sites',BUCKET:bucket,MAP_ADMIN_EMAILS:'owner@example.test',MAP_ORIGIN:origin};
  function hostedContext(email){
    const hosted=vm.createContext({...ctx,AbortSignal,location:{protocol:'https:'},URL,fetch:(url,options={})=>{
      if(url==='/api/sheets/preview'){
        assert.equal(options.method,'POST');
        if(email!=='owner@example.test')return Promise.resolve(Response.json({error:'Sem permissão'}, {status:403}));
        return Promise.resolve(upstreamFailure?Response.json({error:'Fonte indisponível'},{status:503}):Response.json({workbook,title:'Fonte de teste',readAt:new Date().toISOString(),url:'https://docs.google.com/spreadsheets/d/abcdefghijklmnopqrstuv123456/edit'}));
      }
      const headers=new Headers(options.headers);headers.set('oai-authenticated-user-id',email);headers.set('oai-authenticated-user-email',email);
      if(options.method==='PUT')headers.set('origin',origin);
      return worker.fetch(new Request(origin+url,{...options,headers}),env,{});
    }});
    vm.runInContext(js,hosted);hosted.NativeXLSX={utils};return hosted;
  }
  const owner=hostedContext('owner@example.test'),execute=s=>vm.runInContext(s,owner);
  await execute('loadSharedData()');
  assert.equal(document.getElementById('data-management-label').hidden,false);
  assert.equal(execute('adminUnlocked && sharedReady'),true);
  await execute('handleGoogleSheetsUpdate()');
  assert.equal(sharedWrites,0,'Reading a preview must not publish');
  assert.equal(execute('usingLocalData'),true);
  assert.equal(document.getElementById('data-confirm-btn').hidden,false);
  assert(document.getElementById('data-status').textContent.includes('Prévia de 38 programas'));
  const snapshot=execute('JSON.stringify([DIMENSIONS,MAP_EXT,EXT_COLORS,MAP_ORGS_EXTRA])');
  const badCases=[wb=>{delete wb.Sheets.Programas.H1;},wb=>{wb.Sheets.Programas.A2.v='Não existe';},wb=>{wb.Sheets.Programas.K2.v='Chave incorreta';},wb=>{wb.Sheets['Além do mapa programático'].J2.v='cor inválida';},wb=>{delete wb.Sheets['Além do mapa programático'].G1;}];
  for(const alter of badCases){workbook={Sheets:structuredClone(fixture.sheets)};alter(workbook);await execute('handleGoogleSheetsUpdate()');assert(document.getElementById('data-status').textContent.startsWith('Atualização cancelada:'));assert.equal(execute('JSON.stringify([DIMENSIONS,MAP_EXT,EXT_COLORS,MAP_ORGS_EXTRA])'),snapshot);assert.equal(sharedWrites,0);}
  upstreamFailure=true;await execute('handleGoogleSheetsUpdate()');assert.equal(execute('JSON.stringify([DIMENSIONS,MAP_EXT,EXT_COLORS,MAP_ORGS_EXTRA])'),snapshot);assert.equal(sharedWrites,0);upstreamFailure=false;
  workbook={Sheets:structuredClone(fixture.sheets)};await execute('handleGoogleSheetsUpdate()');await execute('publishSharedData()');
  assert.equal(sharedWrites,1);assert.equal(execute('usingLocalData'),false);assert.equal(execute('sharedRevision'),'revision-1');
  const viewer=hostedContext('viewer@example.test');await vm.runInContext('loadSharedData()',viewer);
  assert.equal(vm.runInContext('sharedRevision',viewer),'revision-1');assert.equal(vm.runInContext('adminUnlocked',viewer),false);
  for(const id of ['data-upload-btn','data-management-label','data-confirm-btn','data-source-link'])assert.equal(document.getElementById(id).hidden,true,id+' must stay hidden for viewers');
  vm.runInContext('adminUnlocked=true;usingLocalData=true',viewer);await vm.runInContext('publishSharedData()',viewer);assert.equal(sharedWrites,1);assert.equal(vm.runInContext('usingLocalData',viewer),true);
  console.log('PASS — Sheets preview, validation failures, upstream failure, explicit publication, second visitor read and authorization. Browser/visual checks remain separate.');
})().catch(err=>{console.error(err);process.exitCode=1;});
