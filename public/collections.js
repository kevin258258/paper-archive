import {api,esc,$,toast} from './api.js';

export class Collections {
  constructor(onChange){
    this.items=[];this.onChange=onChange;
    this.dialog=document.createElement('dialog');this.dialog.id='collections-dialog';
    this.dialog.setAttribute('aria-label','收藏集');document.body.append(this.dialog);
    this.dialog.addEventListener('click',e=>this.click(e).catch(err=>toast(err.message)));
    this.dialog.addEventListener('submit',e=>{e.preventDefault();this.submit(e).catch(err=>toast(err.message));});
    this.dialog.addEventListener('change',e=>{
      if(e.target.matches('[name=membership]')){
        if(e.target.checked)this.chosen.add(e.target.value);else this.chosen.delete(e.target.value);
      }
    });
  }
  async load(){this.items=(await api('/api/collections')).collections;this.onChange();}
  get active(){return this.items.filter(c=>!c.archived);}
  has(paperId){return this.active.some(c=>c.papers.includes(paperId));}
  open(paper=null){
    this.paper=paper;this.chosen=new Set(this.active.filter(c=>c.papers.includes(paper?.id)).map(c=>c.id));
    this.render();this.dialog.showModal();
  }
  render(){
    const p=this.paper;
    this.dialog.innerHTML=`<div class="dialog-top"><span>${p?'收藏到':'收藏集'}</span><button data-collections-close aria-label="关闭收藏集">×</button></div>
      ${p?`<p class="membership-title">${esc(p.title)}</p>`:''}
      <div class="collection-options">${p?
        this.active.map(c=>`<label class="membership-option"><span class="collection-symbol">◌</span><span>${esc(c.name)}<small>${c.papers.length} 篇</small></span><input type="checkbox" name="membership" value="${c.id}" ${this.chosen.has(c.id)?'checked':''}></label>`).join(''):
        this.active.map(c=>`<form class="collection-edit" data-edit-collection="${c.id}"><span class="collection-symbol">◌</span><input aria-label="重命名 ${esc(c.name)}" name="name" value="${esc(c.name)}" maxlength="60" required><span class="mono">${c.papers.length}</span><button type="submit" aria-label="保存 ${esc(c.name)}">↵</button><button type="button" data-archive-collection="${c.id}" aria-label="归档 ${esc(c.name)}" title="归档">−</button></form>`).join('')}
      ${!this.active.length?'<p class="collection-empty">还没有收藏集</p>':''}</div>
      <form id="new-collection-form"><input name="name" aria-label="新收藏集名称" placeholder="新收藏集名称" maxlength="60" required autocomplete="off"><button type="submit" aria-label="创建收藏集">＋</button></form>
      ${p?'<div class="dialog-footer"><span>可同时加入多个收藏集</span><button class="primary" data-membership-save>保存</button></div>':
      this.items.some(c=>c.archived)?`<details class="archived-collections"><summary>已归档</summary>${this.items.filter(c=>c.archived).map(c=>`<div><span>${esc(c.name)}</span><button data-restore-collection="${c.id}">恢复 ↗</button></div>`).join('')}</details>`:''}`;
  }
  async submit(e){
    const form=e.target,b=$('button[type=submit]',form);b.disabled=true;
    try{
      const name=new FormData(form).get('name');
      const created=await api('/api/collections'+(form.dataset.editCollection?'/'+form.dataset.editCollection:''),{name});
      if(!form.dataset.editCollection&&this.paper)this.chosen.add(created.id);
      await this.load();this.render();if(!form.dataset.editCollection)$('[name=name]',this.dialog)?.focus();
    }finally{b.disabled=false;}
  }
  async click(e){
    const b=e.target.closest('button');if(!b)return;
    if(b.hasAttribute('data-collections-close'))this.dialog.close();
    if(b.hasAttribute('data-membership-save')){
      b.disabled=true;
      try{await api(`/api/papers/${this.paper.id}/collections`,{ids:[...this.chosen]});await this.load();this.dialog.close();toast('收藏集已更新');}
      finally{b.disabled=false;}
    }
    if(b.dataset.archiveCollection||b.dataset.restoreCollection){
      await api('/api/collections/'+(b.dataset.archiveCollection||b.dataset.restoreCollection),{archived:!!b.dataset.archiveCollection});
      await this.load();this.render();
    }
  }
}
