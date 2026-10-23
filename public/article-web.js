import {$} from './api.js';
import {buildWebBlocks} from './article-web-content.js';

/** The native surface owns the original website; app controls stay in this DOM. */
export class WebArticle{
  constructor(article){
    this.article=article;this.r=article.r;this.visible=true;this.closed=false;this.busy=false;this.initialized=false;this.ready=false;this.generation=0;
    this.shell=document.createElement('div');this.shell.className='article-web-shell';
    this.shell.innerHTML='<div class="article-web-bar"><span class="article-web-status" role="status">正在打开原站…</span><span class="article-web-selection" hidden><button data-reader="highlight">＋ 批注</button><button data-reader="ask-selection">✳ 问 AI</button></span><button data-web="reload" title="重新连接原站">↻</button><button data-web="snapshot" title="保存原站排版的离线快照">保存快照</button><button data-web="offline" disabled>离线快照</button></div><div class="article-web-viewport"><div class="article-web-placeholder"><span>原站网页</span><p>保留排版与交互</p><button data-web="reader">切换到整理版 ↗</button></div></div>';
    article.scroll.replaceChildren(this.shell);this.r.host.classList.add('article-webmode');
    this.viewport=$('.article-web-viewport',this.shell);this.status=$('.article-web-status',this.shell);
    this.shell.addEventListener('click',async e=>{
      const action=e.target.closest('[data-web]')?.dataset.web;if(!action)return;
      try{
        if(action==='reader'){await article.setPresentation('reader');return;}
        if(action==='reload'||action==='offline'){this.ready=false;this.destination=article.current;this.status.textContent=action==='offline'?'正在打开离线快照…':'正在重新连接…';await this.send('reload',{offline:action==='offline'});}
        if(action==='snapshot'){this.status.textContent='正在保存快照…';await this.send('snapshot');}
        await this.poll();
      }catch(error){this.status.textContent=error.message;}
    });
    this.resize=new ResizeObserver(()=>this.schedule());this.resize.observe(this.viewport);
    this.observer=new MutationObserver(()=>this.schedule());this.observer.observe(document.body,{attributes:true,attributeFilter:['hidden','class','open','style'],childList:true,subtree:true});
    this.unsubscribe=globalThis.desktop.onArticleShortcut?.(data=>{
      if(data.id!==this.r.paper.id)return;
      this.r.host.dispatchEvent(new KeyboardEvent('keydown',{key:data.key,ctrlKey:true,shiftKey:data.shift,bubbles:true,cancelable:true}));
    });
    this.timer=setInterval(()=>{this.schedule();if(this.active())this.poll();},650);
  }
  send(command,extra={}){return globalThis.desktop.article({id:this.r.paper.id,command,...extra});}
  active(){return this.visible&&!this.closed&&!this.r.host.hidden&&!this.r.host.closest('.reading-workspace')?.hidden;}
  schedule(){cancelAnimationFrame(this.frame);this.frame=requestAnimationFrame(()=>this.layout());}
  async layout(){
    if(this.closed||!this.initialized)return;
    const rect=this.viewport.getBoundingClientRect(),blocked=document.querySelector('dialog[open],.paper-menu:not([hidden]),.paper-submenu:not([hidden])');
    const visible=this.active()&&!blocked&&rect.width>1&&rect.height>1;
    const bounds={x:rect.x,y:rect.y,width:rect.width,height:rect.height},key=JSON.stringify({visible,bounds});
    if(key===this.bounds)return;this.bounds=key;
    try{await this.send('bounds',{bounds,visible});}catch{}
  }
  payload(){
    if(!this.blocks)this.blocks=buildWebBlocks(this.article.document.blocks,this.article.markdown,this.article.document.source_url);
    return {blocks:this.blocks,title:{original:this.article.document.title,chinese:this.article.document.chinese_title},mode:this.article.mode==='bilingual'?'bilingual':this.r.language,highlights:this.r.saved.highlights};
  }
  async load(page){
    this.destination=page;this.ready=false;
    if(!this.initialized){await this.send('open',this.payload());if(this.closed){await this.send('close');return;}this.initialized=true;}
    else await this.send('configure',this.payload());
    this.schedule();await this.poll();
  }
  async poll(){
    if(this.busy||this.closed||!this.initialized||!this.active())return;this.busy=true;
    try{
      const state=await this.send('state');if(this.closed||!state)return;
      $('.article-web-placeholder',this.shell).hidden=!!state.total;
      $('[data-web=offline]',this.shell).disabled=!state.snapshot;
      $('[data-web=snapshot]',this.shell).disabled=state.loading||state.offline;
      if(state.loading){this.status.textContent='正在载入原站与网页快照…';return;}
      const coverage=Number.isInteger(state.total)?` · 已替换 ${state.matched}/${state.total} 处`:'';
      this.status.textContent=(state.offline?'离线快照 · 静态':'原站 · 交互')+coverage+(state.error?' · '+state.error:'')+(state.snapshotError?' · 快照未保存':'');
      this.status.title=[state.matched<state.total?'未定位的译文保留原文，可在整理版查看：'+(state.unmatched||[]).join('、'):'直接替换原网页文字。作者姓名、代码、纯公式与动态加载占位符保持原样。',state.error,state.snapshotError].filter(Boolean).join('\n');
      if(this.destination&&state.total){await this.send('go',{page:this.destination});this.destination=null;this.ready=true;return;}
      if(Number.isInteger(state.page)&&state.page!==this.article.current){this.article.current=state.page;this.r.viewer.currentPageNumber=state.page;$('#reader-page',this.r.host).value=state.page;this.article.update();}
      const selection=$('.article-web-selection',this.shell);selection.hidden=!state.selection;
      if(state.selection)this.r.pendingSelection=state.selection;
    }catch(error){if(!this.closed)this.status.textContent=error.message;}
    finally{this.busy=false;}
  }
  async go(page){const state=await this.send('go',{page});if(state?.matched===0)this.status.textContent='原站段落未匹配，可在整理版定位';}
  async find(again,previous){const result=await this.send('find',{query:$('#pdf-find',this.r.host).value,again,previous});$('#find-count',this.r.host).textContent=result?`${result.current} / ${result.total}`:'0 / 0';}
  paint(){if(this.initialized)this.send('configure',this.payload()).catch(()=>{});}
  clearSelection(){this.send('clear-selection').catch(()=>{});$('.article-web-selection',this.shell).hidden=true;}
  setVisible(value){this.visible=value;if(!value&&this.initialized){this.bounds=null;this.send('bounds',{bounds:{x:0,y:0,width:0,height:0},visible:false}).catch(()=>{});}else this.schedule();}
  destroy(){this.closed=true;clearInterval(this.timer);cancelAnimationFrame(this.frame);this.resize.disconnect();this.observer.disconnect();this.unsubscribe?.();this.r.host.classList.remove('article-webmode');if(this.initialized)this.send('close').catch(()=>{});this.shell.remove();}
}
