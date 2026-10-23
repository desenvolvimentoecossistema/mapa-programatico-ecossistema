const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const SHEETS_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SHEETS_EXTERNAL_TAB = 'Além do mapa programático';
function sheetsConfigured(env) {
  return /^[A-Za-z0-9_-]{20,150}$/.test(env.GOOGLE_SHEETS_ID || '') && !!env.GOOGLE_SHEETS_SERVICE_ACCOUNT;
}
function sheetsError(message, status = 502) { return Object.assign(new Error(message), { status }); }
async function sheetsJson(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw sheetsError('O Google Sheets não retornou os dados.');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw sheetsError('A resposta do Google Sheets excede o tamanho permitido.'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error.status) throw error;
    throw sheetsError('Não foi possível interpretar a resposta do Google Sheets.');
  } finally { reader.releaseLock(); }
}
async function sheetsRequest(url, options, fetcher, limit = 8 * 1024 * 1024) {
  let response;
  try { response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) }); }
  catch { throw sheetsError('Não foi possível acessar o Google Sheets. Tente novamente mais tarde.'); }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status >= 300 && response.status < 400) throw sheetsError('O Google retornou um redirecionamento inesperado. A consulta foi interrompida.', 503);
    if ([401,403].includes(response.status)) throw sheetsError('O acesso à planilha foi recusado. Confira a permissão de leitura da conta de serviço e a ativação da API Google Sheets.', 503);
    if (response.status === 404) throw sheetsError('A planilha configurada não foi encontrada ou não está compartilhada com a conta de serviço.', 503);
    if (response.status === 429) throw sheetsError('O Google Sheets atingiu o limite de consultas. Aguarde um pouco antes de tentar novamente.', 429);
    throw sheetsError('O Google Sheets está indisponível ou a configuração precisa ser revisada.', 503);
  }
  return sheetsJson(response, limit);
}
async function sheetsAccessToken(env, fetcher) {
  let account, key;
  try {
    account = JSON.parse(env.GOOGLE_SHEETS_SERVICE_ACCOUNT);
    if (account.type !== 'service_account' || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(account.client_email)) throw Error();
    const pem = account.private_key;
    if (typeof pem !== 'string' || !pem.startsWith('-----BEGIN PRIVATE KEY-----')) throw Error();
    const bytes = Uint8Array.from(atob(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'')), c => c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch { throw sheetsError('A credencial de leitura do Google Sheets precisa ser configurada no servidor.', 503); }
  const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const json64 = value => encode(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now()/1000);
  const input = json64({ alg: 'RS256', typ: 'JWT' }) + '.' + json64({ iss: account.client_email, scope: SHEETS_SCOPE, aud: SHEETS_TOKEN_URL, iat: now, exp: now+600 });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const result = await sheetsRequest(SHEETS_TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: input+'.'+encode(new Uint8Array(signature)) }) }, fetcher, 65536);
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 8192) throw sheetsError('O Google não forneceu uma autorização de leitura válida.', 503);
  return result.access_token;
}
function sheetsCellHtml(cell, value) {
  const escape = text => text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const runs = cell.textFormatRuns || [];
  const baseBold = cell.effectiveFormat?.textFormat?.bold === true;
  const points = new Map([[0,baseBold]]);
  for (const run of runs) {
    const start = run.startIndex === undefined ? 0 : run.startIndex;
    if (!Number.isInteger(start) || start < 0 || start > value.length) throw sheetsError('A formatação de uma célula da planilha é inválida.');
    points.set(start, typeof run.format?.bold === 'boolean' ? run.format.bold : baseBold);
  }
  const starts = [...points.keys()].sort((a,b)=>a-b);
  return starts.map((start,index) => { const part=escape(value.slice(start,starts[index+1]??value.length)); return points.get(start) && part ? '<strong>'+part+'</strong>' : part; }).join('');
}
function sheetsWorkbook(data) {
  const workbook = { SheetNames: [], Sheets: Object.create(null) };
  const columnName = index => { let name=''; for(let n=index+1;n;n=Math.floor((n-1)/26))name=String.fromCharCode(65+(n-1)%26)+name;return name; };
  for (const tab of data.sheets || []) {
    const name=tab.properties?.title;
    if (!['Programas',SHEETS_EXTERNAL_TAB].includes(name)) continue;
    const sheet=Object.create(null); let maxRow=-1,maxCol=-1;
    for(const grid of tab.data || []) for(const [rowIndex,row] of (grid.rowData || []).entries()) for(const [columnIndex,cell] of (row.values || []).entries()) {
      const value=String(cell.formattedValue ?? ''); if (!value.trim()) continue;
      const r=(grid.startRow||0)+rowIndex,c=(grid.startColumn||0)+columnIndex;
      if(r>5000||c>31||value.length>100000)throw sheetsError('A aba '+name+' excede o limite de 5.000 linhas de dados ou 32 colunas, ou contém uma célula muito longa.');
      sheet[columnName(c)+(r+1)]={v:value,h:sheetsCellHtml(cell,value)};
      maxRow=Math.max(maxRow,r);maxCol=Math.max(maxCol,c);
    }
    if(maxRow>=0)sheet['!ref']='A1:'+columnName(maxCol)+(maxRow+1);
    workbook.SheetNames.push(name);workbook.Sheets[name]=sheet;
  }
  if(!workbook.Sheets.Programas)throw sheetsError('A planilha precisa ter uma aba chamada Programas.',422);
  return workbook;
}
async function readGoogleSheets(env, fetcher = fetch) {
  if(!sheetsConfigured(env))throw sheetsError('A fonte do Google Sheets ainda não foi configurada. Os dados publicados foram preservados.',503);
  const token=await sheetsAccessToken(env,fetcher);
  const base='https://sheets.googleapis.com/v4/spreadsheets/'+env.GOOGLE_SHEETS_ID;
  const options={headers:{authorization:'Bearer '+token}};
  const metadata=await sheetsRequest(base+'?fields=properties(title),sheets(properties(title,gridProperties(rowCount,columnCount)))',options,fetcher,65536);
  const titles=(metadata.sheets||[]).map(sheet=>sheet.properties?.title);
  if(!titles.includes('Programas'))throw sheetsError('A planilha precisa ter uma aba chamada Programas.',422);
  const query=new URLSearchParams({fields:'sheets(properties(title),data(startRow,startColumn,rowData(values(formattedValue,effectiveFormat(textFormat(bold)),textFormatRuns(startIndex,format(bold))))))'});
  for(const title of ['Programas',SHEETS_EXTERNAL_TAB].filter(t=>titles.includes(t))){
    const grid=metadata.sheets.find(sheet=>sheet.properties?.title===title).properties.gridProperties;
    if(!Number.isInteger(grid?.rowCount)||!Number.isInteger(grid?.columnCount)||grid.rowCount<1||grid.columnCount<1)throw sheetsError('Não foi possível verificar os limites da aba '+title+'.');
    const columns=Math.min(grid.columnCount,33),lastColumn=columns<=26?String.fromCharCode(64+columns):'A'+String.fromCharCode(64+columns-26);
    query.append('ranges',"'"+title+"'!A1:"+lastColumn+Math.min(grid.rowCount,5002));
  }
  const data=await sheetsRequest(base+'?'+query,options,fetcher);
  return {title:String(metadata.properties?.title||'Fonte do mapa'),url:'https://docs.google.com/spreadsheets/d/'+env.GOOGLE_SHEETS_ID+'/edit',workbook:sheetsWorkbook(data),readAt:new Date().toISOString()};
}
