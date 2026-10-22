import {Reader} from './reader.js';
import {api,esc,$,toast} from './api.js';

/** Each tab owns its live viewer, selection, composer draft and reading state. */
export class ReaderTabs {
  constructor(host,options){
    this.host=host;this.options=options;this.tabs=[];this.closed=[];this.serial=Promise.resolve();
    host.className='reading-workspace';host.innerHTML='<div class="reading-tab-panes"></div>';
    this.bar=document.createElement('nav');this.bar.className='reading-tab-strip';this.bar.setAttribute('aria-label','阅读标签页');this.bar.hidden=true;
    document.body.prepend(this.bar);
    this.bar.addEventListener('click',e=>{
      const close=e.target.closest('[data-close-tab]'),tab=e.target.closest('[data-tab]');
      if(close)this.enqueue(()=>this.closeTab(close.dataset.closeTab));
      else if(tab)this.enqueue(()=>this.activate(tab.dataset.tab));
      else if(e.target.closest('[data-library]'))this.enqueue(()=>this.close());
    });
    this.bar.addEventListener('auxclick',e=>{const tab=e.target.closest('[data-tab]');if(e.button===1&&tab){e.preventDefault();this.enqueue(()=>this.closeTab(tab.dataset.tab));}});
    this.bar.addEventListener('dragstart',e=>{const tab=e.target.closest('[data-tab]');if(tab)e.dataTransfer.setData('application/paper-reader-tab',tab.dataset.tab);});
    this.bar.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('application/paper-reader-tab'))e.preventDefault();});
    this.bar.addEventListener('drop',e=>{
      const target=e.target.closest('[data-tab]'),uid=e.dataTransfer.getData('application/paper-reader-tab');if(!target||!uid)return;e.preventDefault();
      const a=this.tabs.findIndex(t=>t.id===uid),b=this.tabs.findIndex(t=>t.id===target.dataset.tab);if(a<0||b<0)return;
      this.tabs.splice(b,0,this.tabs.splice(a,1)[0]);this.render();this.persist();
    });
    document.addEventListener('keydown',e=>{
      if(!(e.ctrlKey||e.metaKey)||document.querySelector('dialog[open]'))return;
      if(e.key==='Tab'&&this.tabs.length){e.preventDefault();const i=this.tabs.findIndex(t=>t.id===this.active);this.enqueue(()=>this.activate(this.tabs[(i+(e.shiftKey?-1:1)+this.tabs.length)%this.tabs.length].id));}
      else if(e.key.toLowerCase()==='w'&&!host.hidden&&this.active){e.preventDefault();this.enqueue(()=>this.closeTab(this.active));}
      else if(e.shiftKey&&e.key.toLowerCase()==='t'&&this.closed.length){e.preventDefault();this.open(this.closed.pop());}
    });
  }
  enqueue(work){const result=this.serial.then(work);this.serial=result.catch(e=>toast(e.message));return result;}
  get current(){return this.tabs.find(t=>t.id===this.active)?.reader;}
  get paper(){return this.current?.paper;}
  get viewer(){return this.current?.viewer;}
  get language(){return this.current?.language;}
  render(){
    this.bar.hidden=!this.tabs.length;document.body.classList.toggle('has-reader-tabs',!!this.tabs.length);
    this.bar.innerHTML=`<button class="reader-library-tab ${this.host.hidden?'active':''}" data-library aria-label="回到文献库">▦ <span>文献库</span></button><div class="reader-tab-list" role="tablist">${this.tabs.map(t=>`<div class="reader-browser-tab ${!this.host.hidden&&this.active===t.id?'active':''}" draggable="true" data-tab="${t.id}" role="tab" tabindex="0" aria-selected="${!this.host.hidden&&this.active===t.id}" aria-label="阅读标签：${esc(t.paper.title)}"><span class="reader-tab-icon">${t.paper.sourceType==='blog'?'↗':'▤'}</span><span class="reader-tab-title">${esc(t.paper.title)}</span><button data-close-tab="${t.id}" aria-label="关闭标签：${esc(t.paper.title)}">×</button></div>`).join('')}</div><button data-library class="reader-new-tab" aria-label="添加阅读标签页" title="从文献库打开另一篇">＋</button>`;
    this.bar.querySelectorAll('[role=tab]').forEach(el=>el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();this.enqueue(()=>this.activate(el.dataset.tab));}});
    this.bar.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  persist(){
    const data={tabs:this.tabs.map(t=>t.id),active:this.host.hidden?null:this.active};
    this.saves=(this.saves||Promise.resolve()).catch(()=>{}).then(()=>api('/api/reader-workspace',data)).catch(e=>toast('阅读标签页保存失败：'+e.message));
    return this.saves;
  }
  async restore(papers){
    const data=await api('/api/reader-workspace');
    for(const uid of data.tabs){const paper=papers.find(p=>p.id===uid);if(paper)this.tabs.push({id:uid,paper});}
    this.render();
    if(data.active&&this.tabs.some(t=>t.id===data.active))await this.enqueue(()=>this.activate(data.active));
  }
  open(paper){
    return this.enqueue(async()=>{
      if(!paper)throw Error('论文尚未进入索引，请刷新文献库');
      if(!this.tabs.some(t=>t.id===paper.id))this.tabs.push({id:paper.id,paper});
      await this.activate(paper.id);
    });
  }
  async activate(uid){
    const tab=this.tabs.find(t=>t.id===uid);if(!tab)return;
    if(this.current&&this.active!==uid)await this.current.flush();
    for(const item of this.tabs)if(item.reader)item.reader.host.hidden=true;
    this.active=uid;this.host.hidden=false;$('.app').inert=true;document.body.style.overflow='hidden';
    if(!tab.reader){
      const pane=document.createElement('section');pane.className='reader-pane';pane.hidden=true;$('.reading-tab-panes',this.host).append(pane);
      tab.reader=new Reader(pane,{...this.options,onBack:()=>this.close(),openPaper:async c=>{const paper=this.options.findPaper(c.paper_id);if(!paper)throw Error('引用文献不在库中');await this.open(paper);await this.jump(c.language,c.page);}});
      try{await tab.reader.open(tab.paper);}catch(error){await tab.reader.dispose();tab.reader=null;this.tabs=this.tabs.filter(t=>t!==tab);this.render();if(!this.tabs.length)await this.close();throw error;}
    }
    tab.reader.host.hidden=false;tab.reader.viewer?.update?.();
    if(['auto','page-width','page-fit'].includes(tab.reader.viewer?.currentScaleValue))tab.reader.viewer.currentScaleValue=tab.reader.viewer.currentScaleValue;
    tab.reader.chat.pageChanged();this.render();this.persist();
  }
  async close(){
    if(this.current)await this.current.flush();
    for(const tab of this.tabs)if(tab.reader)tab.reader.host.hidden=true;
    this.host.hidden=true;this.render();this.options.onClose();this.persist();
  }
  async closeTab(uid){
    const index=this.tabs.findIndex(t=>t.id===uid);if(index<0)return;
    const tab=this.tabs[index];await tab.reader?.dispose();this.closed.push(tab.paper);this.tabs.splice(index,1);
    if(uid===this.active){this.active=null;if(this.tabs.length&&!this.host.hidden)await this.activate(this.tabs[Math.min(index,this.tabs.length-1)].id);else await this.close();}
    this.render();this.persist();
  }
  jump(language,page){return this.current?.jump(language,page);}
  switchPanel(...args){return this.current?.switchPanel(...args);}
  refreshActions(){for(const t of this.tabs)t.reader?.refreshActions();}
}
