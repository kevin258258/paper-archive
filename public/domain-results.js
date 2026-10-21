import {api,esc,toast} from './api.js';

export async function domainResults(id,{papers,reload,openPaper}){
  const scan=await api('/api/domain-scans/'+id),dialog=document.createElement('dialog');
  dialog.className='domain-results-dialog';dialog.setAttribute('aria-label','领域回扫结果');document.body.append(dialog);
  const entries=Object.values(scan.decisions).filter(d=>d.matches).sort((a,b)=>b.confidence-a.confidence);
  const render=()=>{
    dialog.innerHTML=`<div class="dialog-top"><span>回扫结果</span><button data-close aria-label="关闭回扫结果">×</button></div><p class="field-note">${scan.completed?'已完成':'进行中'} · ${Object.keys(scan.papers).length} 篇 · 高置信度自动加入，边界项可手动选择。</p><div class="scan-results-list">${entries.map((d,n)=>{
      const paper=papers().find(p=>p.id===d.paper_id),domain=scan.domains.find(v=>v.id===d.domain_id),included=(paper?.domainIds||[paper?.domain]).includes(d.domain_id);
      return `<article class="scan-result"><div class="scan-result-meta">${esc(domain.name)} · ${d.confidence>=.8?'高置信度':'待确认'} · ${Math.round(d.confidence*100)}%</div><strong>${esc(scan.titles[d.paper_id]||d.paper_id)}</strong><p>${esc(d.reason)}</p><blockquote>${esc(d.quote)}</blockquote><div><button class="text-button" data-read="${n}">查看依据 · ${d.language==='chinese'?'中':'EN'} ${d.page} ↗</button><button class="secondary" data-toggle="${n}" ${paper?.domain===d.domain_id?'disabled':''}>${paper?.domain===d.domain_id?'主领域':included?'移出此领域':'加入此领域'}</button></div></article>`;
    }).join('')||'<p class="field-note">没有匹配或待确认的论文。</p>'}</div>`;
  };
  dialog.onclick=async e=>{
    const b=e.target.closest('button');if(!b)return;e.stopPropagation();
    if(b.hasAttribute('data-close')){dialog.close();return;}
    try{
      if(b.dataset.read!==undefined){const d=entries[Number(b.dataset.read)];dialog.close();await openPaper({paper_id:d.paper_id,language:d.language,page:d.page});}
      if(b.dataset.toggle!==undefined){b.disabled=true;const d=entries[Number(b.dataset.toggle)],p=papers().find(p=>p.id===d.paper_id),included=(p.domainIds||[p.domain]).includes(d.domain_id);await api(`/api/papers/${d.paper_id}/domains/${d.domain_id}/${included?'exclude':'include'}`,{});await reload();render();}
    }catch(error){toast(error.message);b.disabled=false;}
  };
  dialog.onclose=()=>dialog.remove();render();dialog.showModal();
}
