import * as pdfjs from '/vendor/pdfjs-dist/legacy/build/pdf.mjs';
import {marked} from '/vendor/marked/lib/marked.esm.js';
import katex from '/vendor/katex/dist/katex.mjs';
import {$,esc,toast} from './api.js';
import {PaperChat} from './chat.js';

globalThis.pdfjsLib=pdfjs;
pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdfjs-dist/legacy/build/pdf.worker.mjs';
const pdfUI=import('/vendor/pdfjs-dist/legacy/web/pdf_viewer.mjs');
// Render paper answers, including TeX and emphasis adjacent to CJK punctuation.
export const markdown=text=>{
  const math=[];
  // Protect code while extracting math before Markdown consumes TeX backslashes.
  const source=(text||'').replace(/```[\s\S]*?```|`[^`\n]+`|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|(?<![\\\w])\$([^\n$]+?)\$(?!\w)/g,
    (match,displayBracket,displayDollar,inlineBracket,inlineDollar)=>{
      if(match.startsWith('`'))return match;
      const display=displayBracket!==undefined||displayDollar!==undefined;
      const tex=displayBracket??displayDollar??inlineBracket??inlineDollar;
      let html;
      try{html=katex.renderToString(tex,{displayMode:display,throwOnError:false,strict:false,trust:false,output:'html',maxExpand:1000,maxSize:20});}
      catch{html=esc(match);}
      const index=math.push(html)-1;return `PAPERMATHTOKEN${index}END`;
    });
  const normalized=source.replace(/```[\s\S]*?```|`[^`\n]+`|\*\*([^\n]+?)\*\*/g,
    (match,strong)=>strong===undefined?match:` **${strong.trim()}** `);
  const rendered=marked.parse(normalized);
  // Sanitize the author's HTML first. KaTeX's trusted=false output is inserted afterwards
  // so its required inline positioning styles survive without allowing author styles.
  const template=document.createElement('template');
  template.innerHTML=DOMPurify.sanitize(rendered,{USE_PROFILES:{html:true},
    FORBID_TAGS:['img','iframe','form','input','style'],FORBID_ATTR:['style']});
  const walker=document.createTreeWalker(template.content,NodeFilter.SHOW_TEXT),nodes=[];
  while(walker.nextNode())nodes.push(walker.currentNode);
  for(const node of nodes){
    if(!/PAPERMATHTOKEN\d+END/.test(node.data))continue;
    const fragment=document.createDocumentFragment();let cursor=0;
    for(const match of node.data.matchAll(/PAPERMATHTOKEN(\d+)END/g)){
      fragment.append(document.createTextNode(node.data.slice(cursor,match.index)));
      const equation=document.createElement('template');
      equation.innerHTML=math[Number(match[1])]??esc(match[0]);fragment.append(equation.content);
      cursor=match.index+match[0].length;
    }
    fragment.append(document.createTextNode(node.data.slice(cursor)));node.replaceWith(fragment);
  }
  return template.innerHTML;
};

export class Reader {
  constructor(host,options){
    this.host=host;this.options=options;this.generation=0;this.saveChain=Promise.resolve();this.dirty={};
    this.chat=new PaperChat(this);
    this.host.addEventListener('click',e=>this.click(e).catch(err=>toast(err.message)));
    this.host.addEventListener('input',e=>{
      if(e.target.id==='personal-draft'){this.saved.draft=e.target.value;this.queueSave({draft:e.target.value});}
      if(e.target.id==='pdf-find')this.find();
      if(e.target.dataset.annotation){
        const h=this.saved.highlights.find(h=>h.id===e.target.dataset.annotation);
        if(h){h.comment=e.target.value;this.queueSave({highlights:this.saved.highlights});}
      }
    });
    this.host.addEventListener('change',e=>{
      if(e.target.id==='reader-page')this.go(Number(e.target.value));
      if(e.target.id==='reader-scale')this.viewer.currentScaleValue=e.target.value;
      if(e.target.id==='reader-note')$('#note-content',host).innerHTML=markdown(this.paper.notes.find(n=>n.key===e.target.value)?.text);
    });
    this.host.addEventListener('mouseup',()=>this.selection());
    document.addEventListener('keydown',e=>this.keydown(e));
    document.addEventListener('visibilitychange',()=>{if(document.hidden&&!this.host.hidden)this.flush();});
    window.addEventListener('pagehide',()=>this.flush());
  }
  async open(p){
    if(!p)throw Error('论文尚未进入索引，请刷新文献库');
    if(this.paper)await this.flush();
    this.chat.stop();
    this.paper=p;this.saved=structuredClone(this.options.getSaved(p.id));
    this.saved.positions||={};this.saved.highlights||=[];this.dirty={};
    this.language=this.saved.language||(p.chinese?'chinese':'original');
    if(!p[this.language])this.language=p.original?'original':'chinese';
    this.host.hidden=false;document.body.style.overflow='hidden';
    this.host.className='reading-room';
    this.host.innerHTML=`
      <header class="reading-bar">
        <button data-reader="close" class="reader-back" aria-label="关闭阅读器">←</button>
        <div class="reading-title" title="${esc(p.title)}">${esc(p.title)}</div>
        <button data-reader="collect" aria-label="收藏当前论文">◌ 收藏</button>
        <div class="reading-languages">${p.chinese?'<button data-reader="chinese">中</button>':''}${p.original?'<button data-reader="original">EN</button>':''}</div>
        <button data-reader="focus" aria-label="沉浸阅读" title="沉浸阅读 · F">⛶</button>
      </header>
      <nav class="reading-tools" aria-label="阅读工具">
        <div class="tool-group"><button data-reader="outline" aria-label="显示目录" title="目录">☷</button><button data-reader="find" aria-label="文内搜索" title="文内搜索 · Ctrl F">⌕</button></div>
        <div class="tool-group page-tools"><button data-reader="prev" aria-label="上一页">←</button><input id="reader-page" aria-label="页码" type="number" min="1" value="1"><span id="reader-pages" class="mono">/ —</span><button data-reader="next" aria-label="下一页">→</button></div>
        <div class="tool-group zoom-tools"><button data-reader="minus" aria-label="缩小">−</button><select id="reader-scale" aria-label="缩放"><option value="auto">自适应</option><option value="page-width">适合宽度</option><option value="page-fit">整页</option><option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option><option value="2">200%</option></select><button data-reader="plus" aria-label="放大">+</button></div>
        <div class="tool-group"><button data-reader="focus" class="focus-exit" aria-label="退出沉浸" title="退出沉浸 · Esc">⛶</button><button data-reader="annotations" aria-label="显示批注">批注</button><button data-reader="chat" aria-label="询问论文">✳ 问论文</button><a id="pdf-file" target="_blank" rel="noopener" aria-label="打开 PDF 文件">↗</a></div>
      </nav>
      <div class="find-bar" hidden><input id="pdf-find" type="search" aria-label="文内搜索词" placeholder="文内搜索"><span id="find-count" class="mono"></span><button data-reader="find-prev" aria-label="上一个匹配">↑</button><button data-reader="find-next" aria-label="下一个匹配">↓</button><button data-reader="find-close" aria-label="关闭文内搜索">×</button></div>
      <div class="reading-layout">
        <aside class="reading-outline" hidden><div class="panel-label">目录</div><div id="outline-content"></div></aside>
        <div class="pdf-stage"><div id="viewer-container" tabindex="0"><div id="pdf-viewer" class="pdfViewer"></div></div><div id="pdf-loading" role="status">载入论文…</div></div>
        <aside class="reading-notes" hidden>
          <nav class="reader-panel-tabs" aria-label="阅读侧栏"><button data-panel-tab="chat">问答</button><button data-panel-tab="annotations">批注 <span id="annotation-count"></span></button><button data-panel-tab="notes">笔记</button><button data-reader="hide-panel" aria-label="关闭阅读侧栏">×</button></nav>
          ${this.chat.shell()}
          <section class="annotation-panel" data-panel="annotations" hidden><div class="annotation-toolbar"><span id="save-status">已保存</span><button data-reader="page-note">＋ 页批注</button></div><div id="highlights"></div></section>
          <section class="notes-panel" data-panel="notes" hidden><div class="panel-label">我的笔记</div>
            <textarea id="personal-draft" aria-label="我的笔记" placeholder="记录思考…">${esc(this.saved.draft||'')}</textarea>
            <select id="reader-note" aria-label="阅读笔记">${p.notes.map(n=>`<option value="${n.key}">${n.label}</option>`).join('')||'<option>暂无研究笔记</option>'}</select>
            <article id="note-content" class="markdown">${markdown(p.notes[0]?.text)}</article></section>
        </aside>
      </div>
      <div id="selection-action" hidden><button data-reader="highlight">＋ 批注</button><button data-reader="ask-selection">✳ 问 AI</button></div>
      <div class="reading-progress"><span id="reading-progress-fill"></span></div>`;
    this.renderHighlights();
    const {PDFViewer,EventBus,PDFLinkService,PDFFindController}=await pdfUI;
    this.bus=new EventBus();this.links=new PDFLinkService({eventBus:this.bus,externalLinkTarget:2,externalLinkRel:'noopener noreferrer'});
    this.findController=new PDFFindController({eventBus:this.bus,linkService:this.links});
    this.viewer=new PDFViewer({container:$('#viewer-container',this.host),viewer:$('#pdf-viewer',this.host),
      eventBus:this.bus,linkService:this.links,findController:this.findController,
      textLayerMode:1,annotationMode:1,removePageBorders:true,
      imageResourcesPath:'/vendor/pdfjs-dist/web/images/',enableScripting:false});
    this.links.setViewer(this.viewer);
    this.bus.on('pagesinit',()=>{
      const position=this.saved.positions[this.language];
      this.viewer.currentScaleValue=position?.scale||'auto';
      requestAnimationFrame(()=>{
        if(this.destination){this.viewer.scrollPageIntoView({pageNumber:this.destination});this.destination=null;}
        else if(position?.hash)this.links.setHash(position.hash);
        else if(position?.page)this.viewer.currentPageNumber=position.page;
        else this.viewer.scrollPageIntoView({pageNumber:1});
        requestAnimationFrame(()=>this.restoring=false);
      });
      $('#pdf-loading',this.host).hidden=true;
    });
    this.bus.on('pagechanging',({pageNumber})=>{
      $('#reader-page',this.host).value=pageNumber;
      $('#reading-progress-fill',this.host).style.width=`${100*pageNumber/(this.pdf?.numPages||1)}%`;
      this.chat.pageChanged();
    });
    this.bus.on('updateviewarea',({location})=>{
      if(this.restoring||!this.pdf)return;
      this.saved.positions[this.language]={page:location.pageNumber,scale:this.viewer.currentScaleValue,hash:location.pdfOpenParams.slice(1)};
      this.queueSave({positions:structuredClone(this.saved.positions),language:this.language});
    });
    this.bus.on('pagerendered',()=>this.paintHighlights());
    this.bus.on('scalechanging',()=>{
      const select=$('#reader-scale',this.host),value=this.viewer.currentScaleValue;
      select.querySelector('[data-custom]')?.remove();
      if(![...select.options].some(o=>o.value===value)){const option=new Option(Math.round(this.viewer.currentScale*100)+'%',value);option.dataset.custom='1';select.add(option);}
      select.value=value;
    });
    this.bus.on('updatefindmatchescount',({matchesCount})=>{$('#find-count',this.host).textContent=`${matchesCount.current} / ${matchesCount.total}`;});
    this.bus.on('updatefindcontrolstate',({state})=>{if(state===1)$('#find-count',this.host).textContent='0 / 0';});
    $('#reader-page',this.host).addEventListener('keydown',e=>{if(e.key==='Enter'){this.go(Number(e.target.value));e.target.blur();}});
    $('#pdf-find',this.host).addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();this.find(true,e.shiftKey);}});
    await this.load();
    this.chat.open(p);this.switchPanel('chat',false);
    $('[data-reader=close]',this.host).focus();
  }
  async load(destination=null){
    await this.flush();const generation=++this.generation;this.restoring=true;
    this.destination=destination;
    if(this.task)await this.task.destroy();
    this.viewer.setDocument(null);this.links.setDocument(null);this.pdf=null;
    $('#pdf-loading',this.host).hidden=false;$('#pdf-loading',this.host).textContent='载入论文…';
    $('[data-reader=chinese]',this.host)?.classList.toggle('active',this.language==='chinese');
    $('[data-reader=original]',this.host)?.classList.toggle('active',this.language==='original');
    const url=`/file/${this.paper.id}/${this.language}`;$('#pdf-file',this.host).href=url;
    this.task=pdfjs.getDocument({url,cMapUrl:'/vendor/pdfjs-dist/cmaps/',cMapPacked:true,
      standardFontDataUrl:'/vendor/pdfjs-dist/standard_fonts/',wasmUrl:'/vendor/pdfjs-dist/wasm/',
      isEvalSupported:false,enableXfa:false});
    try{
      const pdf=await this.task.promise;if(generation!==this.generation)return;this.pdf=pdf;
      $('#reader-pages',this.host).textContent='/ '+pdf.numPages;$('#reader-page',this.host).max=pdf.numPages;
      this.viewer.setDocument(pdf);this.links.setDocument(pdf);
      const outline=await pdf.getOutline();if(generation!==this.generation)return;
      this.outlineItems=[];
      const render=items=>items.map(item=>{const index=this.outlineItems.push(item)-1;return `<div class="outline-item"><button data-outline="${index}">${esc(item.title)}</button>${item.items?.length?`<div class="outline-children">${render(item.items)}</div>`:''}</div>`;}).join('');
      $('#outline-content',this.host).innerHTML=outline?.length?render(outline):Array.from({length:pdf.numPages},(_,i)=>`<button class="page-link" data-page="${i+1}">${String(i+1).padStart(2,'0')}</button>`).join('');
      this.queueSave({language:this.language});
      this.chat.pageChanged();
    }catch(e){if(generation===this.generation)$('#pdf-loading',this.host).innerHTML=`<span>无法显示论文：${esc(e.message)}</span><a href="${url}" target="_blank">打开 PDF ↗</a>`;}
  }
  queueSave(patch){
    Object.assign(this.dirty,patch);const label=$('#save-status',this.host);if(label)label.textContent='保存中';
    clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.flush(),700);
  }
  flush(){
    clearTimeout(this.saveTimer);
    if(!this.paper||!Object.keys(this.dirty).length)return this.saveChain;
    const id=this.paper.id,patch=structuredClone(this.dirty);this.dirty={};
    this.saveChain=this.saveChain.catch(()=>{}).then(()=>this.options.save(id,patch)).then(()=>{
      const label=$('#save-status',this.host);if(label)label.textContent=Object.keys(this.dirty).length?'保存中':'已保存';
    }).catch(e=>{Object.assign(this.dirty,patch,this.dirty);const label=$('#save-status',this.host);if(label)label.textContent='保存失败';toast('阅读数据保存失败：'+e.message);throw e;});
    return this.saveChain;
  }
  async close(){
    try{await this.flush();}catch{return;}
    this.chat.stop();this.generation++;if(this.task)await this.task.destroy();this.task=null;this.pdf=null;this.viewer?.setDocument(null);
    this.host.hidden=true;this.paper=null;this.options.onClose();
  }
  go(page){if(this.pdf)this.viewer.currentPageNumber=Math.max(1,Math.min(this.pdf.numPages,Math.round(page)||1));}
  async jump(language,page){
    if(this.language!==language){this.language=language;await this.load(page);}
    else this.viewer.scrollPageIntoView({pageNumber:page});
    this.chat.pageChanged();
  }
  switchPanel(tab,visible=true){
    $('.reading-notes',this.host).hidden=!visible;
    this.host.querySelectorAll('[data-panel]').forEach(p=>p.hidden=p.dataset.panel!==tab);
    this.host.querySelectorAll('[data-panel-tab]').forEach(b=>{b.classList.toggle('active',b.dataset.panelTab===tab);b.setAttribute('aria-pressed',b.dataset.panelTab===tab);});
    this.host.querySelectorAll('[data-reader=chat],[data-reader=annotations]').forEach(b=>b.setAttribute('aria-pressed',visible&&b.dataset.reader===tab));
    requestAnimationFrame(()=>{if(['auto','page-width','page-fit'].includes(this.viewer?.currentScaleValue))this.viewer.currentScaleValue=this.viewer.currentScaleValue;});
  }
  addAnnotation(selection){
    const h={...selection,id:crypto.randomUUID(),created:Date.now(),comment:''};
    this.saved.highlights.push(h);this.queueSave({highlights:this.saved.highlights});
    this.pendingSelection=null;$('#selection-action',this.host).hidden=true;window.getSelection()?.removeAllRanges();
    this.renderHighlights();this.paintHighlights();this.switchPanel('annotations');
    $(`[data-annotation="${h.id}"]`,this.host).focus();
  }
  immersive(active){
    this.host.classList.toggle('immersive',active);
    this.host.querySelectorAll('[data-reader=focus]').forEach(b=>b.setAttribute('aria-pressed',active));
    (active?$('#viewer-container',this.host):$('.reading-bar [data-reader=focus]',this.host)).focus();
  }
  find(again=false,previous=false){this.bus.dispatch('find',{source:this,type:again?'again':'',query:$('#pdf-find',this.host).value,caseSensitive:false,entireWord:false,highlightAll:true,findPrevious:previous,matchDiacritics:false});}
  async click(e){
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.panelTab){this.switchPanel(b.dataset.panelTab);return;}
    if(b.dataset.outline!==undefined){const item=this.outlineItems[Number(b.dataset.outline)];if(item.dest)await this.links.goToDestination(item.dest);return;}
    if(b.dataset.page){this.go(Number(b.dataset.page));return;}
    if(b.dataset.removeHighlight){this.saved.highlights=this.saved.highlights.filter(h=>h.id!==b.dataset.removeHighlight);this.queueSave({highlights:this.saved.highlights});this.renderHighlights();this.paintHighlights();return;}
    if(b.dataset.highlightPage){const h=this.saved.highlights.find(h=>h.id===b.dataset.highlightPage);await this.jump(h.language,h.page);return;}
    if(b.dataset.askAnnotation){const h=this.saved.highlights.find(h=>h.id===b.dataset.askAnnotation);this.switchPanel('chat');this.chat.setSelection(h);return;}
    const action=b.dataset.reader;if(!action)return;
    if(action==='close')return this.close();
    if(action==='collect')return this.options.collect(this.paper);
    if(action==='chat'||action==='annotations')this.switchPanel(action);
    if(action==='hide-panel')this.switchPanel('chat',false);
    if(action==='page-note')this.addAnnotation({text:'',language:this.language,page:this.viewer.currentPageNumber,rects:[]});
    if(action==='ask-selection'&&this.pendingSelection){this.switchPanel('chat');this.chat.setSelection(this.pendingSelection);$('#selection-action',this.host).hidden=true;window.getSelection()?.removeAllRanges();}
    if(action==='chinese'||action==='original'){if(action===this.language)return;await this.flush();this.language=action;return this.load();}
    if(action==='next')this.go(this.viewer.currentPageNumber+1);
    if(action==='prev')this.go(this.viewer.currentPageNumber-1);
    if(action==='plus')this.viewer.increaseScale();
    if(action==='minus')this.viewer.decreaseScale();
    if(action==='focus')this.immersive(!this.host.classList.contains('immersive'));
    if(action==='outline'||action==='notes'){
      const pane=$('.reading-'+action,this.host);pane.hidden=!pane.hidden;b.setAttribute('aria-pressed',!pane.hidden);
      requestAnimationFrame(()=>{if(['auto','page-width','page-fit'].includes(this.viewer.currentScaleValue))this.viewer.currentScaleValue=this.viewer.currentScaleValue;});
    }
    if(action==='find'){const bar=$('.find-bar',this.host);bar.hidden=!bar.hidden;if(!bar.hidden)$('#pdf-find',this.host).focus();}
    if(action==='find-close'){$('.find-bar',this.host).hidden=true;this.bus.dispatch('findbarclose',{source:this});}
    if(action==='find-next')this.find(true);
    if(action==='find-prev')this.find(true,true);
    if(action==='highlight'&&this.pendingSelection){
      this.addAnnotation(this.pendingSelection);
    }
  }
  selection(){
    const selection=window.getSelection();const action=$('#selection-action',this.host);
    if(!selection||selection.isCollapsed||!selection.rangeCount){if(action)action.hidden=true;return;}
    const range=selection.getRangeAt(0),start=range.startContainer.parentElement?.closest('.page'),end=range.endContainer.parentElement?.closest('.page');
    if(!start||start!==end||!this.host.contains(start)){action.hidden=true;return;}
    const box=start.getBoundingClientRect(),text=selection.toString().trim().slice(0,15000);
    if(!text){action.hidden=true;return;}
    const rects=[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>({x:(r.x-box.x)/box.width,y:(r.y-box.y)/box.height,w:r.width/box.width,h:r.height/box.height})).slice(0,300);
    this.pendingSelection={text,page:Number(start.dataset.pageNumber),language:this.language,rects};
    action.hidden=false;
  }
  renderHighlights(){
    $('#annotation-count',this.host).textContent=this.saved.highlights.length||'';
    $('#highlights',this.host).innerHTML=[...this.saved.highlights].sort((a,b)=>a.language.localeCompare(b.language)||a.page-b.page).map(h=>`<article class="annotation-card">
      <div class="annotation-head"><button data-highlight-page="${h.id}">${h.language==='chinese'?'中':'EN'} · ${h.page} 页 ↗</button><button data-remove-highlight="${h.id}" aria-label="删除批注">×</button></div>
      ${h.text?`<button class="annotation-quote" data-highlight-page="${h.id}">${esc(h.text)}</button>`:''}
      <textarea data-annotation="${h.id}" aria-label="第 ${h.page} 页批注" placeholder="写下批注…" maxlength="20000">${esc(h.comment||'')}</textarea>
      ${h.text?`<button class="text-button" data-ask-annotation="${h.id}">问这段文字 ↗</button>`:''}
      </article>`).join('')||'<div class="empty-excerpts"><span>⌑</span>选中文字添加批注<br>或为当前页写一条笔记</div>';
  }
  paintHighlights(){
    this.host.querySelectorAll('.saved-highlight').forEach(el=>el.remove());
    for(const h of this.saved.highlights.filter(h=>h.language===this.language)){
      const page=this.host.querySelector(`.page[data-page-number="${h.page}"]`);if(!page)continue;
      for(const r of h.rects||[]){const el=document.createElement('span');el.className='saved-highlight';Object.assign(el.style,{left:100*r.x+'%',top:100*r.y+'%',width:100*r.w+'%',height:100*r.h+'%'});page.append(el);}
    }
  }
  keydown(e){
    if(this.host.hidden)return;
    if(document.querySelector('dialog[open]'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='f'){e.preventDefault();$('.find-bar',this.host).hidden=false;$('#pdf-find',this.host).focus();return;}
    if(e.key==='Escape'){
      if(!$('.find-bar',this.host).hidden){$('.find-bar',this.host).hidden=true;this.bus?.dispatch('findbarclose',{source:this});}
      else if(this.host.classList.contains('immersive'))this.immersive(false);
      else this.close();return;
    }
    if(e.target.closest('input,textarea,select,[contenteditable]'))return;
    if(e.key.toLowerCase()==='f'){e.preventDefault();this.immersive(!this.host.classList.contains('immersive'));}
    if(e.key==='ArrowRight'){e.preventDefault();this.go(this.viewer.currentPageNumber+1);}
    if(e.key==='ArrowLeft'){e.preventDefault();this.go(this.viewer.currentPageNumber-1);}
  }
}
