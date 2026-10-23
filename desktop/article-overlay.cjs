/** Runs in an isolated world. Chinese normally changes original Text.data.
 * Legacy merged footnotes use a reversible inline substitution in the same
 * paragraph, moving the original links/math/citations rather than cloning them.
 */
function installArticleOverlay(payload){
  const existing=globalThis.__paperArchiveArticle;
  if(existing){existing.configure(payload);return existing.state();}
  const normalize=text=>(text||'').replace(/&nbsp;?/g,' ').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const ignored='script,style,noscript,svg,canvas,iframe,video,audio,input,select,textarea,output,.pa-translation,.katex-html,.MathJax_Preview';
  const mathSelector='.katex,mjx-container,.MathJax,math,d-math';
  const mutations=new WeakMap();
  const substitutions=new WeakMap();
  const originalText=node=>{const patch=mutations.get(node);return patch&&node.data===patch.current?patch.original:node.data;};
  const mathKey=node=>node.getAttribute('data-pa-tex')||node.getAttribute('data-tex')||node.getAttribute('alttext')||node.querySelector('annotation[encoding="application/x-tex"]')?.textContent||(node.tagName==='D-MATH'?node.textContent:null)||'UNKNOWN '+node.textContent;
  function read(node){
    const substitution=substitutions.get(node);if(substitution?.active&&substitutionIntact(substitution))return substitution.original;
    if(node.nodeType===3)return originalText(node);
    if(node.nodeType===1){
      if(node.matches(ignored))return '';
      if(node.matches(mathSelector))return ' MATH '+mathKey(node)+' END ';
      // The archive extracts Distill's custom citations and footnotes before
      // their scripts hydrate. Match that same source, rather than a widget's
      // visible reference number or an unmarked concatenation of the note.
      if(node.tagName==='D-CITE'&&node.getAttribute('key'))return ' ['+node.getAttribute('key')+'] ';
      if(node.tagName==='D-FOOTNOTE')return '（注：'+[...node.childNodes].map(read).join('')+'）';
      if(node.tagName==='A'&&href(node).startsWith('#'))return [...node.childNodes].map(read).join('').replace(/^(\s*§\s*)(?:\d+(?:\.\d+)*\s*|[A-Z](?:\.\d+)*[.\s]+)/,'$1');
      if(node.tagName==='BR')return ' ';
    }
    return [...node.childNodes].map(read).join('');
  }
  const parse=html=>{const t=document.createElement('template');t.innerHTML=html||'';return t.content;};
  const style=document.createElement('style');style.textContent=`
    .pa-translation{border-inline-start:2px solid #9996;padding-inline-start:16px;margin-block:12px 24px;opacity:.88}
    .pa-translation>:first-child{margin-top:0}.pa-translation>:last-child{margin-bottom:0}
    .pa-translation .katex-display{overflow-x:auto;overflow-y:hidden}
    ::highlight(pa-annotations){background:#d7d2a5;color:inherit}::highlight(pa-search){background:#dfc98a;color:inherit}
  `;document.head.append(style);
  let config=payload,models=[],records=new Map(),mirrors=[],timer,observer,destroyed=false,query='',matches=[],match=-1;
  const repairedShadows=new Set();
  function repairShadows(){
    // Old Chromium MHTML omits constructable stylesheets in custom elements.
    // Repair only unstyled saved components; live author styles take priority.
    const visit=scope=>{for(const host of scope.querySelectorAll('d-cite,d-footnote,d-hover-box')){const shadow=host.shadowRoot;if(!shadow)continue;
      if(!shadow.styleSheets.length&&!shadow.adoptedStyleSheets.length&&/^(D-CITE|D-FOOTNOTE|D-HOVER-BOX)$/.test(host.tagName)){
        const css=document.createElement('style');
        css.textContent=host.tagName==='D-HOVER-BOX'?'.container{background:Canvas;color:CanvasText;border:1px solid #8885;padding:16px;box-shadow:0 5px 20px #0002}':':host{display:inline}.citation{display:inline}sup,.citation-number{font-size:.8em;vertical-align:super}d-hover-box{display:none}:host(:hover) d-hover-box{display:block;position:absolute;z-index:100;max-width:min(600px,85vw);font-size:16px;line-height:1.6}';
        shadow.append(css);repairedShadows.add(css);
      }visit(shadow);
    }};visit(document);
  }
  const root=()=>document.querySelector('d-article,article,main,[role=main]')||document.body;
  function prepare(){
    models=config.blocks.map(b=>{
      const translated=parse(b.html),key=normalize(b.source),text=read(translated);
      return {...b,key,translatedDOM:translated,text,eligible:!!b.translated&&!b.code&&!b.dynamic&&!!normalize(text)&&normalize(text)!==key};
    });
  }
  function href(node){
    const raw=node.getAttribute('href')||'';
    try{const base=new URL(config.baseURL||document.baseURI),url=new URL(raw,base);return url.origin===base.origin&&url.pathname===base.pathname&&url.search===base.search?url.hash:url.href;}catch{return raw;}
  }
  function units(target,styles,skipLinks=new Set()){
    const list=[{nodes:[],text:''}];
    function visit(node,isRoot=false){
      if(node.nodeType===3){list[list.length-1].nodes.push(node);list[list.length-1].text+=originalText(node);return;}
      if(node.nodeType!==1&&node.nodeType!==11)return;
      if(node.nodeType===1){
        if(node.matches(ignored))return;
        let key='';
        if(node.matches(mathSelector))key='math:'+mathKey(node).replace(/\s+/g,'');
        else if(node.tagName==='D-CITE'&&node.getAttribute('key'))key=skipLinks.has('cite:'+node.getAttribute('key'))?'':'cite:'+node.getAttribute('key');
        else if(!isRoot&&node.tagName==='D-FOOTNOTE')key=skipLinks.has('note')?'':'note';
        else if(node.tagName==='CODE')key=skipLinks.has('code:'+node.textContent)?'':'code:'+node.textContent;
        else if(!isRoot&&node.tagName==='A'&&read(node).trim())key=skipLinks.has('link:'+href(node))?'':'link:'+href(node);
        else if(styles&&!isRoot&&/^(EM|I|STRONG|B)$/.test(node.tagName))key=/^(EM|I)$/.test(node.tagName)?'em':'strong';
        if(key){list.push({node,key});list.push({nodes:[],text:''});return;}
      }
      for(const child of node.childNodes)visit(child);
    }
    visit(target,true);return list;
  }
  function wrapText(root,start,end,tag,key=''){
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),nodes=[];let offset=0;
    while(walker.nextNode()){const node=walker.currentNode;nodes.push({node,start:offset});offset+=node.length;}
    const a=nodes.find(n=>n.start+n.node.length>start),b=nodes.find(n=>n.start+n.node.length>=end);if(!a||!b)return;
    const range=new Range();range.setStart(a.node,start-a.start);range.setEnd(b.node,end-b.start);const content=range.extractContents(),el=document.createElement(tag);
    if(tag==='d-cite')el.setAttribute('key',key);
    else{
      const texts=[],w=document.createTreeWalker(content,NodeFilter.SHOW_TEXT);while(w.nextNode())texts.push(w.currentNode);
      let left=3;for(const node of texts){const cut=Math.min(left,node.length);node.data=node.data.slice(cut);left-=cut;if(!left)break;}
      for(const node of texts.reverse())if(node.length){node.data=node.data.slice(0,-1);break;}
      el.append(content);
    }
    range.insertNode(el);
  }
  function textPlan(target,translated,allowStyles=true){
    // A Markdown paragraph around a standalone link is not a second link in
    // the author's DOM. Compare equivalent roots, retaining the author's node.
    while(translated.children?.length===1&&normalize(read(translated))===normalize(read(translated.firstElementChild))){
      const child=translated.firstElementChild;
      if(child.tagName===target.tagName||/^(P|H[1-6])$/.test(child.tagName)){translated=child;if(child.tagName===target.tagName)break;}
      else break;
    }
    if(target.tagName==='A'&&translated.tagName!=='A'&&translated.children?.length===1&&translated.firstElementChild.tagName==='A'&&normalize(read(translated))===normalize(read(translated.firstElementChild)))translated=translated.firstElementChild;
    if(target.tagName==='A'&&translated.tagName==='A'&&href(target)!==href(translated))return null;
    // Lists and tables have semantic boundaries. Never apportion a whole list's
    // Chinese by English character count: that moves sentences between items.
    if(/^(UL|OL)$/.test(target.tagName)&&/^(UL|OL)$/.test(translated.tagName)){
      const left=[...target.children].filter(n=>n.tagName==='LI'),right=[...translated.children].filter(n=>n.tagName==='LI');
      if(left.length!==right.length)return null;
      const plans=left.map((n,i)=>textPlan(n,right[i],allowStyles));if(!plans.every(Boolean))return null;const patches=plans.flat();patches.substitutions=plans.flatMap(p=>p.substitutions||[]);return patches;
    }
    if(target.tagName==='TABLE'&&translated.tagName==='TABLE'){
      const rows=node=>[...node.rows].filter(r=>normalize(read(r)));
      const left=rows(target),right=rows(translated);if(left.length!==right.length)return null;
      const plans=[];for(let i=0;i<left.length;i++){if(left[i].cells.length!==right[i].cells.length)return null;for(let j=0;j<left[i].cells.length;j++){const plan=textPlan(left[i].cells[j],right[i].cells[j],allowStyles);if(!plan)return null;plans.push(plan);}}const patches=plans.flat();patches.substitutions=plans.flatMap(p=>p.substitutions||[]);return patches;
    }
    // Align the original widgets with their positions in the translated prose,
    // rather than cutting Chinese words at the English citation positions.
    const citations=[...target.querySelectorAll?.('d-cite[key]')||[]];
    const notes=[...target.querySelectorAll?.('d-footnote')||[]];
    if(citations.length||notes.length){
      translated=translated.cloneNode(true);
      for(const cite of citations){const label='['+cite.getAttribute('key')+']',start=translated.textContent.indexOf(label);if(start>=0)wrapText(translated,start,start+label.length,'d-cite',cite.getAttribute('key'));}
      const text=translated.textContent,ranges=[];let start=0;
      while((start=text.indexOf('（注：',start))!==-1){let depth=1,end=start+3;for(;end<text.length&&depth;end++){if(text[end]==='（')depth++;if(text[end]==='）')depth--;}if(depth)break;ranges.push([start,end]);start=end;}
      for(const [a,b] of ranges.reverse())wrapText(translated,a,b,'d-footnote');
    }
    const skipWidgets=new Set();
    const translatedCitations=new Set([...translated.querySelectorAll?.('d-cite[key]')||[]].map(n=>'cite:'+n.getAttribute('key')));
    if(citations.length&&!translatedCitations.size&&!notes.length&&units(target,false).filter(u=>u.key).every(u=>u.key.startsWith('cite:'))){
      for(const cite of citations){const marker=document.createElement('d-cite');marker.setAttribute('key',cite.getAttribute('key'));translated.append(marker);translatedCitations.add('cite:'+cite.getAttribute('key'));}
    }
    for(const cite of citations)if(!translatedCitations.has('cite:'+cite.getAttribute('key')))skipWidgets.add('cite:'+cite.getAttribute('key'));
    if(notes.length!==translated.querySelectorAll?.('d-footnote').length)skipWidgets.add('note');
    let left=units(target,allowStyles,skipWidgets),right=units(translated,allowStyles);
    // Markdown autolinks bare email/URL text that was never a link in the
    // author's DOM. Keep that DOM as text instead of inventing a new element.
    const atomKey=key=>key.startsWith('code:')?'code:'+key.slice(5).trim():key;
    const originalLinks=new Set(left.filter(u=>u.key).map(u=>atomKey(u.key))),original=read(target),bareURLs=original.match(/https?:\/\/[^\s"“”'‘’<>()]+/g)||[];
    const skipLinks=new Set(right.filter(u=>(u.key?.startsWith('link:')||u.key?.startsWith('code:'))&&!originalLinks.has(atomKey(u.key))&&(original.includes(read(u.node))||u.key.startsWith('link:')&&bareURLs.some(url=>read(u.node).startsWith(url)))).map(u=>u.key));
    if(skipLinks.size)right=units(translated,allowStyles,skipLinks);
    const keys=list=>list.filter(u=>u.key).map(u=>atomKey(u.key)).join('\0');
    if(keys(left)!==keys(right)){if(allowStyles)return textPlan(target,translated,false);return null;}
    const patches=[];
    for(let i=0;i<left.length;i++){
      const a=left[i],b=right[i];
      if(a.key){
        if(a.key.startsWith('math:')||a.key.startsWith('code:')||a.key.startsWith('cite:'))continue;
        const nested=textPlan(a.node,b.node,allowStyles);if(!nested){if(allowStyles)return textPlan(target,translated,false);return null;}patches.push(...nested);continue;
      }
      const text=b.text;
      if(!a.nodes.length){
        if(text.trim()){
          if(i>0&&left[i-1].node?.parentNode)patches.push({node:null,after:left[i-1].node,original:'',chinese:text,current:''});
          else if(left[i+1]?.node?.parentNode)patches.push({node:null,before:left[i+1].node,original:'',chinese:text,current:''});
          else{if(allowStyles)return textPlan(target,translated,false);return null;}
        }continue;
      }
      const active=a.nodes.filter(n=>originalText(n).trim()),nodes=active.length?active:a.nodes;
      const chars=Array.from(text),weight=nodes.reduce((n,node)=>n+Math.max(1,originalText(node).trim().length),0);
      let consumed=0,offset=0;
      for(const node of a.nodes){
        const before=originalText(node);let chinese='';
        if(nodes.includes(node)){consumed+=Math.max(1,before.trim().length);const end=node===nodes[nodes.length-1]?chars.length:Math.round(chars.length*consumed/weight);chinese=chars.slice(offset,end).join('');offset=end;}
        patches.push({node,original:before,chinese,current:node.data});
      }
    }
    // Old translations sometimes merged a footnote into the prose and lost its
    // delimiter. Never hide an arbitrary slice of Chinese inside that popup.
    // Keep the original paragraph itself and render the complete translation
    // in it, moving the original links/math/citations into their Chinese slots.
    if(notes.length&&skipWidgets.has('note')){
      const unsafe=[...target.querySelectorAll('*')].some(n=>!n.closest(mathSelector)&&(n.matches('input,button,select,textarea,canvas,svg,iframe,video,audio,form,img,object,embed')||n.localName.includes('-')&&!n.matches('d-cite,d-footnote')));
      if(!/^(P|LI|TD|TH|FIGCAPTION|DIV|SPAN)$/.test(target.tagName)||unsafe)return null;
      const a=units(target,false,skipWidgets),b=units(translated,false,skipLinks);
      if(keys(a)!==keys(b))return null;
      patches.substitutions=[{target,translated:translated.cloneNode(true),skipWidgets,skipLinks,original:read(target),active:false}];
    }
    return patches;
  }
  function substitute(item,chinese){
    if(chinese){
      if(item.active)return;
      const content=item.translated.cloneNode(true),left=units(item.target,false,item.skipWidgets).filter(u=>u.key),right=units(content,false,item.skipLinks).filter(u=>u.key);
      const key=value=>value.startsWith('code:')?'code:'+value.slice(5).trim():value;
      if(left.length!==right.length||left.some((a,i)=>key(a.key)!==key(right[i].key)))return;
      item.saved=document.createDocumentFragment();item.saved.append(...item.target.childNodes);item.anchors=[];
      const move=(node,destination)=>{const anchor=document.createComment('');node.replaceWith(anchor);item.anchors.push({anchor,node});destination(node);};
      for(let i=0;i<left.length;i++)move(left[i].node,node=>right[i].node.replaceWith(node));
      // A legacy translation may omit the reference label. Keep its original
      // component at the paragraph end, instead of splitting a Chinese word.
      for(const cite of [...item.saved.querySelectorAll('d-cite')])move(cite,node=>content.append(node));
      item.target.append(...content.childNodes);item.nodes=[...item.target.childNodes];item.atoms=left;item.current=item.target.textContent;
      item.prose=[];const walker=document.createTreeWalker(item.target,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;if(!node.parentElement.closest(mathSelector+',code,a,d-cite'))item.prose.push({node,text:node.data});}
      item.active=true;substitutions.set(item.target,item);
    }else if(item.active){
      const owned=item.nodes.length===item.target.childNodes.length&&item.nodes.every(n=>n.parentNode===item.target)&&item.prose.every(p=>p.node.isConnected&&p.node.data===p.text);
      for(const {anchor,node} of item.anchors)if(anchor.parentNode)anchor.replaceWith(node);
      if(owned)item.target.replaceChildren(...item.saved.childNodes);
      item.active=false;substitutions.delete(item.target);
    }
  }
  function substitutionIntact(item){
    const key=node=>node.matches(mathSelector)?'math:'+mathKey(node).replace(/\s+/g,''):node.tagName==='CODE'?'code:'+node.textContent:node.tagName==='D-CITE'?'cite:'+node.getAttribute('key'):'link:'+href(node);
    return item.current===item.target.textContent&&item.nodes.length===item.target.childNodes.length&&item.nodes.every(n=>n.parentNode===item.target)&&item.atoms.every(a=>a.node.isConnected&&key(a.node)===a.key);
  }
  function apply(patches,chinese){
    for(const p of patches){
      if(p.after||p.before){const anchor=p.after||p.before;if(chinese&&!p.node&&anchor.isConnected){p.node=document.createTextNode('');anchor[p.before?'before':'after'](p.node);}else if(!chinese&&p.node?.data===p.current){p.node.remove();p.node=null;p.current='';}}
      if(!p.node)continue;
      const value=chinese?p.chinese:p.original;if(p.node.data===p.current||p.node.data===p.original){p.node.data=value;p.current=value;mutations.set(p.node,p);}
    }
  }
  function restoreRecord(record){
    for(const item of record.patches.substitutions||[])substitute(item,false);
    apply(record.patches,false);record.companion?.remove();
    if(record.target.nodeType===1){record.target.removeAttribute('data-pa-block');record.target.removeAttribute('data-pa-language');if(record.lang===null)record.target.removeAttribute('lang');else record.target.setAttribute('lang',record.lang);}
  }
  function restore(){
    observer?.disconnect();for(const record of records.values())restoreRecord(record);for(const mirror of mirrors)apply(mirror.patches,false);records.clear();mirrors=[];
  }
  function applyMode(){
    for(const record of records.values()){
      for(const item of record.patches.substitutions||[])substitute(item,false);
      apply(record.patches,config.mode==='chinese');
      if(config.mode==='chinese')for(const item of record.patches.substitutions||[])substitute(item,true);
      if(record.target.nodeType===1){record.target.dataset.paBlock=record.model.index;record.target.dataset.paLanguage=config.mode==='chinese'?'chinese':'original';if(config.mode==='chinese')record.target.lang='zh-CN';else if(record.lang===null)record.target.removeAttribute('lang');else record.target.setAttribute('lang',record.lang);}
      if(config.mode==='bilingual'){
        if(!record.companion){
          const el=record.target.nodeType===1?record.target:null,tag=el&&/^(H[1-6]|P|UL|OL|BLOCKQUOTE|TABLE|LI|FIGCAPTION)$/.test(el.tagName)?el.tagName.toLowerCase():record.target.nodeType===3?'span':'div';
          const companion=document.createElement(tag);companion.className=(el?.className||'')+' pa-translation';companion.dataset.paBlock=record.model.index;companion.dataset.paLanguage='chinese';companion.lang='zh-CN';
          const content=record.model.translatedDOM.cloneNode(true);content.querySelectorAll('img,script,style,iframe,form,input,button,select,textarea,object,embed').forEach(n=>n.remove());
          content.querySelectorAll('*').forEach(n=>{for(const a of [...n.attributes])if(/^on/i.test(a.name)||['src','srcset','id'].includes(a.name))n.removeAttribute(a.name);});
          if(content.children.length===1&&/^(H[1-6]|P)$/.test(content.firstElementChild.tagName)&&/^(H[1-6]|P)$/.test(companion.tagName))companion.append(...content.firstElementChild.childNodes);else companion.append(content);
          record.target.after(companion);record.companion=companion;
        }
      }else{record.companion?.remove();record.companion=null;}
    }
    for(const mirror of mirrors)apply(mirror.patches,config.mode==='chinese');
  }
  function navigation(){
    for(const mirror of mirrors)apply(mirror.patches,false);mirrors=[];
    if(config.title?.chinese&&normalize(config.title.original)!==normalize(config.title.chinese))for(const heading of document.querySelectorAll('d-title h1,header h1,h1')){
      if(normalize(read(heading))!==normalize(config.title.original)||[...records.values()].some(r=>r.target===heading||r.target.contains(heading)))continue;
      const content=document.createDocumentFragment();content.append(document.createTextNode(config.title.chinese));const patches=textPlan(heading,content);if(patches)mirrors.push({patches});
    }
    const headings=[...records.values()].filter(r=>r.target.nodeType===1&&( /^H[1-6]$/.test(r.target.tagName)||r.model.text.trim().length<400));
    for(const link of document.querySelectorAll('a[href*="#"]')){
      if(link.closest('.pa-translation')||[...records.values()].some(r=>r.target===link||r.target.contains(link)))continue;
      const key=normalize(read(link)),options=headings.filter(r=>r.model.key===key),heading=options[0];if(!heading||options.some(r=>r.model.text!==heading.model.text))continue;
      const content=document.createDocumentFragment();content.append(document.createTextNode(heading.model.text.trim()));const patches=textPlan(link,content);if(patches)mirrors.push({patches});
    }
  }
  function scan(){
    if(destroyed)return;observer.disconnect();
    repairShadows();
    for(const [index,record] of records)if(!record.target.isConnected||normalize(read(record.target))!==record.model.key||record.patches.some(p=>p.node&&!p.node.isConnected&&!record.patches.substitutions?.some(s=>s.active&&s.saved.contains(p.node)))||!record.patches.substitutions?.some(s=>s.active)&&units(record.target,false).filter(u=>u.key).map(u=>u.key).join('\0')!==record.structure){
      restoreRecord(record);records.delete(index);
    }
    const distill=[...document.querySelectorAll('d-article,d-appendix')],scopes=distill.length?distill:[root()],keyed=new Map();
    const add=node=>{const key=normalize(read(node));if(key){if(!keyed.has(key))keyed.set(key,[]);keyed.get(key).push(node);}};
    for(const scope of scopes){
      for(const el of scope.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,pre,table,figure,figcaption,li,d-math,div,span,small,time,a,dt,dd,caption'))if(!el.closest('.pa-translation,nav,footer,aside')&&!el.matches(ignored))add(el);
      const walker=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);while(walker.nextNode()){const node=walker.currentNode;if(node.data.trim()&&!node.parentElement.closest(ignored+',nav,footer,aside')&&node.parentElement.getClientRects().length)add(node);}
    }
    const used=[...records.values()].map(r=>r.target);
    for(const model of models){
      if(!model.eligible||records.has(model.index))continue;
      const options=(keyed.get(model.key)||[]).filter(node=>!used.some(other=>other===node||other.contains(node)||node.contains(other)));
      options.sort((a,b)=>{
        const score=n=>n.nodeType===3?0:n.tagName==='FIGCAPTION'?5:/^(P|H[1-6]|LI|UL|OL|TABLE|BLOCKQUOTE)$/.test(n.tagName)?4:n.childElementCount===0?2:1;
        const visible=n=>(n.nodeType===1?n:n.parentElement).getClientRects().length?10:0;return visible(b)+score(b)-visible(a)-score(a);
      });
      for(const target of options){
        const patches=textPlan(target,model.translatedDOM);if(!patches)continue;
        records.set(model.index,{target,patches,model,structure:units(target,false).filter(u=>u.key).map(u=>u.key).join('\0'),lang:target.nodeType===1?target.getAttribute('lang'):null,companion:null});used.push(target);break;
      }
    }
    navigation();applyMode();paint(config.highlights||[]);observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  }
  function ranges(el,text){
    const nodes=[];let full='';
    const add=node=>{nodes.push({node,start:full.length});full+=node.data;};
    if(el.nodeType===3)add(el);else{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);while(walker.nextNode())add(walker.currentNode);}
    const result=[];let offset=0;
    while(text&&(offset=full.indexOf(text,offset))!==-1){const a=nodes.find(n=>n.start+n.node.length>offset),b=nodes.find(n=>n.start+n.node.length>=offset+text.length);if(a&&b){const range=new Range();range.setStart(a.node,offset-a.start);range.setEnd(b.node,offset+text.length-b.start);result.push(range);}offset+=text.length;}
    return result;
  }
  function paint(highlights){if(!globalThis.CSS?.highlights)return;const found=[];for(const h of highlights){const r=records.get(h.page),el=h.language==='chinese'&&config.mode==='bilingual'?r?.companion:r?.target;if(el&&(config.mode==='bilingual'||h.language===(config.mode==='chinese'?'chinese':'original')))found.push(...ranges(el,h.text));}CSS.highlights.set('pa-annotations',new Highlight(...found));}
  const element=target=>target.nodeType===1?target:target.parentElement;
  function recordFor(node){return [...records.values()].find(r=>r.target===node||r.target.contains(node));}
  function state(){
    let page=1;for(const [index,r] of [...records].sort((a,b)=>a[0]-b[0]))if(element(r.target).getClientRects().length&&element(r.target).getBoundingClientRect().top<innerHeight*.3)page=index;
    const s=getSelection();let selection=null;
    if(s?.rangeCount&&!s.isCollapsed){const range=s.getRangeAt(0),start=range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement,end=range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement,companion=start.closest('[data-pa-language=chinese].pa-translation');
      if(companion&&companion.contains(end))selection={text:s.toString().trim().slice(0,15000),page:Number(companion.dataset.paBlock),language:'chinese',rects:[]};
      else{const r=recordFor(range.startContainer);if(r&&(r.target===range.endContainer||r.target.contains(range.endContainer)))selection={text:s.toString().trim().slice(0,15000),page:r.model.index,language:config.mode==='chinese'?'chinese':'original',rects:[]};}
    }
    return {page,selection,matched:records.size,total:models.filter(b=>b.eligible).length,unmatched:models.filter(b=>b.eligible&&!records.has(b.index)).map(b=>b.index),mirrors:mirrors.length,title:document.title,scrollY};
  }
  function reveal(target){let parent=element(target).closest('details');while(parent){parent.open=true;parent=parent.parentElement?.closest('details');}}
  function go(index){const r=records.get(index);if(!r)return false;reveal(r.target);element(r.target).scrollIntoView({block:'start'});return true;}
  function find(text,previous=false,again=false){
    if(text!==query||!again){query=text;matches=[];match=-1;for(const [page,r] of records)for(const el of [r.target,r.companion])if(el)for(const range of ranges(el,text))matches.push({page,range});}
    if(matches.length){match=(match+(previous?-1:1)+matches.length)%matches.length;reveal(matches[match].range.startContainer);matches[match].range.startContainer.parentElement.scrollIntoView({block:'center'});}
    CSS.highlights?.set('pa-search',new Highlight(...matches.map(m=>m.range)));return {current:matches.length?match+1:0,total:matches.length};
  }
  observer=new MutationObserver(changes=>{
    if(changes.every(c=>c.target.parentElement?.closest(ignored)||c.target.closest?.(ignored)))return;
    clearTimeout(timer);timer=setTimeout(scan,200);
  });
  const api={state,go,find,paint,reset:restore,clearSelection:()=>getSelection()?.removeAllRanges(),
    configure(next){observer.disconnect();const changed=next.blocks!==undefined&&JSON.stringify(config.blocks)!==JSON.stringify(next.blocks);if(changed)restore();config={...config,...next};if(changed)prepare();if(changed||!records.size)scan();else{applyMode();paint(config.highlights||[]);observer.observe(document.body,{childList:true,subtree:true,characterData:true});}return state();},
    destroy(){destroyed=true;clearTimeout(timer);observer.disconnect();restore();style.remove();for(const css of repairedShadows)css.remove();CSS.highlights?.delete('pa-annotations');CSS.highlights?.delete('pa-search');delete globalThis.__paperArchiveArticle;}};
  globalThis.__paperArchiveArticle=api;prepare();scan();return state();
}
module.exports={installArticleOverlay};
