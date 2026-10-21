import {api,setToken,esc,$,toast} from './api.js';
import {Reader,markdown} from './reader.js';
import {Collections} from './collections.js';
import {Workspace} from './workspace.js';
import {HarnessChat} from './harness-chat.js';
import {domainResults} from './domain-results.js';
import {PaperMenu} from './paper-menu.js';

let papers=[], reading={}, waiting=[], domains=[], current=[], activePaper=null, jobs=[], drawerMode='', activeSearch=null, searchResult=null;
const doneJobs=new Set(), expandedJobs=new Map();
let jobSnapshot="", polling=false;
const state={view:localStorage.getItem('paper-view')||'A',scope:localStorage.getItem('paper-scope')==='waiting'?'waiting':'all',collection:'',domain:'',topic:'',year:'',cn:false,notes:false,query:'',ai:true,sort:'recent'};
const topics=['模型增长','循环与推理','强化学习','多模态','智能体','蒸馏','技术报告','评测'];
const byId=id=>papers.find(p=>p.id===id);
const belongs=(p,id)=>(p.domainIds||[p.domain]).includes(id);
const saved=id=>reading[id]||{};
const human=p=>saved(p.id).status||(['已读完','读完'].includes(p.human)?'已读':p.human)||'未读';
const queued=id=>waiting.find(q=>q.paper_id===id);
async function loadWaiting(){waiting=(await api('/api/waiting-list')).items;}
const number=p=>String(papers.indexOf(p)+1).padStart(3,'0');
const collections=new Collections(async()=>{
  if(state.collection&&!collections.active.some(c=>c.id===state.collection))state.collection='';
  renderCollectionNav();await loadWaiting();if(papers.length)render();reader.refreshActions();
});
function renderCollectionNav(){
  $('#collection-nav').innerHTML=collections.active.map(c=>`<button class="collection-nav-item ${state.collection===c.id?'active':''}" data-collection="${c.id}"><span class="collection-symbol">◌</span><span>${esc(c.name)}</span><span class="mono">${String(c.papers.length).padStart(2,'0')}</span></button>`).join('')||'<button class="create-collection-hint" data-manage-collections>新建收藏集 ↗</button>';
}
const reader=new Reader($('#reader'),{
  getSaved:id=>saved(id),
  collect:p=>collections.open(p),
  save:async(id,patch)=>{reading[id]=await api('/api/reading/'+id,patch);if($('#reader').hidden)render();else renderCounts();},
  started:async p=>{if(!['在读','已读'].includes(human(p))){reading[p.id]=await api('/api/reading/'+p.id,{status:'在读'});renderCounts();}},
  isQueued:id=>!!queued(id),queue:p=>changeQueue(p.id,queued(p.id)?'remove':'add'),complete:p=>markStatus(p,'已读'),menu:(e,p)=>paperMenu.open(e,byId(p.id)||p),
  onClose:()=>{render();document.body.style.overflow=drawerMode?'hidden':'';$('#drawer').inert=false;if(drawerMode)$('#drawer .close')?.focus();else $('.app').inert=false;}
});

const workspace=new Workspace({papers:()=>papers,collections:()=>collections.items,reload:async()=>{await loadLibrary();if(drawerMode==='paper'&&activePaper)detail(byId(activePaper.id));},
  openPaper:async c=>{$('.app').inert=true;await reader.open(byId(c.paper_id));await reader.jump(c.language,c.page);}});
const paperMenu=new PaperMenu({items:menuItems,action:menuAction});

