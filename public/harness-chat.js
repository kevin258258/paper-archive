import {api,esc,$,toast} from './api.js';
import {markdown} from './reader.js';

const busy=s=>['starting','running','waiting'].includes(s?.status);
const efforts={none:'无',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'极高',max:'Max',ultra:'Ultra'};
let capabilities;
async function connect(){if(!capabilities)capabilities=api('/api/harness/connect',{}).catch(e=>{capabilities=null;throw e;});return capabilities;}
export function resetHarness(){capabilities=null;}

// Preserve existing links, selections and disclosure nodes while tokens arrive.
// Replacing the whole feed between mousedown and mouseup can swallow a citation click.
function patchContent(host,html){
  const template=document.createElement('template');template.innerHTML=html;
  const sync=(parent,desired)=>{
    const old=[...parent.childNodes],next=[...desired.childNodes];
    next.forEach((node,i)=>{
      const prior=old[i];
      if(!prior){parent.append(node.cloneNode(true));return;}
      if(prior.nodeType!==node.nodeType||prior.nodeName!==node.nodeName){prior.replaceWith(node.cloneNode(true));return;}
      if(node.nodeType===Node.TEXT_NODE){if(prior.nodeValue!==node.nodeValue)prior.nodeValue=node.nodeValue;return;}
      if(node.nodeType!==Node.ELEMENT_NODE||prior.isEqualNode(node))return;
      for(const attr of [...prior.attributes])if(!node.hasAttribute(attr.name))prior.removeAttribute(attr.name);
      for(const attr of node.attributes)if(prior.getAttribute(attr.name)!==attr.value)prior.setAttribute(attr.name,attr.value);
      sync(prior,node);
    });
    old.slice(next.length).forEach(node=>node.remove());
  };
  sync(host,template.content);
}

