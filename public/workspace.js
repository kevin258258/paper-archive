import {api,esc,$,toast} from './api.js';
import {markdown} from './reader.js';

export class Workspace {
  constructor({papers,collections,openPaper,reload}){
    Object.assign(this,{papers,collections,openPaper,reload});this.turns=[];this.scope='';this.snapshot='';
    this.host=document.createElement('main');this.host.id='research-workspace';this.host.hidden=true;$('.app').append(this.host);
    this.host.innerHTML=`<header class="research-top"><span class="mono">WORKSPACE / 01</span><span id="global-provider">AI</span></header>
      <div class="research-heading"><div><p class="eyebrow mono">ACROSS THE PAPERS</p><h1>研究台<span class="research-star" aria-hidden="true">✳</span></h1><p>联系 · 对照 · 新问题</p></div><div class="research-orbit" aria-hidden="true"><i></i><i></i><i></i></div></div>
      <section id="global-turns" aria-live="polite"></section>
      <form id="global-form"><textarea id="global-question" aria-label="向论文库提问" placeholder="把不同论文放在一起，会发现什么？" maxlength="4000" rows="3" required></textarea><div class="global-compose-footer"><select id="global-scope" aria-label="讨论范围"><option value="">全部藏品</option></select><span id="scope-count"></span><button class="primary" type="submit" aria-label="发送全局问题">↑</button></div><p id="global-error" class="error" role="alert"></p></form>
      <p class="research-footnote">依据论文原文讨论。新想法会标注为待验证假设。</p>`;
    $('#global-form').onsubmit=e=>{e.preventDefault();this.send();};
    $('#global-question').onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#global-form').requestSubmit();}};
    $('#global-scope').onchange=e=>{this.scope=e.target.value;this.updateScope();};
    this.host.onclick=e=>this.click(e).catch(err=>toast(err.message));
    this.dialog=document.createElement('dialog');this.dialog.className='settings-dialog';document.body.append(this.dialog);
  }
  async open(){
    $('#library-main').hidden=true;document.querySelectorAll('.sidebar .active').forEach(el=>el.classList.remove('active'));this.host.hidden=false;$('#open-workspace').classList.add('active');
    const config=await api('/api/settings');$('#global-provider').textContent=config.provider==='codex'?'本机 Codex':config.model;
    $('#global-scope').innerHTML='<option value="">全部藏品</option>'+this.collections().filter(c=>!c.archived).map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if(![...$('#global-scope').options].some(o=>o.value===this.scope))this.scope='';
    $('#global-scope').value=this.scope;this.updateScope();await this.poll();$('#global-question').focus();
  }
  close(){this.host.hidden=true;$('#library-main').hidden=false;$('#open-workspace').classList.remove('active');clearTimeout(this.timer);}
  updateScope(){const group=this.collections().find(c=>c.id===this.scope);$('#scope-count').textContent=(group?group.papers.length:this.papers().length)+' 篇';}
  async poll(){
    clearTimeout(this.timer);if(this.host.hidden)return;
    try{this.turns=(await api('/api/global-chat')).turns;this.render();}catch(e){$('#global-error').textContent=e.message;}
    if(!this.host.hidden)this.timer=setTimeout(()=>this.poll(),2500);
  }
  render(){
    const snapshot=JSON.stringify(this.turns);if(snapshot===this.snapshot)return;this.snapshot=snapshot;
    $('#global-turns').innerHTML=this.turns.length?this.turns.map(t=>`<article class="research-turn"><div class="research-query"><span class="mono">Q</span><h2>${esc(t.query)}</h2><small>${esc(t.context.scope)}</small></div>${t.status==='completed'?`<div class="markdown research-answer">${markdown(t.result.answer)}</div><div class="research-sources">${t.result.citations.map((c,i)=>`<button data-global-cite="${t.id}:${i}" title="${esc(c.quote)}"><span class="mono">${String(i+1).padStart(2,'0')}</span><span>${esc(c.title)}</span><small>${c.language==='original'?'EN':'中'} ${c.page} ↗</small></button>`).join('')}</div><details class="coverage"><summary>本次阅读范围 · ${t.result.coverage.length} 篇${t.result.unverified?' · 部分依据未核验':''}</summary>${t.result.coverage.map(c=>`<p>${esc(c.title)}：${c.pages.length}/${c.total} 页${c.complete?'':'（部分正文）'}</p>`).join('')}</details>`:['queued','running'].includes(t.status)?`<div class="research-progress"><span class="working">${esc(t.stage)}</span><button class="text-button" data-global-cancel="${t.id}">取消</button></div>`:`<p class="error">${esc(t.error||t.stage)}</p><button class="text-button" data-global-retry="${t.id}">重试 ↗</button>`}</article>`).join(''):`<div class="research-starters"><button data-starter="统览我的论文库，找出三个值得连接的研究方向。明确已有证据与待验证假设。"><span class="mono">01</span><strong>寻找联系</strong><span>跨领域的共同机制 ↗</span></button><button data-starter="在我的论文中找到方法假设或实验结论存在张力的工作，给出原文依据和可做的对照实验。"><span class="mono">02</span><strong>比较分歧</strong><span>假设与实验边界 ↗</span></button><button data-starter="从库内相关论文中提出两个可行的研究问题，给出最小验证实验和可能失败的条件。不要宣称创新性已经得到验证。"><span class="mono">03</span><strong>形成问题</strong><span>从证据到最小实验 ↗</span></button></div>`;
    $('#global-form button[type=submit]').disabled=this.turns.some(t=>['queued','running'].includes(t.status));
  }
  async send(){
    const question=$('#global-question').value.trim();if(!question||this.sending)return;
    this.sending=true;$('#global-error').textContent='';$('#global-form button[type=submit]').disabled=true;
    try{const group=this.collections().find(c=>c.id===this.scope);if(group&&!group.papers.length)throw Error('这个收藏集还没有论文');await api('/api/global-chat',{question,paper_ids:group?.papers||[],scope:group?.name||'全部藏品'});$('#global-question').value='';await this.poll();$('#global-form').scrollIntoView({block:'end',behavior:'smooth'});}catch(e){$('#global-error').textContent=e.message;}finally{this.sending=false;$('#global-form button[type=submit]').disabled=this.turns.some(t=>['queued','running'].includes(t.status));}
  }
  async click(e){
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.starter){$('#global-question').value=b.dataset.starter;$('#global-question').focus();}
    if(b.dataset.globalCite){const [id,n]=b.dataset.globalCite.split(':');await this.openPaper(this.turns.find(t=>t.id===id).result.citations[Number(n)]);}
    if(b.dataset.globalCancel||b.dataset.globalRetry){await api(`/api/jobs/${b.dataset.globalCancel||b.dataset.globalRetry}/${b.dataset.globalCancel?'cancel':'retry'}`,{});await this.poll();}
  }
  async settings(){
    const config=await api('/api/settings');const native=!!window.desktop;
    this.dialog.innerHTML=`<div class="dialog-top"><span>设置</span><button data-dismiss aria-label="关闭设置">×</button></div><form id="settings-form" class="settings-form"><label>AI 接入<select name="provider"><option value="codex">本机 Codex</option><option value="api">自己的 API key</option></select></label><label>模型<input name="model" value="${esc(config.model)}" placeholder="Codex 留空沿用本机默认模型"></label><div id="api-options"><label>API 地址<input name="base_url" type="url" value="${esc(config.base_url)}" required></label><label>协议<select name="protocol"><option value="responses">Responses</option><option value="chat">Chat Completions</option></select></label><label>API key<input name="api_key" type="password" autocomplete="off" placeholder="${config.has_key?'已配置，留空保留':'填写你自己的 key'}" ${native?'':'disabled'}></label><p class="field-note">${native?'密钥使用系统密钥库保存；密钥库不可用时仅用于本次运行。':'开发模式通过 PAPER_API_KEY 环境变量提供密钥。'}</p></div><p class="field-note">${config.codex_available?'已发现本机 Codex':'未发现 Codex；安装后运行 codex login，或选择 API'}<br>论文内容会发送到所选模型服务。对话与注释保存在本机。</p><div class="settings-vault"><span>资料目录</span><code>${esc(config.vault)}</code>${native?'<button type="button" id="choose-vault" class="secondary">选择目录 ↗</button>':''}</div><p class="field-note">${config.translation_ready?'XeLaTeX 已就绪':'完整翻译需安装 XeLaTeX 与 ctex 字体包'}</p><p id="settings-error" class="error"></p><button class="primary" type="submit">保存设置</button></form>`;
    this.dialog.querySelector('[data-dismiss]').onclick=()=>this.dialog.close();
    const form=$('#settings-form',this.dialog);form.elements.provider.value=config.provider;form.elements.protocol.value=config.protocol;
    const toggle=()=>$('#api-options').hidden=form.elements.provider.value!=='api';form.elements.provider.onchange=toggle;toggle();
    if(native)$('#choose-vault').onclick=()=>window.desktop.chooseVault().catch(e=>$('#settings-error').textContent=e.message);
    form.onsubmit=async e=>{e.preventDefault();const b=$('button[type=submit]',form);b.disabled=true;try{const values=Object.fromEntries(new FormData(form));const key=values.api_key;delete values.api_key;await api('/api/settings',values);window.paperProvider=values.provider==='codex'?'Codex':values.model;if(key&&native){const result=await window.desktop.setKey(key);toast(result.persisted?'设置已保存':'密钥仅用于本次运行');}else toast('设置已保存');this.dialog.close();if(!this.host.hidden)await this.open();}catch(err){$('#settings-error').textContent=err.message;}finally{b.disabled=false;}};
    this.dialog.showModal();
  }
  async domains(paper=null){
    const registry=await api('/api/domains');
    this.dialog.innerHTML=`<div class="dialog-top"><span>${paper?'论文归属':'领域'}</span><button data-dismiss aria-label="关闭领域">×</button></div>${paper?`<p>${esc(paper.title)}</p><form id="assign-domain" class="settings-form"><label>领域<select name="domain_id">${registry.domains.filter(d=>!d.archived).map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label><button class="primary" type="submit">保存归属</button></form>`:`<div class="domain-editor-list">${registry.domains.map(d=>`<button data-edit-domain="${d.id}" class="domain-editor-item"><span class="domain-orb">◌</span><span><strong>${esc(d.name)}</strong><small>${esc(d.description||'添加收录范围，帮助自动分类')}${d.archived?' · 已归档':''}</small></span><span>↗</span></button>`).join('')}</div><form id="domain-form" class="settings-form"><input type="hidden" name="id"><label>领域名称<input name="name" placeholder="新领域" maxlength="60" required></label><label>收录范围<textarea name="description" placeholder="研究什么？哪些论文应该归入这里？" maxlength="2000" rows="3"></textarea></label><label class="archive-toggle"><input type="checkbox" name="archived">归档此领域</label><p class="field-note">自动分类读取这里的范围；已有的人工归属优先。</p><div class="dialog-footer"><button class="text-button" type="reset">新建领域</button><button class="primary" type="submit">保存领域</button></div></form>`}<p id="domain-error" class="error"></p>`;
    $('[data-dismiss]',this.dialog).onclick=()=>this.dialog.close();
    if(paper){const form=$('#assign-domain');form.elements.domain_id.value=paper.domain;form.onsubmit=async e=>{e.preventDefault();try{await api(`/api/papers/${paper.id}/domain`,{domain_id:form.elements.domain_id.value});await this.reload();this.dialog.close();toast('领域已更新');}catch(err){$('#domain-error').textContent=err.message;}};}else{
      const form=$('#domain-form');form.onreset=()=>queueMicrotask(()=>{form.elements.id.value='';form.elements.archived.checked=false;});this.dialog.querySelectorAll('[data-edit-domain]').forEach(b=>b.onclick=()=>{const d=registry.domains.find(d=>d.id===b.dataset.editDomain);for(const key of ['id','name','description'])form.elements[key].value=d[key];form.elements.archived.checked=d.archived;form.elements.name.focus();});
      form.onsubmit=async e=>{e.preventDefault();try{const data=Object.fromEntries(new FormData(form));if(!data.id)delete data.id;data.archived=form.elements.archived.checked;await api('/api/domains',data);await this.reload();this.dialog.close();await this.domains();toast('领域已保存');}catch(err){$('#domain-error').textContent=err.message;}};
    }
    this.dialog.showModal();
  }
}
