import {readFile,writeFile,mkdir} from 'node:fs/promises';

import vm from 'node:vm';

import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));

let page=await readFile(root+'site/index.html','utf8');

const reader=await readFile(root+'site/xlsx-reader.js','utf8');

const block='<script id="xlsx-native-reader">\n'+reader+'\n</script>';

if(page.includes('<script id="xlsx-native-reader">'))page=page.replace(/<script id="xlsx-native-reader">[\s\S]*?<\/script>/,block);

else page=page.replace('<script>',block+'\n<script>');

await writeFile(root+'site/index.html',page);

const scripts=[...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];

const application=scripts.at(-1)[1];

const context=vm.createContext({});

vm.runInContext(application.slice(0,application.indexOf('let activeTab'))+'\nglobalThis.model={ORGS,STRAT_CATALOG,DIMENSIONS,MAP_EXT,EXT_COLORS,MAP_ORGS_EXTRA};',context);

const model=context.model;

const snapshot={dims:model.DIMENSIONS,ext:model.MAP_EXT,colors:model.EXT_COLORS,extra:model.MAP_ORGS_EXTRA};

const validator=application.slice(application.indexOf('function validateSnapshot('),application.indexOf('function applySnapshot('));

const handler=await readFile(root+'server/handler.js','utf8');

const authentication=await readFile(root+'server/google-auth.js','utf8');

const ssoCore=await readFile(root+'server/sso-core.js','utf8');

const sso=await readFile(root+'server/sso.js','utf8');

const verifier=await readFile(root+'server/google-token.js','utf8');

const sheets=await readFile(root+'server/google-sheets.js','utf8');

const login=await readFile(root+'site/login.html','utf8');

const lines=[

  '// Generated from site/index.html and server/handler.js by scripts/prepare-worker.mjs.',

  'const PAGE='+JSON.stringify(page)+';',

  'const ORGS='+JSON.stringify(model.ORGS)+';',

  'const STRAT_CATALOG='+JSON.stringify(model.STRAT_CATALOG)+';',

  "const segList=d=>String(d.segmento_categoria||'').split(';').map(x=>x.trim()).filter(Boolean);",

  'const INITIAL_SNAPSHOT='+JSON.stringify(snapshot)+';',

  'const MAP_EXT=INITIAL_SNAPSHOT.ext, EXT_COLORS=INITIAL_SNAPSHOT.colors, MAP_ORGS_EXTRA=INITIAL_SNAPSHOT.extra;',

  'const LOGIN_PAGE='+JSON.stringify(login)+';',

  validator,verifier,authentication,ssoCore,sso,sheets,handler

];

await mkdir(root+'dist',{recursive:true});

await writeFile(root+'dist/app.mjs',lines.join('\n'));

console.log('Prepared self-contained page, reader, schema and servidor.');

