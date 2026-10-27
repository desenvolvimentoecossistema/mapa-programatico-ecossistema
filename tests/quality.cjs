const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const filename=path.join(__dirname,'audit.cjs'),audit=fs.readFileSync(filename,'utf8');
const prefix=audit.slice(0,audit.indexOf('assert.equal(run('));
const checks=String.raw`
const panel=document.getElementById('programs-filters');
const choose=(key,value)=>{const cb=panel.querySelectorAll('input').find(e=>e.dataset.focusKey===JSON.stringify([key,value]));assert(cb,'Missing option '+value);cb.checked=true;cb.events.change[0]();};
const only=(key,value)=>{for(const cb of panel.querySelectorAll('input').filter(e=>{try{const k=JSON.parse(e.dataset.focusKey);return k[0]===key&&k.length===2;}catch{return false;}})){const option=JSON.parse(cb.dataset.focusKey)[1];if(option!==value&&cb.checked){cb.checked=false;cb.events.change[0]();}}choose(key,value);};
const count=()=>run('progEntries.filter(e=>entryMatchesFilters(e,progFilterGroups)&&kwMatch(e)).length');
for(const [tab,phase,type,expected] of [['educacao','Política Nacional','Desenvolvimento de Capacidade Estatal',2],['educacao','Implementação','Regime de Colaboração',1],['liderancas','Pipeline','Gestão pública – impacto direto',6],['liderancas','Em exercício','Outras teses fora da gestão pública',2]]){
 run('switchTab('+JSON.stringify(tab)+')');document.getElementById('programs-reset').click();only('etapa',phase);only('tipo',type);assert.equal(count(),expected,phase+' + '+type);
}
assert.deepEqual(JSON.parse(run('JSON.stringify(publicoTagsFor("Estudantes.; estudantes; Gestores Escolares"))')),['Estudantes','Diretores e gestores escolares']);
assert.equal(run('uniqueSorted([{v:["Geral","Nova etapa","Pré-escola","Alfabetização"]}],e=>e.v,NIVEL_ORDER).at(-1)'),'Geral');
document.getElementById('programs-select-all').click();run('kwQuery="MegaEdu"');run('switchTab("educacao")');run('kwQuery="MegaEdu";switchTab("liderancas")');assert.equal(run('kwQuery'),'');assert.equal(count(),15);
run('setMobileFiltersOpen(true)');assert(document.getElementById('programs-app').classList.contains('mobile-filters-open'));document.getElementById('mobile-filter-results').click();assert.equal(document.getElementById('mobile-filter-toggle').getAttribute('aria-expanded'),'false');assert.equal(count(),15);
const row={'Organização':'Instituto Trajetórias','Programa':'Programa de teste','Segmento':'Liderança','Níveis':'Pós-graduação','Especialidades':'','Público Atendido':'Estudantes.','Esfera de governo':'Nacional','Descrição':'Texto original <strong>preservado</strong>.','Estratégias do mapa de atuação':'Lideranças > Pipeline > Outras teses fora da gestão pública > Formação','Momento da política pública / Fase da liderança':'Pipeline; Em exercício','Tipo de estratégia / Tese de atuação':'Outras teses fora da gestão pública','Público-alvo':'Público original','Cliente':'Cliente original','Área interlocutora':'Área original','Momento da política pública':'Implementação'};
ctx.qualityRows=[row];const parsed=run('rowsToDimensions(qualityRows)');ctx.qualityDims=parsed.dims;const clean=run('validateSnapshot({dims:qualityDims,ext:{},colors:{},extra:{}})');assert.equal(clean.dims.traj['Programa de teste'].desc,row.Descrição);assert.equal(clean.dims.traj['Programa de teste'].cliente,row.Cliente);assert.deepEqual(Array.from(clean.dims.traj['Programa de teste'].etapas),['Pipeline','Em exercício']);
run('DIMENSIONS=qualityDims;reloadProgramsData()');document.getElementById('programs-reset').click();choose('etapa','Em exercício');assert.equal(count(),1);assert(document.getElementById('programs-grid').innerHTML.includes('Cliente original'));assert(document.getElementById('programs-grid').innerHTML.includes('Área original'));
const before=run('JSON.stringify(DIMENSIONS)');const diff=run('previewChanges({dims:{}},{dims:DIMENSIONS})');assert.equal(diff.added.length,1);assert.equal(diff.removed.length,0);assert.equal(run('JSON.stringify(DIMENSIONS)'),before);
(async()=>{
 const failed=vm.createContext({...ctx,AbortSignal,Response,location:{protocol:'https:'},fetch:async()=>Response.json({error:'Fonte indisponível'},{status:503})});
 vm.runInContext(js,failed);await vm.runInContext('loadSharedData()',failed);assert.equal(vm.runInContext('sharedReady',failed),false);assert(document.getElementById('programs-grid').innerHTML.includes('Não foi possível carregar os dados publicados'));assert(!document.getElementById('programs-grid').innerHTML.includes('PARC'));
 console.log('PASS — combinações, públicos, ordem de Geral, troca de abas, painel móvel, campos declarados, prévia e falha de carga.');
})().catch(error=>{console.error(error);process.exitCode=1;});
`;
const m=new Module(filename,module);m.filename=filename;m.paths=module.paths;m._compile(prefix+checks,filename);