/** Shared Codex conversation surface for the reader and the whole library. */
export class HarnessChat {
  constructor(root,options){
    this.root=root;this.options=options;this.epoch=0;this.selection=null;this.drafts=new Map();
    root.classList.add('harness-chat');
    root.innerHTML=`<header class="harness-header"><span class="harness-brand">✳ <span>Codex</span></span>
      <select data-sessions aria-label="Codex 会话"><option value="">新对话</option></select>
      <button data-action="legacy" title="旧版问答记录" aria-label="查看旧版问答记录">↶</button>
      <button data-action="new" title="新对话" aria-label="新建 Codex 会话">＋</button></header>
      <div class="harness-scope"></div><div class="harness-feed" role="log" aria-label="Codex 对话"></div>
      <div class="harness-requests"></div>
      <form class="harness-composer">
        <div class="harness-attachment"></div><div class="harness-selection" hidden></div>
        <textarea aria-label="给 Codex 发消息" placeholder="给 Codex 发消息…" rows="3" maxlength="100000" required></textarea>
        <div class="harness-controls"><select data-model aria-label="Codex 模型" title="模型"><option value="">连接本机 Codex…</option></select>
          <select data-effort aria-label="推理强度" title="推理强度"><option value="">沿用本机</option></select>
          <button type="button" data-action="stop" aria-label="停止 Codex 回答" hidden>■</button>
          <button type="submit" aria-label="发送给 Codex">↑</button></div>
      </form><div class="harness-footer"><span data-status>本机 harness · 读取资料</span><span data-usage></span></div>
      <p class="harness-error error" role="alert"></p>`;
    if(options.kind==='import'){for(const action of ['new','legacy'])$('[data-action='+action+']',root).hidden=true;}
    $('form',root).onsubmit=e=>{e.preventDefault();this.send();};
    $('textarea',root).onkeydown=e=>{
      if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!busy(this.session))$('form',root).requestSubmit();}
    };
    $('textarea',root).oninput=e=>{this.drafts.set(this.uid||'new',e.target.value);};
    $('[data-model]',root).onchange=()=>this.updateEffort();
    $('[data-sessions]',root).onchange=e=>this.switchSession(e.target.value);
    root.onclick=e=>this.click(e).catch(err=>this.error(err));
  }
  async open(){
    const epoch=++this.epoch;this.closed=false;
    this.showScope();
    try{
      const [caps,list]=await Promise.all([connect(),api('/api/harness/sessions?'+new URLSearchParams({kind:this.options.kind,paper_id:this.options.paper_id||''}))]);
      if(epoch!==this.epoch)return;
      this.caps=caps;this.sessions=list.sessions;this.renderSessions();
      await this.switchSession(this.uid===undefined?(this.sessions[0]?.id||''):this.uid);
    }catch(e){if(epoch===this.epoch)this.error(e);}
  }
  close(){this.closed=true;this.epoch++;clearTimeout(this.timer);}
  error(error){$('.harness-error',this.root).textContent=error?.message||error||'';}
  renderSessions(){
    $('[data-sessions]',this.root).innerHTML=(this.options.kind==='import'?'':'<option value="">新对话</option>')+this.sessions.map(s=>`<option value="${s.id}">${esc(s.title)}</option>`).join('');
    $('[data-sessions]',this.root).value=this.uid||'';
  }
  async switchSession(uid){
    const epoch=++this.epoch;clearTimeout(this.timer);this.uid=uid;this.session=null;this.signature='';
    $('[data-sessions]',this.root).value=uid;$('textarea',this.root).value=this.drafts.get(uid||'new')||'';
    this.error('');this.setSelection(null);this.render();this.configureModels();
    if(uid)await this.poll(epoch);
  }
  configureModels(){
    if(!this.caps)return;
    const el=$('[data-model]',this.root);
    el.innerHTML=this.caps.models.map(m=>`<option value="${esc(m.model)}">${esc(m.displayName)}</option>`).join('');
    const preferred=this.session?.model||this.caps.default_model;
    el.value=this.caps.models.some(m=>m.model===preferred)?preferred:(this.caps.models.find(m=>m.isDefault)||this.caps.models[0]).model;
    this.updateEffort(this.session?.effort||this.caps.default_effort);
  }
  updateEffort(preferred=''){
    const m=this.caps?.models.find(m=>m.model===$('[data-model]',this.root).value);if(!m)return;
    const el=$('[data-effort]',this.root),choice=preferred||el.value;
    el.innerHTML=m.supportedReasoningEfforts.map(e=>`<option value="${e.reasoningEffort}" title="${esc(e.description)}">${efforts[e.reasoningEffort]||e.reasoningEffort}</option>`).join('');
    el.value=m.supportedReasoningEfforts.some(e=>e.reasoningEffort===choice)?choice:m.defaultReasoningEffort;
  }
  showScope(){
    const el=$('.harness-scope',this.root),scopes=this.options.scopes?.();
    if(this.session){
      el.innerHTML=`<span>${esc(this.session.scope)}</span><code title="本机 Codex thread ID">${esc(this.session.thread_id||'尚未开始')}</code>`;
    }else if(scopes){
      el.innerHTML=`<select data-scope aria-label="Codex 讨论范围">${scopes.map(s=>`<option value="${esc(s.id)}">${esc(s.name)} · ${s.count} 篇</option>`).join('')}</select><span>新对话</span>`;
    }else el.innerHTML='<span>当前论文</span><span>持续对话</span>';
    this.pageChanged();
  }
  pageChanged(){
    const context=this.options.context?.();
    if(this.options.kind==='import'){$('.harness-attachment',this.root).textContent='⌑ arXiv · 全文翻译、编译与视觉核验';return;}
    $('.harness-attachment',this.root).textContent=context?`⌑ 完整 PDF  ·  当前 ${context.language==='chinese'?'中':'EN'} ${context.page} 页`:'⌑ 范围内的完整 PDF  ·  正文与图表';
  }
  setSelection(value){
    this.selection=value?structuredClone(value):null;
    const el=$('.harness-selection',this.root);el.hidden=!value;
    el.innerHTML=value?`<span>${esc(value.text)}</span><button type="button" data-action="clear-selection" aria-label="移除选文">×</button>`:'';
  }
  async poll(epoch=this.epoch){
    if(!this.uid||this.closed)return;
    try{
      const s=await api('/api/harness/sessions/'+this.uid+'?after='+(this.session?.revision??''));
      if(epoch!==this.epoch)return;
      if(s.unchanged)return;
      const first=!this.session;this.session=s;
      if(first){this.configureModels();this.showScope();}
      this.render();
    }catch(e){if(epoch===this.epoch)this.error(e);}
    finally{if(epoch===this.epoch&&!this.closed){clearTimeout(this.timer);this.timer=setTimeout(()=>this.poll(epoch),busy(this.session)?450:2200);}}
  }
  render(){
    const s=this.session,signature=s?.revision??'empty';if(this.signature===signature)return;this.signature=signature;
    const feed=$('.harness-feed',this.root),bottom=feed.scrollHeight-feed.scrollTop-feed.clientHeight<100;
    const opened=new Set([...feed.querySelectorAll('details[open]')].map(el=>el.dataset.item));
    const content=s?.turns.length?s.turns.map(t=>`<article class="harness-turn"><div class="harness-user">${esc(t.question)}</div>
      ${t.context.selection?`<details class="harness-reference"><summary>选文 · ${t.context.language==='chinese'?'中':'EN'} ${t.context.page} 页</summary><p>${esc(t.context.selection)}</p></details>`:''}
      <div class="harness-turn-label">✳ Codex <span>${esc(t.model)} · ${efforts[t.effort]||t.effort}</span></div>
      ${t.items.map(i=>this.item(i,opened)).join('')}
      ${['starting','running'].includes(t.status)?'<p class="harness-working working">正在处理…</p>':''}
      ${t.status==='interrupted'?'<p class="harness-muted">已停止</p>':''}
      ${t.error?`<p class="error">${esc(t.error)}</p>`:''}
      </article>`).join(''):`<div class="harness-empty"><div class="harness-mark" aria-hidden="true">✳</div><h2>${this.options.kind==='paper'?'深入这篇论文':'从论文之间，开始。'}</h2>
      <p>${this.options.kind==='paper'?'正文、公式、图表，同一个会话。':'完整的 Codex 会话，连接你的研究。'}</p>
      <div class="harness-starters">${(this.options.kind==='paper'?[
        ['拆解方法','详细解释这篇论文的核心方法与关键公式，结合图表和实验，指出假设与局限。'],
        ['解释当前页','结合全文解释当前页的概念和公式，需要时查看原始页面图像。']
      ]:[['寻找联系','统览论文库，找出三个值得深入的联系。读取相关论文原文，区分已知证据与待验证假设。'],
      ['形成问题','比较相关论文的方法假设，提出两个值得验证的研究问题、最小实验和可能失败的条件。']])
        .map(([label,q])=>`<button data-question="${esc(q)}">${label} ↗</button>`).join('')}</div></div>`;
    patchContent(feed,content);
    if(bottom||this.scrollNext){feed.scrollTop=feed.scrollHeight;this.scrollNext=false;}
    const pending=JSON.stringify(s?.requests||[]);
    if(pending!==this.requestSignature){this.requestSignature=pending;$('.harness-requests',this.root).innerHTML=(s?.requests||[]).map(r=>this.request(r)).join('');}
    const working=busy(s);
    $('[type=submit]',this.root).hidden=working;$('[data-action=stop]',this.root).hidden=!working;
    $('[type=submit]',this.root).disabled=!this.caps||this.sending;
    $('[data-model]',this.root).disabled=working;$('[data-effort]',this.root).disabled=working;
    $('[data-status]',this.root).textContent=s?.status==='waiting'?'等待你的回复':working?'Codex 正在工作':'本机 harness · 读取资料';
    const usage=s?.usage,last=usage?.last?.totalTokens;
    $('[data-usage]',this.root).textContent=last?`${Number(last).toLocaleString()} tokens${usage.modelContextWindow?' / '+Math.round(usage.modelContextWindow/1000)+'k':''}`:'';
    if(s?.error)this.error(s.error);
    if(s?.thread_id)$('.harness-scope code',this.root)?.replaceChildren(document.createTextNode(s.thread_id));
    if(s){const option=$(`[data-sessions] option[value="${s.id}"]`,this.root);if(option)option.textContent=s.title;}
  }
  item(i,opened){
    if(i.type==='agentMessage')return `<div class="markdown harness-answer ${i.phase==='commentary'?'is-commentary':''}">${markdown(i.text)}</div>`;
    const label={reasoning:'思考摘要',commandExecution:'运行命令',dynamicToolCall:i.tool,mcpToolCall:`${i.server} · ${i.tool}`,fileChange:'文件变更',plan:'计划',webSearch:'搜索网页'}[i.type]||i.type;
    let body=i.type==='reasoning'?(i.summary?.join('\n')||i.summaryText||''):i.text||i.command||JSON.stringify(i.arguments||i.changes||{},null,2);
    if(i.aggregatedOutput)body+='\n\n'+i.aggregatedOutput;
    if(i.outputText)body+='\n\n'+i.outputText;
    return `<details class="harness-activity" data-item="${esc(i.id)}" ${opened.has(i.id)?'open':''}><summary><span class="harness-activity-icon">${i.type==='reasoning'?'◌':'⌁'}</span>${esc(label)}<span>${i.status==='inProgress'?'进行中':i.status==='failed'?'失败':'↗'}</span></summary><pre>${esc(body)}</pre></details>`;
  }
  request(r){
    const p=r.params;
    if(r.method.endsWith('requestUserInput'))return `<form class="harness-request" data-request="${r.id}"><strong>Codex 需要你的回复</strong>${p.questions.map(q=>`<label>${esc(q.question)}<input name="${esc(q.id)}" list="choices-${r.id}-${esc(q.id)}" required placeholder="填写回答或选择建议"><datalist id="choices-${r.id}-${esc(q.id)}">${(q.options||[]).map(o=>`<option value="${esc(o.label)}">${esc(o.description)}</option>`).join('')}</datalist></label>`).join('')}<button type="button" data-answer="${r.id}">回复</button></form>`;
    const item=this.session?.turns.flatMap(t=>t.items).find(i=>i.id===p.itemId);
    return `<div class="harness-request"><strong>Codex 请求授权</strong><p>${esc(p.reason||'此操作需要你的批准')}</p><pre>${esc(p.command||JSON.stringify(p.permissions||p.changes||item?.changes||{},null,2))}</pre><button data-approval="${r.id}" data-decision="decline">拒绝</button><button data-approval="${r.id}" data-decision="accept">允许这次</button></div>`;
  }
  async send(){
    const input=$('textarea',this.root),question=input.value.trim();if(!question||this.sending||busy(this.session))return;
    const epoch=this.epoch;this.sending=true;this.error('');
    try{
      if(!this.caps)throw Error('尚未连接 Codex。点击新对话重试。');
      if(!this.uid){
        const scopeId=$('[data-scope]',this.root)?.value;
        const scope=this.options.scopes?.().find(s=>s.id===scopeId);
        if(scope&&scope.count===0)throw Error('这个收藏集还没有论文');
        this.session=await api('/api/harness/sessions',{kind:this.options.kind,paper_id:this.options.paper_id,
          paper_ids:scope?.papers||[],scope:scope?.name||this.options.title||'当前论文'});
        if(epoch!==this.epoch)return;
        this.uid=this.session.id;this.sessions.unshift(this.session);this.renderSessions();this.showScope();
      }
      const context=this.options.context?.()||{};
      if(this.selection)Object.assign(context,{selection:this.selection.text,language:this.selection.language,page:this.selection.page});
      const result=await api(`/api/harness/sessions/${this.uid}/turn`,{question,context,
        model:$('[data-model]',this.root).value,effort:$('[data-effort]',this.root).value});
      if(epoch!==this.epoch)return;
      input.value='';this.drafts.delete(this.uid);this.drafts.delete('new');this.setSelection(null);
      this.session=result;this.scrollNext=true;this.render();clearTimeout(this.timer);await this.poll(epoch);
    }catch(e){if(epoch===this.epoch)this.error(e);}
    finally{this.sending=false;if(epoch===this.epoch)$('[type=submit]',this.root).disabled=false;}
  }
  async click(e){
    const link=e.target.closest('a');
    if(link){
      const url=new URL(link.href,location.href),match=url.pathname.match(/^\/read\/([a-zA-Z0-9]+)\/(original|chinese)\/(\d+)$/);
      if(url.origin===location.origin&&match){e.preventDefault();await this.options.openPaper({paper_id:match[1],language:match[2],page:Number(match[3])});return;}
      // Prevent model-generated HTML links from navigating the application itself.
      e.preventDefault();if(['http:','https:'].includes(url.protocol)&&url.origin!==location.origin)window.open(url.href,'_blank','noopener');
    }
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.question){$('textarea',this.root).value=b.dataset.question;$('textarea',this.root).focus();}
    if(b.dataset.action==='new'){await this.switchSession('');if(!this.caps)await this.open();}
    if(b.dataset.action==='legacy'){
      const data=await api(this.options.kind==='paper'?`/api/papers/${this.options.paper_id}/chat`:'/api/global-chat');
      const dialog=document.createElement('dialog');dialog.className='harness-history settings-dialog';
      dialog.innerHTML=`<div class="dialog-top"><span>旧版问答记录</span><button aria-label="关闭旧版记录">×</button></div>`+
        (data.turns.map(t=>`<article class="harness-turn"><div class="harness-user">${esc(t.query)}</div><div class="markdown">${markdown(t.result?.answer||t.error||t.stage)}</div></article>`).join('')||'<p>没有旧版记录。</p>');
      $('button',dialog).onclick=()=>dialog.close();dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();
    }
    if(b.dataset.action==='clear-selection')this.setSelection(null);
    if(b.dataset.action==='stop'){await api(`/api/harness/sessions/${this.uid}/interrupt`,{});await this.poll();}
    if(b.dataset.approval||b.dataset.answer){
      const payload={request_id:b.dataset.approval||b.dataset.answer};
      if(b.dataset.answer)payload.answers=Object.fromEntries(new FormData(b.closest('form')));
      else payload.decision=b.dataset.decision;
      b.disabled=true;try{await api(`/api/harness/sessions/${this.uid}/respond`,payload);await this.poll();}finally{b.disabled=false;}
    }
  }
}
