const {WebContentsView,session,shell}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {publicURL,publicRequest}=require('./article-url.cjs');
const {installArticleOverlay}=require('./article-overlay.cjs');
const WORLD=1004;

/** The remote document has no preload, app cookies, IPC or local capabilities. */
class ArticleViews{
  constructor({window,context,katexCSS=''}){this.window=window;this.context=context;this.katexCSS=katexCSS;this.views=new Map();window.on('close',()=>this.destroy());}
  async command(data){
    if(!data||!/^[a-f0-9]{20}$/.test(data.id))throw Error('无效文章');
    if(data.command==='open')return this.open(data);
    const item=this.views.get(data.id);if(!item)return {closed:true};
    if(data.command==='close'){this.close(data.id);return {closed:true};}
    if(data.command==='bounds'){
      const bounds=data.bounds||{};
      for(const key of ['x','y','width','height'])if(!Number.isFinite(bounds[key]))throw Error('无效网页尺寸');
      const [width,height]=this.window.getContentSize(),x=Math.max(0,Math.min(width,Math.round(bounds.x))),y=Math.max(0,Math.min(height,Math.round(bounds.y)));
      item.view.setBounds({x,y,width:Math.max(0,Math.min(width-x,Math.round(bounds.width))),height:Math.max(0,Math.min(height-y,Math.round(bounds.height)))});
      if(data.visible)for(const other of this.views.values())if(other!==item)other.view.setVisible(false);
      item.view.setVisible(!!data.visible);return {};
    }
    if(data.command==='reload'){if(item.loading)throw Error('网页正在载入，可先切换到整理版');await this.load(item,data.offline===true);return this.state(item);}
    if(data.command==='snapshot'){if(item.loading||!item.ready)throw Error('请先等待网页载入');if(item.offline)throw Error('当前已是离线快照');await this.snapshot(item);return this.state(item);}
    if(data.command==='configure'){item.payload={...this.payload(data),baseURL:item.context.source_url};await this.configure(item);return this.state(item);}
    if(data.command==='go'){if(Number.isInteger(data.page))await this.evaluate(item,`globalThis.__paperArchiveArticle?.go(${data.page})`);return this.state(item);}
    if(data.command==='find'){const query=String(data.query||'').slice(0,2000);return this.evaluate(item,`globalThis.__paperArchiveArticle?.find(${JSON.stringify(query)},${data.previous===true},${data.again===true})`);}
    if(data.command==='clear-selection'){await this.evaluate(item,'globalThis.__paperArchiveArticle?.clearSelection()');return {};}
    if(data.command==='state')return this.state(item);
    throw Error('未知网页操作');
  }
  payload(data){
    if(!['original','chinese','bilingual'].includes(data.mode)||!Array.isArray(data.blocks)||data.blocks.length>10000||JSON.stringify(data.blocks).length>25_000_000)throw Error('无效网页译文');
    const blocks=data.blocks.map(b=>{
      if(!Number.isInteger(b.index)||b.index<1||typeof b.html!=='string'||typeof b.source!=='string'||b.source.length>200000||b.html.length>500000)throw Error('无效文章段落');
      return {index:b.index,source:b.source,html:b.html,tag:String(b.tag||''),translated:!!b.translated,code:!!b.code};
    });
    return {mode:data.mode,blocks,highlights:Array.isArray(data.highlights)?data.highlights.slice(0,500):[]};
  }
  async open(data){
    const payload=this.payload(data);let item=this.views.get(data.id);
    if(item){item.payload=payload;await this.configure(item);return this.state(item);}
    const context=await this.context(data.id);payload.baseURL=context.source_url;if(!publicURL(context.source_url))throw Error('文章原始地址无效');
    const partition='article-'+crypto.randomBytes(16).toString('hex'),ses=session.fromPartition(partition);
    ses.setPermissionRequestHandler((_,__,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
    ses.on('will-download',event=>event.preventDefault());
    const view=new WebContentsView({webPreferences:{session:ses,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webSecurity:true,webviewTag:false,navigateOnDragDrop:false,backgroundThrottling:true}});
    item={id:data.id,view,session:ses,payload,context,offline:false,loading:true,error:'',snapshotError:'',ready:false,closed:false,pending:new Set(),allowInitial:true};
    this.views.set(data.id,item);this.window.contentView.addChildView(view);view.setVisible(false);
    const wc=view.webContents;
    ses.webRequest.onBeforeRequest((details,callback)=>{
      // The MHTML's own file is the only local resource the guest may read.
      if(item.offline){callback({cancel:details.url!==pathToFileURL(context.snapshot_path).href&&!details.url.startsWith('data:')&&!details.url.startsWith('blob:')});return;}
      if(details.url.startsWith('data:')||details.url.startsWith('blob:')){callback({});return;}
      let done=false;const finish=allowed=>{if(done)return;done=true;clearTimeout(timer);item.pending.delete(cancel);callback({cancel:!allowed});};
      const cancel=()=>finish(false),timer=setTimeout(cancel,12000);item.pending.add(cancel);
      publicRequest(details.url).then(finish,()=>finish(false));
    });
    wc.setWindowOpenHandler(({url})=>{if(publicURL(url))publicRequest(url).then(ok=>{if(ok&&/^https?:/.test(url))shell.openExternal(url);});return {action:'deny'};});
    wc.on('will-attach-webview',event=>event.preventDefault());
    wc.on('will-navigate',(event,url)=>{
      // A link opens separately, so this tab keeps its article/context identity.
      if(item.allowInitial)return;
      const destination=new URL(url),current=new URL(wc.getURL());destination.hash='';current.hash='';
      if(destination.href!==current.href){event.preventDefault();if(/^https?:/.test(url)&&publicURL(url))publicRequest(url).then(ok=>{if(ok)shell.openExternal(url);});}
    });
    wc.on('did-fail-load',(_,code,message,__,main)=>{if(main&&code!==-3){item.error=message;item.loading=false;}});
    wc.on('before-input-event',(event,input)=>{
      if(input.type!=='keyDown'||!(input.control||input.meta)||!(['f','w','tab'].includes(input.key.toLowerCase())||input.shift&&input.key.toLowerCase()==='t'))return;
      event.preventDefault();this.window.webContents.send('archive:article-shortcut',{id:item.id,key:input.key,shift:input.shift});
    });
    // Hydration can replace source paragraphs after did-finish-load. The overlay
    // watches DOM changes and adds only newly matching, untranslated nodes.
    this.load(item,data.offline===true).catch(error=>{item.error=error.message;item.loading=false;});
    return this.state(item);
  }
  async load(item,offline=false){
    if(item.closed)return;
    item.loading=true;item.ready=false;item.error='';item.allowInitial=true;item.offline=offline;
    try{
      if(offline){if(!fs.existsSync(item.context.snapshot_path))throw Error('尚未保存网页快照，请先联网打开');await item.view.webContents.loadFile(item.context.snapshot_path);}
      else{
        await item.view.webContents.loadURL(item.context.source_url);
        // Save the original DOM before adding any Chinese overlay. Snapshot
        // failures never turn a successfully loaded online page into an error.
        if(!fs.existsSync(item.context.snapshot_path))await this.snapshot(item,false);
      }
      if(item.closed)return;
      if(this.katexCSS)await item.view.webContents.insertCSS(this.katexCSS);
      item.ready=true;await this.configure(item);item.loading=false;
    }catch(error){
      if(item.closed)return;
      if(!offline&&fs.existsSync(item.context.snapshot_path)){await this.load(item,true);item.error='原站未能连接，已打开离线快照';return;}
      item.error=error.message;item.loading=false;
    }finally{item.allowInitial=false;}
  }
  evaluate(item,code){if(item.closed||item.view.webContents.isDestroyed())return Promise.resolve(null);return item.view.webContents.executeJavaScriptInIsolatedWorld(WORLD,[{code}]).catch(()=>null);}
  async configure(item){if(!item.ready)return;await this.evaluate(item,`(${installArticleOverlay.toString()})(${JSON.stringify(item.payload)})`);}
  async state(item){
    const value=item.ready?await this.evaluate(item,'globalThis.__paperArchiveArticle?.state()'):null;
    return {...value,loading:item.loading,error:item.error,snapshotError:item.snapshotError,offline:item.offline,snapshot:fs.existsSync(item.context.snapshot_path)};
  }
  async snapshot(item,restore=true){
    const temporary=item.context.snapshot_path+'.tmp.mhtml';
    try{
      if(restore)await this.evaluate(item,'globalThis.__paperArchiveArticle?.reset()');
      await item.view.webContents.savePage(temporary,'MHTML');
      if(item.closed){fs.rmSync(temporary,{force:true});return;}
      if(fs.statSync(temporary).size>200_000_000)throw Error('网页快照超过 200 MB');
      fs.renameSync(temporary,item.context.snapshot_path);item.snapshotError='';
    }catch(error){fs.rmSync(temporary,{force:true});item.snapshotError='快照未保存：'+error.message;if(restore)throw error;}
    finally{if(restore)await this.configure(item);}
  }
  close(id){const item=this.views.get(id);if(!item)return;item.closed=true;for(const cancel of [...item.pending])cancel();item.view.setVisible(false);this.window.contentView.removeChildView(item.view);item.view.webContents.close({waitForBeforeUnload:false});item.session.webRequest.onBeforeRequest(null);item.session.removeAllListeners('will-download');item.session.clearStorageData().catch(()=>{});this.views.delete(id);}
  destroy(){for(const id of [...this.views.keys()])this.close(id);}
}
function translationCSS(root){
  const file=path.join(root,'node_modules/katex/dist/katex.min.css');if(!fs.existsSync(file))return '';
  return fs.readFileSync(file,'utf8').replace(/url\(([^)]+)\)/g,(_,raw)=>{
    const relative=raw.replace(/['"]/g,''),font=path.resolve(path.dirname(file),relative);
    if(!font.startsWith(path.join(root,'node_modules/katex/dist/fonts')+path.sep)||!fs.existsSync(font))return 'url()';
    const type=font.endsWith('.woff2')?'font/woff2':font.endsWith('.woff')?'font/woff':'font/ttf';return `url(data:${type};base64,${fs.readFileSync(font).toString('base64')})`;
  });
}
module.exports={ArticleViews,translationCSS};
