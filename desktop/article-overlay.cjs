/** Runs only in an isolated JavaScript world in the unprivileged article view.
 * Original nodes and their listeners stay alive; removing the overlay is lossless.
 */
function installArticleOverlay(payload){
  const existing=globalThis.__paperArchiveArticle;
  if(existing){existing.configure(payload);return existing.state();}
  const normalize=text=>(text||'').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  const textOf=element=>{
    const clone=element.cloneNode(true);
    clone.querySelectorAll('.pa-translation,script,style,.katex-html,.MathJax_Preview,sup').forEach(n=>n.remove());
    clone.querySelectorAll('.katex,mjx-container,.MathJax,math,d-math').forEach(n=>{const tex=n.getAttribute('data-tex')||n.getAttribute('alttext')||n.querySelector('annotation[encoding=\"application/x-tex\"]')?.textContent||(n.tagName==='D-MATH'?n.textContent:null);n.replaceWith(' MATH '+(tex||'UNKNOWN '+n.textContent)+' END ');});
    return normalize(clone.textContent);
  };
  const root=()=>document.querySelector('d-article,article,main,[role=main]')||document.body;
  const style=document.createElement('style');style.textContent=`
    .pa-original-hidden,.pa-translation[hidden]{display:none!important}
    .pa-translation{font-family:inherit;line-height:1.8;overflow-wrap:break-word;scroll-margin-top:40px}
    .pa-translation>:first-child{margin-top:0}.pa-translation>:last-child{margin-bottom:0}
    .pa-translation .katex{line-height:1.2}.pa-translation .katex-display{overflow-x:auto;overflow-y:hidden}
    .pa-translation[data-pa-parallel]{border-inline-start:2px solid #9996;padding-inline-start:16px;margin-block:12px 24px;opacity:.88}
    ::highlight(pa-annotations){background:#d7d2a5;color:inherit}::highlight(pa-search){background:#dfc98a;color:inherit}
  `;document.head.append(style);
  let config=payload,records=new Map(),timer,observer,selection=null,query='',matches=[],match=-1,destroyed=false;
  const eligible=b=>!!b.translated&&b.source.length>1&&!b.code;
  function restore(){
    for(const {el,translation} of records.values()){el.classList.remove('pa-original-hidden');el.removeAttribute('data-pa-block');translation?.remove();}
    records.clear();
  }
  function applyMode(){
    for(const {el,translation,canHide} of records.values()){
      el.classList.toggle('pa-original-hidden',!!translation&&canHide&&config.mode==='chinese');
      if(translation){translation.hidden=config.mode==='original';translation.toggleAttribute('data-pa-parallel',config.mode==='bilingual');}
    }
  }
  function scan(){
    if(destroyed)return;
    observer?.disconnect();
    const distill=[...document.querySelectorAll('d-article,d-appendix')],scopes=distill.length?distill:[root()], candidates=scopes.flatMap(scope=>[...scope.querySelectorAll('h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,pre,table,figure,figcaption,li,d-math')])
      .filter(el=>!el.closest('.pa-translation,nav,footer,aside,[hidden],[aria-hidden=true]'));
    const keyed=new Map();
    for(const el of candidates){const key=textOf(el);if(key){if(!keyed.has(key))keyed.set(key,[]);keyed.get(key).push(el);}}
    const used=new Set([...records.values()].filter(r=>r.el.isConnected).map(r=>r.el));
    for(const [index,record] of records)if(!record.el.isConnected||record.canHide&&textOf(record.el)!==record.key){record.el.classList.remove('pa-original-hidden');record.el.removeAttribute('data-pa-block');record.translation?.remove();records.delete(index);used.delete(record.el);}
    for(const b of config.blocks){
      if(records.has(b.index))continue;
      const key=normalize(b.source);if(!key)continue;
      let options=keyed.get(key)||[];
      // Exact normalized prose only: a changed qualifier must keep its original
      // wording visible, rather than inherit a translation of an older sentence.
      options=options.filter(el=>el.getClientRects().length&&!used.has(el)&&![...used].some(other=>other.contains(el)||el.contains(other)));
      const el=options.find(el=>el.tagName==='FIGCAPTION')||options.find(el=>el.tagName.toLowerCase()===b.tag)||options[0];if(!el)continue;
      used.add(el);el.dataset.paBlock=b.index;
      let translation=null,canHide=true;
      if(eligible(b)){
        // Figures, canvases, controls and custom components remain in their
        // original DOM. Translate a caption separately, never replace a widget.
        const interactive=el.matches('figure')||el.querySelector('img,svg,canvas,iframe,video,audio,input,select,textarea,button,[contenteditable],details');
        canHide=!interactive;
        const template=document.createElement('template');template.innerHTML=b.html;
        template.content.querySelectorAll('img,script,style,iframe,form,input,button,select,textarea,object,embed').forEach(n=>n.remove());
        template.content.querySelectorAll('*').forEach(n=>{for(const a of [...n.attributes])if(/^on/i.test(a.name)||['src','srcset','id'].includes(a.name))n.removeAttribute(a.name);});
        const tag=/^(H[1-6]|P|UL|OL|BLOCKQUOTE|TABLE|LI|FIGCAPTION)$/.test(el.tagName)&&canHide?el.tagName.toLowerCase():'div';
        translation=document.createElement(tag);translation.className=el.className+' pa-translation';translation.dataset.paBlock=b.index;translation.dataset.paLanguage='chinese';translation.lang='zh-CN';
        if(template.content.children.length===1&&template.content.firstElementChild.tagName.toLowerCase()===tag)translation.append(...template.content.firstElementChild.childNodes);
        else translation.append(template.content);
        el.after(translation);
      }
      records.set(b.index,{el,translation,canHide,key:textOf(el)});
    }
    applyMode();paint(config.highlights||[]);
    observer.observe(document.body,{childList:true,subtree:true,characterData:true});
  }
  function ranges(el,text){
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];let full='';while(walker.nextNode()){const node=walker.currentNode;nodes.push({node,start:full.length});full+=node.data;}
    const result=[];let offset=0;
    while(text&&(offset=full.indexOf(text,offset))!==-1){const a=nodes.find(n=>n.start+n.node.length>offset),b=nodes.find(n=>n.start+n.node.length>=offset+text.length);if(a&&b){const range=new Range();range.setStart(a.node,offset-a.start);range.setEnd(b.node,offset+text.length-b.start);result.push(range);}offset+=text.length;}
    return result;
  }
  function paint(highlights){if(!globalThis.CSS?.highlights)return;const found=[];for(const h of highlights){const r=records.get(h.page),el=h.language==='chinese'?r?.translation:r?.el;if(el)found.push(...ranges(el,h.text));}CSS.highlights.set('pa-annotations',new Highlight(...found));}
  function state(){
    let page=1;const ordered=[...records].sort((a,b)=>a[0]-b[0]);
    for(const [index,r] of ordered){const node=config.mode==='chinese'&&r.translation&&!r.translation.hidden?r.translation:r.el;if(node.getBoundingClientRect().top<innerHeight*.3)page=index;}
    const s=getSelection();selection=null;
    if(s?.rangeCount&&!s.isCollapsed){const range=s.getRangeAt(0),node=(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement)?.closest('[data-pa-block]'),end=(range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement)?.closest('[data-pa-block]');if(node&&end===node){const text=s.toString().trim().slice(0,15000);if(text)selection={text,page:Number(node.dataset.paBlock),language:node.dataset.paLanguage||'original',rects:[]};}}
    return {page,selection,matched:[...records.values()].filter(r=>r.translation).length,total:config.blocks.filter(eligible).length,title:document.title,scrollY};
  }
  function go(index){const r=records.get(index);if(!r)return false;const el=config.mode==='chinese'&&r.translation?r.translation:r.el;el.scrollIntoView({block:'start'});return true;}
  function find(text,previous=false,again=false){
    if(text!==query||!again){query=text;matches=[];match=-1;for(const [page,r] of records)for(const el of [r.el,r.translation])if(el&&!el.hidden&&!el.classList.contains('pa-original-hidden'))for(const range of ranges(el,text))matches.push({page,range});}
    if(matches.length){match=(match+(previous?-1:1)+matches.length)%matches.length;const hit=matches[match];hit.range.startContainer.parentElement.scrollIntoView({block:'center'});}
    CSS.highlights?.set('pa-search',new Highlight(...matches.map(m=>m.range)));return {current:matches.length?match+1:0,total:matches.length};
  }
  observer=new MutationObserver(changes=>{
    if(changes.every(c=>c.target.parentElement?.closest('.pa-translation')||c.target.closest?.('.pa-translation')||c.type==='childList'&&c.addedNodes.length+c.removedNodes.length>0&&[...c.addedNodes,...c.removedNodes].every(n=>n.nodeType===1&&n.classList.contains('pa-translation'))))return;
    clearTimeout(timer);timer=setTimeout(scan,500);
  });
  const api={state,go,find,paint,reset:restore,clearSelection:()=>getSelection()?.removeAllRanges(),
    configure(next){const changed=next.blocks!==undefined&&JSON.stringify(config.blocks)!==JSON.stringify(next.blocks);config={...config,...next};if(changed||!records.size){restore();scan();}else{applyMode();paint(config.highlights||[]);}return state();},
    destroy(){destroyed=true;clearTimeout(timer);observer.disconnect();restore();style.remove();CSS.highlights?.delete('pa-annotations');CSS.highlights?.delete('pa-search');delete globalThis.__paperArchiveArticle;}};
  globalThis.__paperArchiveArticle=api;scan();return state();
}
module.exports={installArticleOverlay};
