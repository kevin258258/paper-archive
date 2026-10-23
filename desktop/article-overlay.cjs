/** Runs in an isolated world. Chinese changes Text.data in the original DOM;
 * original elements, attributes, event handlers and widget state stay in place.
 */
function installArticleOverlay(payload){
  const existing=globalThis.__paperArchiveArticle;
  if(existing){existing.configure(payload);return existing.state();}
  const normalize=text=>(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const ignored='script,style,noscript,svg,canvas,iframe,video,audio,input,select,textarea,output,.pa-translation,.katex-html,.MathJax_Preview';
  const mathSelector='.katex,mjx-container,.MathJax,math,d-math';
  const mutations=new WeakMap();
  const originalText=node=>{const patch=mutations.get(node);return patch&&node.data===patch.current?patch.original:node.data;};
  const mathKey=node=>node.getAttribute('data-pa-tex')||node.getAttribute('data-tex')||node.getAttribute('alttext')||node.querySelector('annotation[encoding="application/x-tex"]')?.textContent||(node.tagName==='D-MATH'?node.textContent:null)||'UNKNOWN '+node.textContent;
  function read(node){
    if(node.nodeType===3)return originalText(node);
    if(node.nodeType===1){if(node.matches(ignored))return '';if(node.matches(mathSelector))return ' MATH '+mathKey(node)+' END ';if(node.tagName==='BR')return ' ';}
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
  const root=()=>document.querySelector('d-article,article,main,[role=main]')||document.body;
  function prepare(){
    models=config.blocks.map(b=>{
      const translated=parse(b.html),key=normalize(b.source),text=read(translated);
      return {...b,key,translatedDOM:translated,text,eligible:!!b.translated&&!b.code&&!!normalize(text)&&normalize(text)!==key};
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
        else if(node.tagName==='CODE')key='code:'+node.textContent;
        else if(!isRoot&&node.tagName==='A'&&read(node).trim())key=skipLinks.has('link:'+href(node))?'':'link:'+href(node);
        else if(styles&&!isRoot&&/^(EM|I|STRONG|B)$/.test(node.tagName))key=/^(EM|I)$/.test(node.tagName)?'em':'strong';
        if(key){list.push({node,key});list.push({nodes:[],text:''});return;}
      }
      for(const child of node.childNodes)visit(child);
    }
    visit(target,true);return list;
  }
  function textPlan(target,translated,allowStyles=true){
    let left=units(target,allowStyles),right=units(translated,allowStyles);
    // Markdown autolinks bare email/URL text that was never a link in the
    // author's DOM. Keep that DOM as text instead of inventing a new element.
    const originalLinks=new Set(left.filter(u=>u.key?.startsWith('link:')).map(u=>u.key)),skipLinks=new Set(right.filter(u=>u.key?.startsWith('link:')&&!originalLinks.has(u.key)&&read(target).includes(read(u.node))).map(u=>u.key));
    if(skipLinks.size)right=units(translated,allowStyles,skipLinks);
    const keys=list=>list.filter(u=>u.key).map(u=>u.key).join('\0');
    if(keys(left)!==keys(right)){if(allowStyles)return textPlan(target,translated,false);return null;}
    const patches=[];
    for(let i=0;i<left.length;i++){
      const a=left[i],b=right[i];
      if(a.key){
        if(a.key.startsWith('math:')||a.key.startsWith('code:'))continue;
        const nested=textPlan(a.node,b.node,allowStyles);if(!nested){if(allowStyles)return textPlan(target,translated,false);return null;}patches.push(...nested);continue;
      }
      const text=b.text;
      if(!a.nodes.length){if(text.trim()){if(allowStyles)return textPlan(target,translated,false);return null;}continue;}
      const active=a.nodes.filter(n=>originalText(n).trim()),nodes=active.length?active:a.nodes;
      const chars=Array.from(text),weight=nodes.reduce((n,node)=>n+Math.max(1,originalText(node).trim().length),0);
      let consumed=0,offset=0;
      for(const node of a.nodes){
        const before=originalText(node);let chinese='';
        if(nodes.includes(node)){consumed+=Math.max(1,before.trim().length);const end=node===nodes[nodes.length-1]?chars.length:Math.round(chars.length*consumed/weight);chinese=chars.slice(offset,end).join('');offset=end;}
        patches.push({node,original:before,chinese,current:node.data});
      }
    }
    return patches;
  }
  function apply(patches,chinese){
    for(const p of patches){const value=chinese?p.chinese:p.original;if(p.node.data===p.current||p.node.data===p.original){p.node.data=value;p.current=value;mutations.set(p.node,p);}}
  }
  function restoreRecord(record){
    apply(record.patches,false);record.companion?.remove();
    if(record.target.nodeType===1){record.target.removeAttribute('data-pa-block');record.target.removeAttribute('data-pa-language');if(record.lang===null)record.target.removeAttribute('lang');else record.target.setAttribute('lang',record.lang);}
  }
  function restore(){
    observer?.disconnect();for(const record of records.values())restoreRecord(record);for(const mirror of mirrors)apply(mirror.patches,false);records.clear();mirrors=[];
  }
  function applyMode(){
    for(const record of records.values()){
      apply(record.patches,config.mode==='chinese');
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
    const headings=[...records.values()].filter(r=>r.target.nodeType===1&&/^H[1-6]$/.test(r.target.tagName));
    for(const link of document.querySelectorAll('a[href*="#"]')){
      if(link.closest('.pa-translation')||[...records.values()].some(r=>r.target===link||r.target.contains(link)))continue;
      const key=normalize(read(link)),heading=headings.find(r=>r.model.key===key);if(!heading)continue;
      const content=document.createDocumentFragment();content.append(document.createTextNode(heading.model.text.trim()));const patches=textPlan(link,content);if(patches)mirrors.push({patches});
    }
  }
  function scan(){
    if(destroyed)return;observer.disconnect();
    for(const [index,record] of records)if(!record.target.isConnected||normalize(read(record.target))!==record.model.key||record.patches.some(p=>!p.node.isConnected)||units(record.target,false).filter(u=>u.key).map(u=>u.key).join('\0')!==record.structure){
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
    destroy(){destroyed=true;clearTimeout(timer);observer.disconnect();restore();style.remove();CSS.highlights?.delete('pa-annotations');CSS.highlights?.delete('pa-search');delete globalThis.__paperArchiveArticle;}};
  globalThis.__paperArchiveArticle=api;prepare();scan();return state();
}
module.exports={installArticleOverlay};
