import {api,esc,$,toast} from './api.js';
import {markdown} from './reader.js';
import {HarnessChat} from './harness-chat.js';

export class PaperChat {
  constructor(reader){this.reader=reader;}
  shell(){
    this.native=window.paperProvider==='Codex';
    if(!this.native){this.legacy=new LegacyPaperChat(this.reader);return this.legacy.shell();}
    return '<section class="chat-panel" data-panel="chat"><div id="paper-harness"></div></section>';
  }
  open(paper){
    if(!this.native)return this.legacy.open(paper);
    this.client?.close();
    this.client=new HarnessChat($('#paper-harness',this.reader.host),{
      kind:'paper',paper_id:paper.id,title:paper.title,sourceType:paper.sourceType,
      context:()=>({page:this.reader.viewer?.currentPageNumber||1,language:this.reader.language}),
      openPaper:async c=>{if(c.paper_id===paper.id)await this.reader.jump(c.language,c.page);else if(this.reader.options.openPaper)await this.reader.options.openPaper(c);else throw Error('引用不属于当前论文');},
    });
    this.client.open();
  }
  stop(){this.client?.close();this.legacy?.stop();}
  pageChanged(){this.client?.pageChanged();this.legacy?.pageChanged();}
  setSelection(value){
    if(!this.native)return this.legacy?.setSelection(value);
    this.client?.setSelection(value);$('#paper-harness textarea',this.reader.host)?.focus();
  }
}

