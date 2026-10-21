import {api,$,esc} from './api.js';

// Article block numbers use the same durable position/citation seam as PDF pages.
export class ArticleView {
  constructor(reader,renderMarkdown){this.r=reader;this.markdown=renderMarkdown;this.current=1;this.mode='single';}
  async mount(){
    const r=this.r;
    this.document=await api('/api/articles/'+r.paper.id);
    if(r.paper.chinese){
      const button=document.createElement('button');button.dataset.reader='bilingual';button.textContent='对照';
      $('.reading-languages',r.host).append(button);
    }
    r.host.classList.add('article-room');
    $('.zoom-tools',r.host).hidden=true;
    $('[data-reader=prev]',r.host).setAttribute('aria-label','上一段');
    $('[data-reader=next]',r.host).setAttribute('aria-label','下一段');
    $('[data-reader=chat]',r.host).textContent='✳ 问文章';
    $('[data-reader=chat]',r.host).setAttribute('aria-label','询问文章');
    $('[data-reader=page-note]',r.host).textContent='＋ 段批注';
    $('#reader-page',r.host).setAttribute('aria-label','段落编号');
    r.viewer={currentPageNumber:1,currentScaleValue:'1',setDocument(){}};
    $('#reader-pages',r.host).textContent='/ '+this.document.blocks.length+' 段';
    $('#reader-page',r.host).max=this.document.blocks.length;
    $('#reader-page',r.host).addEventListener('keydown',e=>{if(e.key==='Enter'){this.go(Number(e.target.value));e.target.blur();}});
    $('#pdf-find',r.host).addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();this.find(true,e.shiftKey);}});
    $('#pdf-loading',r.host).hidden=true;
    $('#outline-content',r.host).innerHTML=this.document.blocks.filter(b=>/^#{1,6} /.test(b.original)).map(b=>`<button class="article-outline-link" data-page="${b.index}">${esc((b[r.language]||b.original).replace(/^#+\s*/,''))}</button>`).join('')||'<button class="page-link" data-page="1">正文</button>';
    this.scroll=$('#viewer-container',r.host);
    this.scroll.addEventListener('scroll',()=>{cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>this.track());});
    this.scroll.addEventListener('click',e=>{
      const link=e.target.closest('a');
      if(link?.getAttribute('href')?.startsWith('#')){
        e.preventDefault();
        const id=link.getAttribute('href').slice(1);
        if(/^block-\d+$/.test(id)){this.go(Number(id.slice(6)));return;}
        const target=this.document.blocks.find(b=>(b.anchors||[]).includes(decodeURIComponent(id)));
        if(target){this.go(target.index);return;}
        const heading=[...this.scroll.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(n=>n.id===id);
        heading?.scrollIntoView({block:'start'});
      }
    });
    await this.load();
  }
  async load(destination){
    const r=this.r,doc=this.document,language=r.language;
    await r.flush();
    const position=destination||r.saved.positions[language]?.page||this.current||1;
    const source=$('#pdf-file',r.host);source.href=doc.source_url;source.setAttribute('aria-label','打开原文网站');source.title='原文网站';
    for(const lang of ['chinese','original'])$(`[data-reader=${lang}]`,r.host)?.classList.toggle('active',this.mode==='single'&&language===lang);
    $('[data-reader=bilingual]',r.host)?.classList.toggle('active',this.mode==='bilingual');
    this.scroll.innerHTML=`<article class="article-document ${this.mode==='bilingual'?'article-parallel':''}"><header class="article-heading"><span class="article-source mono">BLOG · ${esc(doc.site)}</span><h1>${esc(language==='chinese'?doc.chinese_title:doc.title)}</h1><p>${esc(doc.authors.join(' · '))}${doc.published?' · '+esc(doc.published.slice(0,10)):''}</p><a href="${esc(doc.source_url)}" target="_blank" rel="noopener">原文 ↗</a>${doc.completed===false?'<p class="article-status">图文已修复 · 译文复核中</p>':''}${doc.warnings.length?'<details class="article-warnings"><summary>离线保存说明</summary>'+doc.warnings.map(w=>`<p>${esc(w)}</p>`).join('')+'</details>':''}</header><div class="article-body">${doc.blocks.map(b=>`<section class="article-block" data-block="${b.index}" id="block-${b.index}"><a class="block-number mono" href="#block-${b.index}" aria-label="第 ${b.index} 段">${String(b.index).padStart(2,'0')}</a>${(this.mode==='bilingual'?['original','chinese']:[language]).map(lang=>`<div class="article-prose markdown" data-block-language="${lang}">${!b[lang]?'<span class="article-pending">待翻译 · 原文</span>':''}${this.markdown(b[lang]||b.original,true)}</div>`).join('')}</section>`).join('')}</div><footer class="article-end mono">END · ${doc.blocks.length} 段</footer></article>`;
    // Stable heading anchors for the original page's in-document references.
    this.scroll.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h=>{h.id=h.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').replace(/\s+/g,'-');});
    this.go(position);
    r.queueSave({language});this.paint();
  }
  go(page){
    const r=this.r,n=Math.max(1,Math.min(this.document.blocks.length,Math.round(page)||1));
    this.current=n;r.viewer.currentPageNumber=n;$('#reader-page',r.host).value=n;
    if(n===1)this.scroll.scrollTop=0;else this.scroll.querySelector(`[data-block="${n}"]`)?.scrollIntoView({block:'start'});
    this.update();
  }
  track(){
    const top=this.scroll.getBoundingClientRect().top+90;
    let n=1;
    for(const block of this.scroll.querySelectorAll('[data-block]')){if(block.getBoundingClientRect().top>top)break;n=Number(block.dataset.block);}
    this.current=n;this.r.viewer.currentPageNumber=n;$('#reader-page',this.r.host).value=n;this.update();
  }
  update(){
    const r=this.r;
    r.saved.positions[r.language]={page:this.current};
    r.queueSave({positions:structuredClone(r.saved.positions),language:r.language});
    $('#reading-progress-fill',r.host).style.width=100*this.current/this.document.blocks.length+'%';r.chat.pageChanged();
  }
  selection(){
    const r=this.r,selection=window.getSelection(),action=$('#selection-action',r.host);
    if(!selection?.rangeCount||selection.isCollapsed){action.hidden=true;return;}
    const range=selection.getRangeAt(0),start=range.startContainer.parentElement?.closest('[data-block-language]'),end=range.endContainer.parentElement?.closest('[data-block-language]');
    if(!start||start!==end||!this.scroll.contains(start)){action.hidden=true;return;}
    const text=selection.toString().trim().slice(0,15000);if(!text){action.hidden=true;return;}
    r.pendingSelection={text,page:Number(start.closest('[data-block]').dataset.block),language:start.dataset.blockLanguage,rects:[]};
    action.hidden=false;
  }
  ranges(el,text){
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),nodes=[];let full='';
    while(walker.nextNode()){const node=walker.currentNode;nodes.push({node,start:full.length});full+=node.data;}
    const ranges=[];let offset=0;
    while(text&&(offset=full.indexOf(text,offset))!==-1){
      const begin=nodes.find(n=>n.start+n.node.length>offset),end=nodes.find(n=>n.start+n.node.length>=offset+text.length);
      if(begin&&end){const range=new Range();range.setStart(begin.node,offset-begin.start);range.setEnd(end.node,offset+text.length-end.start);ranges.push(range);}offset+=text.length;
    }
    return ranges;
  }
  paint(){
    if(!globalThis.CSS?.highlights||!globalThis.Highlight)return;
    const ranges=[];
    for(const h of this.r.saved.highlights){const el=this.scroll.querySelector(`[data-block="${h.page}"] [data-block-language="${h.language}"]`);if(el&&h.text)ranges.push(...this.ranges(el,h.text));}
    CSS.highlights.set('article-annotations',new Highlight(...ranges));
  }
  find(again,previous){
    const query=$('#pdf-find',this.r.host).value;
    if(!again||this.query!==query){this.query=query;this.matches=[];for(const el of this.scroll.querySelectorAll('.article-prose'))for(const range of this.ranges(el,query))this.matches.push({range,page:Number(el.closest('[data-block]').dataset.block)});this.match=-1;}
    if(this.matches.length){this.match=(this.match+(previous?-1:1)+this.matches.length)%this.matches.length;this.go(this.matches[this.match].page);}
    if(globalThis.CSS?.highlights&&globalThis.Highlight)CSS.highlights.set('article-find',new Highlight(...this.matches.map(m=>m.range)));
    $('#find-count',this.r.host).textContent=this.matches.length?`${this.match+1} / ${this.matches.length}`:'0 / 0';
  }
  destroy(){cancelAnimationFrame(this.frame);globalThis.CSS?.highlights?.delete('article-annotations');globalThis.CSS?.highlights?.delete('article-find');}
}
