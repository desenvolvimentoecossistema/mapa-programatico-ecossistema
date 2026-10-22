/* Local reader for the XLSX template. No macros, formulas or external links execute. */
(() => {
  'use strict';
  const MAX_XML = 16 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024;
  const decode = new TextDecoder('utf-8', {fatal:true});
  const escape = value => String(value).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  function entities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(all,key)=>{
      const named={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
      if(Object.hasOwn(named,key))return named[key];
      const n=key.startsWith('#x')?parseInt(key.slice(2),16):Number(key.slice(1));
      if(!Number.isInteger(n)||n<0||n>0x10ffff||(n>=0xd800&&n<=0xdfff))throw Error('Caractere XML inválido.');
      return String.fromCodePoint(n);
    });
  }
  function xml(source) {
    if(/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('A planilha contém uma declaração XML não permitida.');
    const root={name:'root',attrs:{},items:[]}, stack=[root];
    let i=0,nodes=0;
    while(i<source.length){
      if(source[i]!=='<'){
        let end=source.indexOf('<',i);if(end<0)end=source.length;
        stack.at(-1).items.push(entities(source.slice(i,end)));i=end;continue;
      }
      const special=source.startsWith('<!--',i)?['--> ',4]:source.startsWith('<?',i)?['?>',2]:source.startsWith('<![CDATA[',i)?[']]>',9]:null;
      if(special){
        const terminator=special[0].trim(),end=source.indexOf(terminator,i+special[1]);
        if(end<0)throw Error('XML incompleto.');
        if(special[1]===9)stack.at(-1).items.push(source.slice(i+9,end));
        i=end+terminator.length;continue;
      }
      let end=i+1,quote='';
      for(;end<source.length;end++){
        const c=source[end];
        if(quote){if(c===quote)quote='';}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;
      }
      if(end===source.length)throw Error('Tag XML incompleta.');
      const token=source.slice(i+1,end).trim();i=end+1;
      if(token.startsWith('/')){
        const name=token.slice(1).trim().split(':').at(-1);
        if(stack.length<2||stack.at(-1).name!==name)throw Error('Estrutura XML inválida.');
        stack.pop();continue;
      }
      const match=token.match(/^([\w:.-]+)/);
      if(!match||++nodes>250000||stack.length>128)throw Error('Estrutura XML excede o limite permitido.');
      const attrs=Object.create(null);
      for(const a of token.slice(match[0].length).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))attrs[a[1]]=entities(a[2]??a[3]);
      const node={name:match[1].split(':').at(-1),attrs,items:[]};
      stack.at(-1).items.push(node);
      if(!token.endsWith('/'))stack.push(node);
    }
    if(stack.length!==1)throw Error('XML incompleto.');
    return root;
  }
  const children=(node,name)=>node.items.filter(x=>typeof x!=='string'&&(!name||x.name===name));
  const child=(node,name)=>children(node,name)[0];
  const text=node=>node?node.items.map(x=>typeof x==='string'?x:text(x)).join(''):'';
  const documentElement=(document,name)=>child(document,name);
  function path(base,target) {
    const parts=(target.startsWith('/')?target.slice(1):base+target).split('/'),out=[];
    for(const part of parts){if(!part||part==='.')continue;if(part==='..'){if(!out.length)throw Error('Caminho inválido na planilha.');out.pop();}else out.push(part);}
    return out.join('/');
  }
  const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
  function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=crcTable[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
  async function zip(bytes) {
    const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    const u16=i=>view.getUint16(i,true),u32=i=>view.getUint32(i,true);
    let eocd=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(u32(i)===0x06054b50&&i+22+u16(i+20)===bytes.length){eocd=i;break;}
    if(eocd<0||u16(eocd+4)||u16(eocd+6))throw Error('O arquivo não é um XLSX válido.');
    const count=u16(eocd+10),offset=u32(eocd+16),entries=Object.create(null);
    if(count>512||offset>=eocd)throw Error('A planilha contém arquivos demais ou usa ZIP64.');
    let cursor=offset,total=0;
    for(let n=0;n<count;n++){
      if(cursor+46>eocd||u32(cursor)!==0x02014b50)throw Error('Índice ZIP inválido.');
      const flags=u16(cursor+8),method=u16(cursor+10),crc=u32(cursor+16),compressed=u32(cursor+20),size=u32(cursor+24);
      const length=u16(cursor+28),extra=u16(cursor+30),comment=u16(cursor+32),local=u32(cursor+42);
      if(cursor+46+length+extra+comment>eocd||flags&1||![0,8].includes(method)||size>MAX_XML||compressed>bytes.length||local+30>offset)throw Error('Formato ou tamanho de planilha não permitido.');
      const name=decode.decode(bytes.subarray(cursor+46,cursor+46+length));
      if(Object.hasOwn(entries,name))throw Error('A planilha contém arquivos duplicados.');
      entries[name]={local,size,compressed,method,crc};total+=size;cursor+=46+length+extra+comment;
    }
    if(total>MAX_TOTAL)throw Error('A planilha descompactada excede 32 MB.');
    const cache=new Map();
    return async name=>{
      if(cache.has(name))return cache.get(name);
      const e=entries[name];if(!e)throw Error('Arquivo interno ausente: '+name);
      if(u32(e.local)!==0x04034b50)throw Error('Conteúdo ZIP inválido.');
      const start=e.local+30+u16(e.local+26)+u16(e.local+28);
      if(start+e.compressed>offset)throw Error('Conteúdo ZIP incompleto.');
      let result=bytes.subarray(start,start+e.compressed);
      if(e.method===8){
        let stream;
        try{stream=new DecompressionStream('deflate-raw');}catch(_){throw Error('Atualize o navegador para ler planilhas XLSX neste dispositivo.');}
        const reader=new Blob([result]).stream().pipeThrough(stream).getReader(),chunks=[];
        let length=0;
        while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>e.size||length>MAX_XML){await reader.cancel();throw Error('Tamanho de arquivo interno inválido.');}chunks.push(value);}
        result=new Uint8Array(length);let p=0;for(const chunk of chunks){result.set(chunk,p);p+=chunk.length;}
      }
      if(result.length!==e.size||crc32(result)!==e.crc)throw Error('A planilha está corrompida.');
      const document=xml(decode.decode(result));cache.set(name,document);return document;
    };
  }
  function encodeCell({r,c}){let n=c+1,label='';while(n){n--;label=String.fromCharCode(65+n%26)+label;n=Math.floor(n/26);}return label+(r+1);}
  function decodeCell(address){const m=String(address).match(/^([A-Z]{1,3})([1-9]\d*)$/);if(!m)throw Error('Endereço de célula inválido.');let c=0;for(const ch of m[1])c=c*26+ch.charCodeAt(0)-64;return {r:Number(m[2])-1,c:c-1};}
  function decodeRange(ref){const [s,e=s]=String(ref).split(':');return {s:decodeCell(s),e:decodeCell(e)};}
  function sheetToJson(sheet,options={}){
    if(!sheet['!ref'])return [];
    const range=decodeRange(sheet['!ref']),rows=[];
    if(range.e.r-range.s.r>5000||range.e.c-range.s.c>31)throw Error('A aba excede 5.000 linhas ou 32 colunas.');
    for(let r=range.s.r;r<=range.e.r;r++){const row=[];for(let c=range.s.c;c<=range.e.c;c++)row.push(sheet[encodeCell({r,c})]?.v??'');if(options.blankrows!==false||row.some(v=>String(v).trim()))rows.push(row);}
    if(options.header===1)return rows;
    const headers=rows.shift()||[];
    return rows.filter(row=>row.some(v=>String(v).trim())).map(row=>Object.fromEntries(headers.map((h,i)=>[String(h),row[i]??options.defval??'']).filter(([h])=>h)));
  }
  function rich(node,bold=false){
    if(!node)return {v:'',h:''};
    const runs=children(node,'r');
    if(!runs.length){const v=children(node,'t').map(text).join('');return {v,h:bold?'<strong>'+escape(v)+'</strong>':escape(v)};}
    let v='',h='';
    for(const r of runs){const value=children(r,'t').map(text).join(''),b=child(child(r,'rPr')||{items:[]},'b');const isBold=bold||(b&&!['0','false'].includes(b.attrs.val));v+=value;h+=isBold?'<strong>'+escape(value)+'</strong>':escape(value);}
    return {v,h};
  }
  async function read(input) {
    const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
    if(bytes.length>10*1024*1024||bytes.length<22)throw Error('Tamanho de planilha inválido.');
    const load=await zip(bytes),rootRels=documentElement(await load('_rels/.rels'),'Relationships');
    const office=children(rootRels,'Relationship').find(r=>r.attrs.Type?.endsWith('/officeDocument')&&r.attrs.TargetMode!=='External');
    if(!office)throw Error('Arquivo de pasta de trabalho ausente.');
    const workbookPath=path('',office.attrs.Target),base=workbookPath.slice(0,workbookPath.lastIndexOf('/')+1),filename=workbookPath.split('/').at(-1);
    const workbook=documentElement(await load(workbookPath),'workbook');
    const relationships=children(documentElement(await load(base+'_rels/'+filename+'.rels'),'Relationships'),'Relationship').filter(r=>r.attrs.TargetMode!=='External');
    const related=type=>relationships.find(r=>r.attrs.Type?.endsWith('/'+type));
    let shared=[],fonts=[],styles=[];
    if(related('sharedStrings'))shared=children(documentElement(await load(path(base,related('sharedStrings').attrs.Target)),'sst'),'si').map(n=>rich(n));
    if(related('styles')){
      const style=documentElement(await load(path(base,related('styles').attrs.Target)),'styleSheet');
      fonts=children(child(style,'fonts')||{items:[]},'font').map(f=>{const b=child(f,'b');return !!b&&!['0','false'].includes(b.attrs.val);});
      styles=children(child(style,'cellXfs')||{items:[]},'xf').map(x=>fonts[Number(x.attrs.fontId)]||false);
    }
    const Sheets=Object.create(null),SheetNames=[];
    for(const sheet of children(child(workbook,'sheets'),'sheet')){
      const id=Object.entries(sheet.attrs).find(([k])=>k.endsWith(':id'))?.[1];
      const relation=relationships.find(r=>r.attrs.Id===id&&r.attrs.Type?.endsWith('/worksheet'));
      if(!relation)continue;
      const name=sheet.attrs.name;if(Object.hasOwn(Sheets,name))throw Error('Nome de aba duplicado.');
      const worksheet=documentElement(await load(path(base,relation.attrs.Target)),'worksheet'),out=Object.create(null);
      let minR=Infinity,minC=Infinity,maxR=-1,maxC=-1,cellCount=0;
      for(const row of children(child(worksheet,'sheetData')||{items:[]},'row'))for(const cell of children(row,'c')){
        const address=cell.attrs.r,position=decodeCell(address);
        if(++cellCount>160000||position.r>=5001||position.c>=32)throw Error('A planilha excede 5.000 linhas ou 32 colunas.');
        if(Object.hasOwn(out,address))throw Error('Célula duplicada na planilha.');
        const type=cell.attrs.t,bold=styles[Number(cell.attrs.s)]||false,raw=text(child(cell,'v'));
        let value;
        if(type==='s'){value=shared[Number(raw)];if(!value)throw Error('Texto compartilhado inválido.');if(bold)value={v:value.v,h:'<strong>'+value.h+'</strong>'};}
        else if(type==='inlineStr')value=rich(child(cell,'is'),bold);
        else value={v:raw,h:bold?'<strong>'+escape(raw)+'</strong>':escape(raw)};
        out[address]={...value,t:'s'};
        minR=Math.min(minR,position.r);minC=Math.min(minC,position.c);maxR=Math.max(maxR,position.r);maxC=Math.max(maxC,position.c);
      }
      if(maxR>=0)out['!ref']=encodeCell({r:minR,c:minC})+':'+encodeCell({r:maxR,c:maxC});
      Sheets[name]=out;SheetNames.push(name);
    }
    return {Sheets,SheetNames};
  }
  globalThis.NativeXLSX={version:'local-xlsx',read,utils:{decode_range:decodeRange,encode_cell:encodeCell,sheet_to_json:sheetToJson}};
})();