function menuItems(p){
  const q=queued(p.id),main=[{label:human(p)==='在读'?'继续阅读':'阅读',action:'read'},
    {label:q?'移出待读清单':'加入待读清单',action:'queue'}];
  if(q)main.push({label:q.priority?'取消置顶':'置顶待读',action:'pin'});
  main.push({label:human(p)==='已读'?'标记未读':'标记读完',action:human(p)==='已读'?'unread':'done'},{separator:true});
  if(state.collection&&collections.active.some(c=>c.id===state.collection&&c.papers.includes(p.id)))main.push({label:'移出当前收藏集',action:'collection',value:state.collection});
  if(state.domain&&state.domain!=='unfiled'&&belongs(p,state.domain))main.push({label:'移出当前领域',action:'domain',value:state.domain,hint:p.domain===state.domain?'转为未分类':''});
  main.push({label:'收藏集',group:'collections'},{label:'领域',group:'domains'},{separator:true},{label:'论文详情',action:'details'});
  const groups={collections:{label:'收藏集',items:collections.active.map(c=>({label:c.name,action:'collection',value:c.id,checked:c.papers.includes(p.id)}))},
    domains:{label:'领域',items:domains.filter(d=>d.id!=='unfiled').map(d=>({label:d.name,action:'domain',value:d.id,checked:belongs(p,d.id),hint:p.domain===d.id?'主领域':''}))}};
  if(collections.has(p.id))groups.collections.items.push({separator:true},{label:'移出全部收藏集',action:'clear-collections'});
  groups.collections.items.push({separator:true},{label:'管理收藏集…',action:'collections'});
  groups.domains.items.push({separator:true},{label:'设置主领域…',action:'domains'});
  return {main,groups};
}
async function changeQueue(id,action){
  const result=await api('/api/waiting-list/'+id,{action});waiting=result.items;reading=result.reading;render();reader.refreshActions();
  toast(({add:'已加入待读清单',remove:'已移出待读清单',pin:'已置顶',unpin:'已取消置顶'})[action]);
}
async function markStatus(p,status){
  reading[p.id]=await api('/api/reading/'+p.id,{status});await loadWaiting();render();reader.refreshActions();
  if(drawerMode==='paper'&&activePaper?.id===p.id)detail(byId(p.id));
  toast(status==='已读'?'已读完，已移出待读清单':'已标记未读');
}
async function menuAction(p,action,value){
  if(action==='read'){if(drawerMode)closeDrawer();$('.app').inert=true;await reader.open(byId(p.id));return;}
  if(action==='details'){if(!$('#reader').hidden)await reader.close();detail(byId(p.id));return;}
  if(action==='queue')return changeQueue(p.id,queued(p.id)?'remove':'add');
  if(action==='pin')return changeQueue(p.id,queued(p.id)?.priority?'unpin':'pin');
  if(action==='done'||action==='unread')return markStatus(p,action==='done'?'已读':'未读');
  if(action==='collections'){collections.open(p);return;}
  if(action==='domains'){await workspace.domains(p);return;}
  if(action==='collection'||action==='clear-collections'){
    const ids=new Set(collections.active.filter(c=>c.papers.includes(p.id)).map(c=>c.id));
    if(action==='clear-collections')ids.clear();else if(ids.has(value))ids.delete(value);else ids.add(value);
    await api('/api/papers/'+p.id+'/collections',{ids:[...ids]});await collections.load();reader.refreshActions();toast('收藏集已更新');
  }
  if(action==='domain'){
    const included=belongs(byId(p.id),value);await api(`/api/papers/${p.id}/domains/${value}/${included?'exclude':'include'}`,{});await loadLibrary();toast(included?'已移出领域，后续回扫保留排除':'已加入领域');
  }
  if(drawerMode==='paper'&&activePaper?.id===p.id)detail(byId(p.id));
}
function waitingView(list){
  if(!list.length)return '<div class="queue-empty">没有匹配的待读论文<button class="secondary" data-scope="marked">查看已收藏 ↗</button></div>';
  return '<div class="queue-list">'+list.map((p,i)=>{
    const q=queued(p.id),r=saved(p.id),language=r.language||(p.chinese?'chinese':'original'),page=r.positions?.[language]?.page||1,total=p.pages[language]||1,progress=human(p)==='在读'?Math.min(100,100*page/total):0;
    return `<article class="queue-row" data-paper-id="${p.id}"><span class="queue-index">${q.priority?'↑':String(i+1).padStart(2,'0')}</span><div><button class="queue-title" data-read="${p.id}">${esc(p.title)}</button><div class="queue-meta">${q.priority?'<span class="queue-pinned">置顶</span>':''}<span>${human(p)==='在读'?'在读 · '+page+' / '+total:'待阅读'}</span><span>${esc(p.domainName)}</span><span>${q.source==='collection'?'收藏转入':new Date(q.added*1000).toLocaleDateString('zh-CN')}</span></div>${progress?`<div class="queue-progress"><i style="width:${progress}%"></i></div>`:''}</div><div class="queue-actions"><button class="secondary" data-read="${p.id}">${human(p)==='在读'?'继续阅读':'开始阅读'} ↗</button><button class="text-button" data-queue-done="${p.id}">读完</button><button class="text-button" data-queue-remove="${p.id}">移出</button><button class="paper-menu-trigger" data-paper-menu="${p.id}" aria-label="更多操作 ${esc(p.title)}">⋯</button></div></article>`;
  }).join('')+'</div>';
}
document.addEventListener('contextmenu',e=>{const el=e.target.closest('#collection [data-paper-id]');if(el)paperMenu.open(e,byId(el.dataset.paperId));});
document.addEventListener('keydown',e=>{if(e.key==='ContextMenu'||(e.key==='F10'&&e.shiftKey)){const el=e.target.closest('#collection [data-paper-id]');if(el)paperMenu.open(e,byId(el.dataset.paperId));}});
window.addEventListener('paper-domain-scan',async()=>{await pollJobs();showJobs();});
$('#open-workspace').onclick=()=>workspace.open().catch(e=>toast(e.message));
$('#open-settings').onclick=()=>workspace.settings().catch(e=>toast(e.message));
$('#manage-domains').onclick=()=>workspace.domains().catch(e=>toast(e.message));

