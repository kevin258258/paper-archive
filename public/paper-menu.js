import {esc,toast} from './api.js';

/** One context menu shared by cards, rows, the queue and the reader toolbar. */
export class PaperMenu{
  constructor({items,action}){
    this.items=items;this.action=action;
    document.addEventListener('pointerdown',e=>{if(this.root&&!this.root.contains(e.target))this.close(false);},true);
    document.addEventListener('keydown',e=>this.key(e),true);
    document.addEventListener('scroll',e=>{if(this.root&&!this.root.contains(e.target))this.close(false);},true);
    window.addEventListener('resize',()=>this.close(false));window.addEventListener('blur',()=>this.close(false));
  }
  close(restore=true){this.root?.remove();this.root=null;if(restore&&this.anchor?.isConnected)this.anchor.focus({preventScroll:true});}
  row(item){
    if(item.separator)return '<div class="paper-menu-separator" role="separator"></div>';
    if(item.group)return `<button role="menuitem" data-group="${item.group}" aria-haspopup="menu" aria-expanded="false">${esc(item.label)}<span>›</span></button>`;
    const check=item.checked!==undefined;
    return `<button role="${check?'menuitemcheckbox':'menuitem'}" ${check?`aria-checked="${item.checked}"`:''} data-action="${item.action}" data-value="${esc(item.value||'')}" ${item.disabled?'disabled':''}><span>${check?`<i>${item.checked?'✓':''}</i>`:''}${esc(item.label)}</span>${item.hint?`<small>${esc(item.hint)}</small>`:''}</button>`;
  }
  open(e,paper){
    e.preventDefault();this.close(false);this.paper=paper;this.anchor=e.target.closest('button,[tabindex]');
    const spec=this.items(paper);this.groups=spec.groups;
    this.root=document.createElement('div');this.root.className='paper-menu';this.root.setAttribute('role','menu');this.root.setAttribute('aria-label','论文操作');
    this.root.innerHTML=`<div class="paper-menu-title">${esc(paper.title)}</div>${spec.main.map(i=>this.row(i)).join('')}${Object.entries(spec.groups).map(([key,group])=>`<div class="paper-submenu" role="menu" aria-label="${esc(group.label)}" data-panel="${key}" hidden>${group.items.map(i=>this.row(i)).join('')}</div>`).join('')}`;
    document.body.append(this.root);
    const anchor=this.anchor?.getBoundingClientRect(),x=e.type==='contextmenu'?e.clientX:anchor?.left??e.clientX,y=e.type==='contextmenu'?e.clientY:anchor?.bottom??e.clientY;
    this.root.style.left=Math.max(8,Math.min(x,innerWidth-this.root.offsetWidth-8))+'px';this.root.style.top=Math.max(8,Math.min(y,innerHeight-this.root.offsetHeight-8))+'px';
    this.root.onpointerover=event=>{const b=event.target.closest('button');if(!b||b.closest('[role=menu]')!==this.root)return;if(b.dataset.group)this.openGroup(b);else this.hideGroups();};
    this.root.onclick=async event=>{
      const b=event.target.closest('button');if(!b||b.disabled)return;event.stopPropagation();
      if(b.dataset.group){this.openGroup(b);return;}
      const action=b.dataset.action,value=b.dataset.value;this.close();
      try{await this.action(paper,action,value);}catch(error){toast(error.message);}
    };
    this.buttons(this.root)[0]?.focus({preventScroll:true});
  }
  buttons(panel){return [...panel.querySelectorAll('button:not(:disabled)')].filter(b=>b.closest('[role=menu]')===panel);}
  hideGroups(){if(!this.root)return;this.root.querySelectorAll('.paper-submenu').forEach(p=>p.hidden=true);this.root.querySelectorAll('[data-group]').forEach(b=>b.setAttribute('aria-expanded','false'));}
  openGroup(button){
    this.hideGroups();const panel=this.root.querySelector(`[data-panel="${button.dataset.group}"]`);panel.hidden=false;button.setAttribute('aria-expanded','true');this.groupButton=button;
    const main=this.root.getBoundingClientRect(),row=button.getBoundingClientRect();panel.style.left=(main.right+panel.offsetWidth+8<innerWidth?main.right+5:Math.max(8,main.left-panel.offsetWidth-5))+'px';panel.style.top=Math.max(8,Math.min(row.top-6,innerHeight-panel.offsetHeight-8))+'px';
    return panel;
  }
  key(e){
    if(!this.root)return;const current=document.activeElement,panel=current.closest('[role=menu]')||this.root,buttons=this.buttons(panel),index=buttons.indexOf(current);
    if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const n=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;buttons[n]?.focus({preventScroll:true});buttons[n]?.scrollIntoView({block:'nearest'});}
    if(e.key==='ArrowRight'&&current.dataset.group){e.preventDefault();this.buttons(this.openGroup(current))[0]?.focus({preventScroll:true});}
    if((e.key==='ArrowLeft'||e.key==='Escape')&&panel!==this.root){e.preventDefault();e.stopPropagation();this.hideGroups();this.groupButton?.focus({preventScroll:true});}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.close();}
    if(e.key==='Tab')this.close(false);
  }
}