class LegacyPaperChat {
  constructor(reader){this.reader=reader;this.drafts=new Map();this.epoch=0;}
  shell(){
    return `<section class="chat-panel" data-panel="chat">
      <div class="chat-source"><span class="status-dot"></span><span>${esc(window.paperProvider||"AI")}</span><span>当前论文</span></div>
      <div id="chat-turns" aria-live="polite"></div>
      <form id="paper-chat-form">
        <div id="chat-selection" hidden></div>
        <textarea id="paper-question" aria-label="向当前论文提问" placeholder="问这篇论文…" maxlength="4000" rows="3" required></textarea>
        <div class="chat-compose-foot"><span id="chat-page-context"></span><button class="primary" type="submit" aria-label="发送问题">↑</button></div>
        <p id="chat-error" class="error" role="alert"></p>
      </form>
    </section>`;
  }
  open(paper){
    this.stop();this.paper=paper;this.turns=[];this.snapshot='';this.selection=null;
    const root=this.reader.host;
    $('#paper-question',root).value=this.drafts.get(paper.id)||'';
    $('#paper-question',root).oninput=e=>this.drafts.set(paper.id,e.target.value);
    $('#paper-question',root).onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#paper-chat-form',root).requestSubmit();}};
    $('#paper-chat-form',root).onsubmit=e=>{e.preventDefault();this.send();};
    $('#chat-turns',root).onclick=e=>this.click(e).catch(err=>toast(err.message));
    $('#chat-selection',root).onclick=e=>{if(e.target.closest('button'))this.setSelection(null);};
    this.pageChanged();this.poll();
  }
  stop(){clearTimeout(this.timer);this.epoch++;this.paper=null;}
  pageChanged(){
    const el=$('#chat-page-context',this.reader.host);
    if(el)el.textContent=`${this.reader.language==='chinese'?'中':'EN'} · ${this.reader.viewer?.currentPageNumber||1} ${this.paper?.sourceType==='blog'?'段':'页'}`;
  }
  setSelection(value){
    this.selection=value?structuredClone(value):null;
    const el=$('#chat-selection',this.reader.host);el.hidden=!value;
    el.innerHTML=value?`<span>${esc(value.text)}</span><button type="button" aria-label="移除引用选文">×</button>`:'';
    $('#paper-question',this.reader.host).focus();
  }
  async poll(){
    const paper=this.paper,epoch=this.epoch,request=this.request=(this.request||0)+1;if(!paper)return;
    try{
      const data=await api(`/api/papers/${paper.id}/chat`);
      if(epoch!==this.epoch||request!==this.request)return;
      this.turns=data.turns;this.render();
    }catch(e){if(epoch===this.epoch)$('#chat-error',this.reader.host).textContent='对话暂时无法读取：'+e.message;}
    finally{if(epoch===this.epoch&&request===this.request){clearTimeout(this.timer);this.timer=setTimeout(()=>this.poll(),2500);}}
  }
  render(){
    const snapshot=JSON.stringify(this.turns);if(snapshot===this.snapshot)return;this.snapshot=snapshot;
    const host=$('#chat-turns',this.reader.host);
    const nearBottom=host.scrollHeight-host.scrollTop-host.clientHeight<90;
    host.innerHTML=this.turns.length?this.turns.map(t=>`<article class="chat-turn">
      <div class="chat-question">${esc(t.query)}</div>
      ${t.context.selection?`<details class="chat-context"><summary>引用选文 · ${t.context.language==='chinese'?'中':'EN'} ${t.context.page} ${this.paper?.sourceType==='blog'?'段':'页'}</summary><p>${esc(t.context.selection)}</p></details>`:''}
      ${t.status==='completed'?`<div class="chat-answer markdown">${markdown(t.result?.answer)}</div>
      ${t.result?.coverage&&!t.result.coverage.complete?'<p class="chat-notice">论文较长，本次依据部分页面回答。</p>':''}
      ${t.result?.unverified?'<p class="chat-notice">部分依据未通过逐字校验，请核对原文。</p>':''}
      <div class="chat-citations">${(t.result?.citations||[]).map((c,i)=>`<button data-citation="${t.id}:${i}" title="${esc(c.quote)}">${c.language==='original'?'EN':'中'} · ${c.page} ↗</button>`).join('')}</div>`:
      ['queued','running'].includes(t.status)?`<div class="chat-working"><span class="working">${esc(t.stage)}</span><button data-chat-cancel="${t.id}">取消</button></div>`:
      `<p class="chat-notice">${esc(t.error||t.stage)}</p><button class="text-button" data-chat-retry="${t.id}">重试 ↗</button>`}
    </article>`).join(''):`<div class="chat-empty"><span class="chat-glyph" aria-hidden="true">✳</span><h3>与论文对话</h3><p>全文、当前页、选中的段落</p><div class="chat-prompts"><button data-question="这篇论文要解决什么问题？核心方法与主要证据是什么？">问题与方法 ↗</button><button data-question="解释我正在读的这一页，指出关键概念和它与全文的关系。">解释当前页 ↗</button><button data-question="这篇论文的主要实验结论与局限是什么？请给出页码依据。">实验与局限 ↗</button></div><small>论文内容发送到设置中选择的模型服务。<br>对话保存在本机，按论文独立。</small></div>`;
    if(nearBottom||this.pendingScroll){host.scrollTop=host.scrollHeight;this.pendingScroll=false;}
    const busy=this.turns.some(t=>['queued','running'].includes(t.status));
    $('#paper-chat-form button[type=submit]',this.reader.host).disabled=busy;
  }
  async send(){
    const paper=this.paper,epoch=this.epoch,root=this.reader.host,input=$('#paper-question',root),question=input.value.trim();
    if(!paper||!question||this.sending)return;
    this.sending=true;$('#chat-error',root).textContent='';
    const b=$('#paper-chat-form button[type=submit]',root);b.disabled=true;
    try{
      const selection=this.selection;
      await api(`/api/papers/${paper.id}/chat`,{question,language:selection?.language||this.reader.language,
        page:selection?.page||this.reader.viewer?.currentPageNumber||1,selection:selection?.text||''});
      this.drafts.delete(paper.id);
      if(epoch!==this.epoch)return;
      input.value='';this.setSelection(null);this.pendingScroll=true;
      clearTimeout(this.timer);await this.poll();
    }catch(e){if(epoch===this.epoch)$('#chat-error',root).textContent=e.message;}
    finally{this.sending=false;if(epoch===this.epoch)b.disabled=this.turns.some(t=>['queued','running'].includes(t.status));}
  }
  async click(e){
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.question){$('#paper-question',this.reader.host).value=b.dataset.question;$('#paper-question',this.reader.host).focus();}
    if(b.dataset.citation){
      const [id,i]=b.dataset.citation.split(':'),cite=this.turns.find(t=>t.id===id)?.result.citations[Number(i)];
      if(cite)await this.reader.jump(cite.language,cite.page);
    }
    if(b.dataset.chatCancel||b.dataset.chatRetry){
      await api(`/api/jobs/${b.dataset.chatCancel||b.dataset.chatRetry}/${b.dataset.chatCancel?'cancel':'retry'}`,{});
      clearTimeout(this.timer);await this.poll();
    }
  }
}