async function loadLibrary(){
  const data=await api('/api/library');papers=data.papers;await loadWaiting();
  domains=(await api("/api/domains")).domains.filter(d=>!d.archived);
  for(const p of papers)p.searchText=[p.title,p.english,p.arxiv,...p.authors,p.abstract,p.summary,...p.notes.map(n=>n.text)].join(' ').toLowerCase();
  $('#domain-nav').innerHTML=domains.map(d=>`<button class="domain" data-domain="${d.id}"><span class="domain-name">${esc(d.name)}</span><span class="mono">${String(papers.filter(p=>belongs(p,d.id)).length).padStart(2,'0')}</span></button>`).join('');
  $('#topic-nav').innerHTML=topics.map(t=>`<button data-topic="${t}">${t}</button>`).join('');
  $('#mobile-domain').innerHTML='<option value="">全部领域</option>'+domains.map(d=>`<option value="${d.id}">${esc(d.name)}</option>`).join('');
  $('#mobile-topic').innerHTML='<option value="">全部主题</option>'+topics.map(t=>`<option>${t}</option>`).join('');
  $('#year').innerHTML='<option value="">全部年份</option>'+[...new Set(papers.map(p=>p.year).filter(Boolean))].sort((a,b)=>b-a).map(y=>`<option>${y}</option>`).join('');
  render();
}
function filtered(){
  const hits=new Map((searchResult?.results||[]).map((r,i)=>[r.id,{...r,index:i}]));
  const terms=state.ai?[]:state.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return papers.filter(p=>(!searchResult||hits.has(p.id))&&(!state.domain||belongs(p,state.domain))&&(!state.topic||p.topics.includes(state.topic))&&(!state.year||String(p.year)===state.year)&&(!state.cn||p.chinese)&&(!state.notes||p.notes.length)&&(!state.collection||collections.active.find(c=>c.id===state.collection)?.papers.includes(p.id))&&(state.scope!=='marked'||collections.has(p.id))&&(state.scope!=='unread'||human(p)==='未读')&&(state.scope!=='waiting'||!!queued(p.id))&&terms.every(t=>p.searchText.includes(t)))
    .sort((a,b)=>state.scope==='waiting'?((queued(b.id).priority-queued(a.id).priority)||(queued(a.id).added-queued(b.id).added)):searchResult?hits.get(a.id).index-hits.get(b.id).index:state.sort==='title'?a.title.localeCompare(b.title,'zh'):state.sort==='year'?(b.year||0)-(a.year||0):b.created.localeCompare(a.created)||(b.year||0)-(a.year||0));
}
function reason(p){const hit=searchResult?.results.find(r=>r.id===p.id);return hit?`<div class="match-reason">${esc(hit.reason)}${hit.uncertainty?`<small>${esc(hit.uncertainty)}</small>`:''}</div>`:'';}
function gallery(list){return '<div class="gallery">'+list.map(p=>`<article class="paper-card" data-paper-id="${p.id}"><button class="paper-menu-trigger" data-paper-menu="${p.id}" aria-label="更多操作 ${esc(p.title)}">⋯</button><button class="cover" data-read="${p.id}" aria-label="阅读 ${esc(p.title)}"><span class="paper-number mono">${number(p)}</span><span class="cover-mark">${collections.has(p.id)?'+':''}</span>${p.thumb?`<img src="${p.thumb}" alt="" loading="lazy">`:''}<span class="cover-bottom"></span><span class="read-affordance">阅读 ↗</span></button><div class="card-meta"><span>${p.year||'—'} / ${p.domain}</span><span>${p.pages.original||p.pages.chinese||'—'} P</span></div><button class="card-title" data-detail="${p.id}" title="${esc(p.title)}">${esc(p.title)}</button><div class="card-foot"><span>${human(p)}</span><span class="format">${p.chinese?'<span>中</span>':''}${p.notes.length?'<span>NOTE</span>':''}</span><button data-mark="${p.id}" aria-label="${collections.has(p.id)?'管理收藏':'收藏到'} ${esc(p.title)}">${collections.has(p.id)?'✓':'+'}</button></div>${reason(p)}</article>`).join('')+'</div>';}
function catalog(list){return '<table class="catalog"><thead><tr><th class="row-no">NO.</th><th>标题</th><th class="row-domain">领域</th><th class="row-year">年份</th><th class="row-star"></th></tr></thead><tbody>'+list.map(p=>`<tr data-paper-id="${p.id}"><td class="row-no">${number(p)}</td><td class="row-title"><button data-read="${p.id}">${esc(p.title)}</button><small>${esc(p.english)}</small>${reason(p)}</td><td class="row-domain">${esc(p.domainName)}</td><td class="row-year">${p.year||'—'}</td><td><button class="paper-menu-trigger" data-paper-menu="${p.id}" aria-label="更多操作 ${esc(p.title)}">⋯</button></td></tr>`).join('')+'</tbody></table>';}
function matrix(list){return '<div class="matrix"><div class="matrix-inspector" id="matrix-inspector"><strong>—</strong><span>领域 × 文献</span></div>'+domains.map(d=>{const group=list.filter(p=>belongs(p,d.id));return group.length?`<section class="matrix-group"><button class="matrix-group-label" data-domain="${d.id}">${esc(d.name)}<span>${d.id} / ${group.length}</span></button><div class="matrix-cells">${group.map(p=>`<button class="matrix-cell ${collections.has(p.id)?'marked':''}" data-read="${p.id}" data-hover="${p.id}" data-paper-id="${p.id}" aria-label="阅读 ${esc(p.title)}" title="${esc(p.title)}">${p.thumb?`<img src="${p.thumb}" alt="" loading="lazy">`:''}<span class="matrix-id">${number(p)}</span></button>`).join('')}</div></section>`:'';}).join('')+'</div>';}
function renderCounts(){
  $('#total').textContent=String(papers.length).padStart(3,'0');
  $('#marked-count').textContent=String(papers.filter(p=>collections.has(p.id)).length).padStart(2,'0');
  $('#unread-count').textContent=String(papers.filter(p=>human(p)==='未读').length).padStart(2,'0');
  $('#waiting-count').textContent=String(waiting.length).padStart(2,'0');
}
function render(){
  current=filtered();renderCounts();renderCollectionNav();
  $('#sort [value=relevance]').hidden=!searchResult;$('#sort').disabled=!!searchResult||state.scope==='waiting';$('#sort [value=queue]').hidden=state.scope!=='waiting';$('#sort').value=state.scope==='waiting'?'queue':searchResult?'relevance':state.sort;$('.view-tabs').hidden=state.scope==='waiting';$('.density').classList.toggle('disabled',state.scope==='waiting');
  const heading=state.topic||(state.domain?domains.find(d=>d.id===state.domain)?.name:state.collection?collections.active.find(c=>c.id===state.collection)?.name:state.scope==='waiting'?'待读清单':state.scope==='marked'?'已收藏':state.scope==='unread'?'未读':searchResult?'搜索结果':'全部藏品');
  $('#heading').innerHTML=`${esc(heading)}<span>${current.length}</span>`;
  $('#domain-code').textContent=state.scope==='waiting'?'/ WAITING':state.domain?'/ '+state.domain:'/ ALL';
  $('#mobile-domain').value=state.domain;$('#mobile-topic').value=state.topic;$('#year').value=state.year;
  $('#filter-cn').setAttribute('aria-pressed',state.cn);$('#filter-notes').setAttribute('aria-pressed',state.notes);
  document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('active',b.dataset.view===state.view);b.setAttribute('aria-pressed',b.dataset.view===state.view);});
  document.querySelectorAll('[data-domain]').forEach(b=>b.classList.toggle('active',b.dataset.domain===state.domain));
  document.querySelectorAll('[data-topic]').forEach(b=>b.classList.toggle('active',b.dataset.topic===state.topic));
  document.querySelectorAll('[data-scope]').forEach(b=>b.classList.toggle('active',b.dataset.scope===state.scope&&!state.collection&&!state.domain&&!state.topic));
  const chips=[];if(state.domain)chips.push(['domain',domains.find(d=>d.id===state.domain)?.name]);if(state.topic)chips.push(['topic',state.topic]);
  $('#active-filters').innerHTML=chips.map(([key,label])=>`<button data-clear="${key}">${esc(label)} ×</button>`).join('');
  $('#collection').innerHTML=state.scope==='waiting'?waitingView(current):current.length?({A:gallery,B:catalog,C:matrix}[state.view]||gallery)(current):'<div class="empty">没有匹配的论文</div>';
  $('#footer-count').textContent=`${String(current.length).padStart(3,'0')} / ${String(papers.length).padStart(3,'0')}`;
}
function reset(){
  Object.assign(state,{scope:'all',collection:'',domain:'',topic:'',year:'',cn:false,notes:false,query:''});
  $('#search').value='';activeSearch=null;searchResult=null;$('#search-status').hidden=true;render();
}
function openDrawer(mode){drawerMode=mode;$('#drawer').inert=false;$('#backdrop').hidden=false;$('#drawer').hidden=false;$('.app').inert=true;document.body.style.overflow='hidden';}
function closeDrawer(){drawerMode='';activePaper=null;$('#backdrop').hidden=true;$('#drawer').hidden=true;$('.app').inert=false;document.body.style.overflow='';$('#open-jobs').focus();}
function detail(p){
  activePaper=p;openDrawer('paper');
  const hit=searchResult?.results.find(r=>r.id===p.id);
  $('#drawer').innerHTML=`<div class="drawer-top"><span>${esc(p.arxiv||'LOCAL')}</span><button class="close" data-close aria-label="关闭详情">×</button></div><div class="drawer-cover">${p.thumb?`<img src="${p.thumb}" alt="">`:''}</div><h2>${esc(p.title)}</h2><p class="english-title">${esc(p.english)}</p><div class="detail-actions"><button class="paper-menu-trigger" data-paper-menu="${p.id}" aria-label="更多操作 ${esc(p.title)}">⋯</button><button class="primary" data-read="${p.id}">阅读 ↗</button><button class="secondary" data-mark="${p.id}">${collections.has(p.id)?'管理收藏集':'+ 收藏到'}</button></div><dl class="detail-fields"><dt>领域</dt><dd><button class="text-button" data-assign-domain="${p.id}">${esc(p.domainName)} ↗</button></dd>${p.relatedDomains?.filter(d=>d.id!==p.domain).length?`<dt>同时归入</dt><dd>${p.relatedDomains.filter(d=>d.id!==p.domain).map(d=>`<span title="${esc(d.reason)}">${esc(d.name)}</span>`).join(' · ')}</dd>`:''}<dt>作者</dt><dd>${esc(p.authors.slice(0,7).join(' · '))}</dd><dt>年份</dt><dd>${p.year||'—'}</dd><dt>阅读</dt><dd>${human(p)}</dd></dl>${hit?`<section class="summary"><div class="summary-title">匹配依据</div>${esc(hit.reason)}<blockquote>${esc(hit.evidence)}</blockquote>${hit.uncertainty?`<p>${esc(hit.uncertainty)}</p>`:''}</section>`:''}<section class="summary">${esc(p.summary||p.abstract)}</section><div class="notes-list">${p.notes.map(n=>`<button data-note="${n.key}">${n.label}<span>↗</span></button>`).join('')}</div>`;
  $('#drawer').scrollTop=0;$('#drawer .close').focus();
}
function showJobs(){
  activePaper=null;openDrawer('jobs');
  $('#drawer').innerHTML=`<div class="drawer-top"><span>任务</span><button class="close" data-close aria-label="关闭任务">×</button></div><div id="job-list"></div>`;
  jobSnapshot='';renderJobs();$('#drawer .close').focus();
}
async function openImportSession(id,kind='import'){
  const dialog=document.createElement('dialog');dialog.className='import-session-dialog';dialog.setAttribute('aria-label',kind==='domain'?'领域回扫 Codex 会话':'翻译入库 Codex 会话');
  dialog.innerHTML='<div class="dialog-top"><span>'+ (kind==='domain'?'领域回扫':'翻译入库') +' · Codex</span><button aria-label="关闭入库会话">×</button></div><section class="import-harness"></section>';
  document.body.append(dialog);dialog.showModal();
  const client=new HarnessChat($('.import-harness',dialog),{kind,
    openPaper:async c=>{dialog.close();$('.app').inert=true;await reader.open(byId(c.paper_id));await reader.jump(c.language,c.page);}});
  client.uid=id;dialog.onclose=()=>{client.close();dialog.remove();};$('.dialog-top button',dialog).onclick=()=>dialog.close();
  await client.open();
}
function renderJobs(){
  $('#job-count').textContent=jobs.filter(j=>!['completed','failed','cancelled','interrupted'].includes(j.status)).length;
  if(drawerMode!=='jobs')return;
  const snapshot=JSON.stringify([jobs,[...expandedJobs]]);if(snapshot===jobSnapshot)return;jobSnapshot=snapshot;
  const latest=jobs.filter((j,i)=>jobs.findIndex(p=>p.kind===j.kind&&p.query===j.query&&p.paper_id===j.paper_id)===i);
  $('#job-list').innerHTML=latest.length?latest.map(j=>`<article class="job"><div class="job-kind">${j.kind==='domain'?'领域回扫':j.kind==='import'?'arXiv → 文献库':j.kind==='chat'?'论文问答':j.kind==='global'?'研究台':'AI 搜索'}<span>${new Date(j.created*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></div><h3>${esc(j.query)}</h3><p class="${j.status==='failed'?'error':''}">${esc(j.error||j.result?.message||j.stage)}</p>${j.progress&&j.status==='running'?`<p class="job-progress">${esc(j.progress)}</p>`:''}${j.kind==='import'&&j.status==='completed'?`<button class="secondary" data-open-imported="${j.result?.paper_id}">打开论文 ↗</button>`:''}${j.kind==='domain'&&j.status==='completed'?`<button class="secondary" data-scan-results="${j.id}">匹配结果 ↗</button>`:''}${['import','domain'].includes(j.kind)&&j.result?.session_id?`<button class="secondary" data-import-session="${j.result.session_id}" data-session-kind="${j.kind}">Codex 会话 ↗</button>`:''}${j.kind==='search'&&j.status==='completed'?`<button class="secondary" data-open-search="${j.id}">查看结果 ↗</button>`:''}${j.kind==='chat'&&j.paper_id?`<button class="secondary" data-open-chat="${j.paper_id}">打开对话 ↗</button>`:''}${['queued','running'].includes(j.status)?`<button class="text-button" data-cancel-job="${j.id}">取消</button>`:''}${['failed','cancelled','interrupted'].includes(j.status)?`<button class="secondary" data-retry-job="${j.id}">重试 ↗</button>`:''}<button class="text-button job-log" data-job-log="${j.id}">进度</button><div class="job-events" id="events-${j.id}">${expandedJobs.get(j.id)||''}</div></article>`).join(''):'<div class="empty">暂无任务</div>';
}
async function pollJobs(){
  if(polling)return;polling=true;
  try{
    jobs=await api('/api/jobs');$('#connection').textContent='本地文献库';
    if(drawerMode==='jobs')for(const j of jobs.filter(j=>expandedJobs.has(j.id)&&(j.status==='running'||!doneJobs.has(j.id)))){
      const detail=await api('/api/jobs/'+j.id);expandedJobs.set(j.id,detail.events.map(ev=>`<p>${esc(ev.message)}</p>`).join(''));
    }
    renderJobs();
    const imported=[];
    for(const j of jobs){
      if(!['completed','failed','cancelled','interrupted'].includes(j.status)||doneJobs.has(j.id))continue;
      doneJobs.add(j.id);
      if(['import','domain'].includes(j.kind)&&j.status==='completed')imported.push(j);
      if(j.id===activeSearch){
        if(j.status==='completed'){
          searchResult=j.result;$('#search-status').innerHTML=`<span>${esc(j.result.interpretation)}</span><button id="clear-search" class="text-button">清除 ×</button>`;render();
        }else $('#search-status').innerHTML=`<span class="error">${esc(j.error||j.result?.message||j.stage)}</span><button id="retry-search" class="text-button">重试 ↗</button>`;
        $('#search-status').hidden=false;
      }
    }
    if(imported.length){await loadLibrary();toast(imported.length===1?(imported[0].result?.message||'论文已入库'):`${imported.length} 篇论文已就绪`);}
  }catch(e){$('#connection').textContent='连接中断';}finally{polling=false;}
}
function openImport(value=''){$('#import-error').textContent='';$('#arxiv-input').value=value;$('#import-dialog').showModal();$('#arxiv-input').focus();}
async function submitImport(value){
  const result=await api('/api/imports',{query:value}),ids=new Set(result.jobs.map(j=>j.id));
  $('#import-dialog').close();jobs=[...result.jobs.reverse(),...jobs.filter(j=>!ids.has(j.id))];showJobs();toast(`已提交 ${result.count} 篇论文，重复链接已合并`);
}
async function search(){
  const query=$('#search').value.trim();state.query=query;
  if(!query){reset();return;}
  if(/^(?:https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/|\d{4}\.\d{4,5}(?:v\d+)?$)/i.test(query)){
    try{await submitImport(query);}catch(e){toast(e.message);}return;
  }
  if(!state.ai){searchResult=null;render();return;}
  try{
    const job=await api('/api/jobs',{kind:'search',query});activeSearch=job.id;searchResult=null;
    Object.assign(state,{scope:'all',collection:'',domain:'',topic:'',year:'',cn:false,notes:false});
    $('#search-status').hidden=false;$('#search-status').innerHTML=`<span class="working">正在理解并检索 ${papers.length} 篇论文</span><button class="text-button" data-cancel-job="${job.id}">取消</button>`;
    render();await pollJobs();
  }catch(e){toast(e.message);}
}
document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  try{
    if(b.dataset.scanResults){await domainResults(b.dataset.scanResults,{papers:()=>papers,reload:loadLibrary,openPaper:async c=>{$('.app').inert=true;await reader.open(byId(c.paper_id));await reader.jump(c.language,c.page);}});return;}
    if(b.dataset.importSession){await openImportSession(b.dataset.importSession,b.dataset.sessionKind||'import');return;}
    if(b.dataset.paperMenu){paperMenu.open(e,byId(b.dataset.paperMenu));return;}
    if(b.dataset.queueDone){await markStatus(byId(b.dataset.queueDone),'已读');return;}
    if(b.dataset.queueRemove){await changeQueue(b.dataset.queueRemove,'remove');return;}
    if(b.dataset.assignDomain){await workspace.domains(byId(b.dataset.assignDomain));return;}
    if(b.dataset.scope||b.dataset.domain||b.dataset.collection||b.dataset.topic)workspace.close();
    if(b.dataset.read){$('.app').inert=true;$('#drawer').inert=true;await reader.open(byId(b.dataset.read));return;}
    if(b.dataset.detail){detail(byId(b.dataset.detail));return;}
    if(b.dataset.mark){collections.open(byId(b.dataset.mark));return;}
    if(b.dataset.view){state.view=b.dataset.view;localStorage.setItem('paper-view',state.view);render();return;}
    if(b.dataset.domain){if(state.scope==='waiting')state.scope='all';state.domain=state.domain===b.dataset.domain?'':b.dataset.domain;render();return;}
    if(b.dataset.topic){if(state.scope==='waiting')state.scope='all';state.topic=state.topic===b.dataset.topic?'':b.dataset.topic;render();return;}
    if(b.dataset.collection){reset();state.collection=b.dataset.collection;render();return;}
    if(b.hasAttribute('data-manage-collections')){collections.open();return;}
    if(b.dataset.scope){if(b.dataset.scope==='waiting')reset();localStorage.setItem('paper-scope',b.dataset.scope==='waiting'?'waiting':'all');state.collection='';state.scope=b.dataset.scope;state.domain='';state.topic='';render();return;}
    if(b.dataset.clear){state[b.dataset.clear]='';render();return;}
    if(b.hasAttribute('data-close')){closeDrawer();return;}
    if(b.dataset.note){const n=activePaper.notes.find(n=>n.key===b.dataset.note);$('#drawer').innerHTML=`<div class="drawer-top"><button data-detail="${activePaper.id}">← 详情</button><button class="close" data-close aria-label="关闭详情">×</button></div><article class="markdown">${markdown(n.text)}</article>`;$('#drawer').scrollTop=0;return;}
    if(b.dataset.cancelJob){await api(`/api/jobs/${b.dataset.cancelJob}/cancel`,{});await pollJobs();return;}
    if(b.dataset.retryJob){await api(`/api/jobs/${b.dataset.retryJob}/retry`,{});await pollJobs();return;}
    if(b.dataset.openImported){closeDrawer();$('.app').inert=true;await reader.open(byId(b.dataset.openImported));return;}
    if(b.dataset.openChat){closeDrawer();$('.app').inert=true;await reader.open(byId(b.dataset.openChat));reader.switchPanel('chat');return;}
    if(b.dataset.jobLog){const j=await api('/api/jobs/'+b.dataset.jobLog),html=j.events.map(ev=>`<p>${esc(ev.message)}</p>`).join('')||'<p>'+esc(j.stage)+'</p>';expandedJobs.set(j.id,html);$('#events-'+j.id).innerHTML=html;return;}
    if(b.dataset.openSearch){const j=jobs.find(j=>j.id===b.dataset.openSearch);closeDrawer();reset();state.ai=true;state.query=j.query;$('#search').value=j.query;$('#search-mode').textContent='AI';$('#search-mode').setAttribute('aria-pressed','true');searchResult=j.result;$('#search-status').hidden=false;$('#search-status').innerHTML=`<span>${esc(j.result.interpretation)}</span><button id="clear-search" class="text-button">清除 ×</button>`;render();return;}
    if(b.id==='clear-search'){reset();return;}if(b.id==='retry-search')await search();
  }catch(err){toast(err.message);}
});
document.addEventListener('mouseover',e=>{const b=e.target.closest('[data-hover]');if(b&&$('#matrix-inspector'))$('#matrix-inspector').innerHTML=`<strong>${esc(byId(b.dataset.hover).title)}</strong><span>${byId(b.dataset.hover).year||'—'}</span>`;});
document.addEventListener('focusin',e=>{if(e.target.matches('[data-hover]'))e.target.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));});
$('#search-form').onsubmit=e=>{e.preventDefault();workspace.close();search();};
$('#search').oninput=e=>{state.query=e.target.value;activeSearch=null;searchResult=null;$('#search-status').hidden=true;render();};
$('#search-mode').onclick=()=>{state.ai=!state.ai;activeSearch=null;searchResult=null;$('#search-mode').textContent=state.ai?'AI':'字';$('#search-mode').setAttribute('aria-pressed',state.ai);$('#search').placeholder=state.ai?'描述你想找的论文':'搜索标题、作者、内容';$('#search-status').hidden=true;render();};
$('#manage-collections').onclick=()=>collections.open();
$('#reset').onclick=reset;$('#filter-cn').onclick=()=>{state.cn=!state.cn;render();};$('#filter-notes').onclick=()=>{state.notes=!state.notes;render();};
$('#year').onchange=e=>{state.year=e.target.value;render();};$('#sort').onchange=e=>{state.sort=e.target.value;render();};
$('#mobile-domain').onchange=e=>{state.domain=e.target.value;render();};$('#mobile-topic').onchange=e=>{state.topic=e.target.value;render();};
$('#density').oninput=e=>document.documentElement.style.setProperty('--cols',e.target.value);
$('#backdrop').onclick=closeDrawer;$('#open-import').onclick=()=>openImport();$('#open-jobs').onclick=showJobs;
$('#import-close').onclick=()=>$('#import-dialog').close();
$('#import-form').onsubmit=async e=>{e.preventDefault();const b=$('button[type=submit]',e.target);b.disabled=true;try{await submitImport($('#arxiv-input').value);}catch(err){$('#import-error').textContent=err.message;}finally{b.disabled=false;}};
$('#refresh').onclick=async()=>{try{$('#refresh').disabled=true;const r=await api('/api/refresh',{});await loadLibrary();toast(r.warnings.length?r.warnings.join('；'):`已刷新 ${r.count} 篇论文`);}catch(e){toast(e.message);}finally{$('#refresh').disabled=false;}};
document.addEventListener('keydown',e=>{if(!$('#reader').hidden||document.querySelector('dialog[open]'))return;if(e.key==='Escape'&&drawerMode){closeDrawer();return;}if(e.key==='/'&&!e.target.closest('input,textarea,select')){e.preventDefault();$('#search').focus();}});
document.addEventListener('paste',e=>{if(e.target.closest('input,textarea,[contenteditable]')||!$('#reader').hidden)return;const value=e.clipboardData.getData('text').trim();if(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\//i.test(value)){e.preventDefault();openImport(value);}});
async function init(){
  const boot=await api('/api/bootstrap');setToken(boot.token);window.paperProvider=boot.settings.provider==='codex'?'Codex':boot.settings.model;reading=boot.reading;await collections.load();await loadLibrary();
  jobs=await api('/api/jobs');for(const j of jobs)if(['completed','failed','cancelled','interrupted'].includes(j.status))doneJobs.add(j.id);
  renderJobs();setInterval(pollJobs,2500);
}
init().catch(e=>{$('#collection').innerHTML=`<div class="empty">${esc(e.message)}</div>`;});
