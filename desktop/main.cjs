const {app,BrowserWindow,ipcMain,dialog,shell,safeStorage,session}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
let window, backend, origin='', desktopToken='', config={}, shuttingDown=false, apiKey='';
const root=path.join(__dirname,'..');
app.setPath('userData',path.join(app.getPath('appData'),'paper-archive'));
if(process.platform==='linux')app.setDesktopName('paper-archive.desktop');
const userData=()=>app.getPath('userData');
const configPath=()=>path.join(userData(),'desktop.json');
function saveConfig(){fs.mkdirSync(userData(),{recursive:true});fs.writeFileSync(configPath(),JSON.stringify(config,null,2),{mode:0o600});}
async function keyAvailable(){
  if(process.platform==='linux'&&safeStorage.getSelectedStorageBackend()==='basic_text')return false;
  return safeStorage.isAsyncEncryptionAvailable?await safeStorage.isAsyncEncryptionAvailable():safeStorage.isEncryptionAvailable();
}
async function readKey(){
  const file=path.join(userData(),'api-key.enc');
  if(!fs.existsSync(file)||!await keyAvailable())return '';
  try{const raw=fs.readFileSync(file);return safeStorage.decryptStringAsync?(await safeStorage.decryptStringAsync(raw)).result:safeStorage.decryptString(raw);}catch{return '';}
}
function validSender(event){if(!event.senderFrame||new URL(event.senderFrame.url).origin!==origin)throw Error('Untrusted sender');}
async function selectVault(){
  const result=await dialog.showOpenDialog(window,{title:'选择论文资料目录',defaultPath:config.vault||app.getPath('documents'),properties:['openDirectory','createDirectory']});
  if(result.canceled)return false;config.vault=result.filePaths[0];saveConfig();return true;
}
async function startBackend(){
  if(backend){backend.kill();backend=null;}
  const token=desktopToken=crypto.randomBytes(32).toString('hex');
  const env={...process.env,PAPER_VAULT_ROOT:config.vault,PAPER_READER_STATE:path.join(config.vault,'.paper-archive','state'),PAPER_READER_PORT:'0',PAPER_DESKTOP_TOKEN:token,PAPER_API_KEY:apiKey||process.env.PAPER_API_KEY||process.env.OPENAI_API_KEY||''};
  // Finder/desktop launchers may omit the user's CLI directories.
  env.PATH=[path.join(app.getPath('home'),'.local','bin'),path.join(app.getPath('home'),'.cargo','bin'),env.PATH||''].join(path.delimiter);
  let command,args;
  if(app.isPackaged){command=path.join(process.resourcesPath,'backend',process.platform==='win32'?'paper-backend.exe':'paper-backend');args=[];}
  else{command=process.env.PAPER_PYTHON||(fs.existsSync(path.join(root,'.venv','bin','python'))?path.join(root,'.venv','bin','python'):'python3');args=[path.join(root,'server.py')];}
  const child=spawn(command,args,{env,stdio:['pipe','pipe','pipe'],windowsHide:true});backend=child;child.stderr.on('data',()=>{});
  const ready=await new Promise((resolve,reject)=>{
    let buffer='';const timer=setTimeout(()=>reject(Error('资料库启动超时')),120000);
    child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);try{const msg=JSON.parse(line);if(msg.ready){clearTimeout(timer);resolve(msg);}}catch{}}});
    child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);reject(Error('后端未能启动（'+code+'）'));});
  });
  origin=`http://127.0.0.1:${ready.port}`;
  session.defaultSession.webRequest.onBeforeSendHeaders({urls:[origin+'/*']},(details,callback)=>{details.requestHeaders['X-Desktop-Token']=token;callback({requestHeaders:details.requestHeaders});});
  // Protect local PDFs and key configuration from non-app pages and subframes.
  session.defaultSession.setPermissionRequestHandler((_,__,callback)=>callback(false));
  session.defaultSession.setPermissionCheckHandler(()=>false);
  child.stderr.on('data',()=>{});
  child.on('exit',()=>{if(!shuttingDown&&backend===child)dialog.showErrorBox('资料库服务已停止','请关闭并重新打开应用。已保存的批注与收藏不受影响。');});
}
async function openWindow(){
  window=new BrowserWindow({width:1480,height:960,minWidth:900,minHeight:620,icon:path.join(__dirname,'icons/icon.png'),backgroundColor:'#f3f3ef',title:'藏 · Paper Archive',autoHideMenuBar:true,show:false,
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  window.webContents.setWindowOpenHandler(({url})=>{
    const parsed=new URL(url), match=parsed.pathname.match(/^\/file\/([a-zA-Z0-9]+)\/(original|chinese)$/);
    if(parsed.origin===origin&&match){
      fetch(origin+'/api/file-location/'+match[1]+'/'+match[2],{headers:{'X-Desktop-Token':desktopToken}})
        .then(r=>{if(!r.ok)throw Error('无法读取 PDF 路径');return r.json();})
        .then(data=>shell.openPath(data.path)).then(error=>{if(error)throw Error(error);})
        .catch(error=>dialog.showErrorBox('无法打开 PDF',error.message));
    }else if(/^https?:\/\//.test(url))shell.openExternal(url);
    return {action:'deny'};
  });
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==origin){event.preventDefault();if(/^https?:\/\//.test(url))shell.openExternal(url);}});
  window.once('ready-to-show',()=>window.show());
  await window.loadURL(origin);
  console.log("Paper Archive window loaded");
}
if(!app.requestSingleInstanceLock())app.quit();
else{
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.whenReady().then(async()=>{
  if(fs.existsSync(configPath()))config=JSON.parse(fs.readFileSync(configPath(),'utf8'));
  if(process.env.PAPER_VAULT_ROOT){config.vault=path.resolve(process.env.PAPER_VAULT_ROOT);saveConfig();}
  if(!config.vault||!fs.existsSync(config.vault)){if(!await selectVault()){app.quit();return;}}
  apiKey=await readKey();
  ipcMain.handle('archive:set-key',async(event,key)=>{
    validSender(event);if(typeof key!=='string'||key.length>10000||!key.trim())throw Error('无效密钥');
    apiKey=key.trim();let persisted=false;const file=path.join(userData(),'api-key.enc');
    if(await keyAvailable()){const encrypted=safeStorage.encryptStringAsync?await safeStorage.encryptStringAsync(apiKey):safeStorage.encryptString(apiKey);fs.writeFileSync(file,encrypted,{mode:0o600});persisted=true;}
    else if(fs.existsSync(file))fs.unlinkSync(file);
    backend.stdin.write(JSON.stringify({api_key:apiKey})+'\n');return {persisted};
  });
  ipcMain.handle('archive:open-session-file',async(event,data)=>{
    validSender(event);if(!data||!/^[a-f0-9]+$/.test(data.id)||typeof data.path!=='string')throw Error('无效文件');
    const response=await fetch(origin+'/api/harness/sessions/'+data.id+'/file-location?path='+encodeURIComponent(data.path),{headers:{'X-Desktop-Token':desktopToken}});
    if(!response.ok)throw Error('文件不在当前资料工作区中或不存在');const file=await response.json();const error=await shell.openPath(file.path);if(error)throw Error(error);
  });
  ipcMain.handle('archive:choose-vault',async event=>{validSender(event);const rows=await fetch(origin+'/api/jobs',{headers:{'X-Desktop-Token':desktopToken}}).then(r=>r.json());const activity=await fetch(origin+'/api/harness/activity',{headers:{'X-Desktop-Token':desktopToken}}).then(r=>r.json());const response=activity.active||rows.some(r=>r.status==='running'||r.status==='queued');if(response)throw Error('请先等待或取消正在运行的任务');if(await selectVault()){app.relaunch();app.quit();}});
  await startBackend();await openWindow();
}).catch(error=>{dialog.showErrorBox('无法启动 Paper Archive',String(error.message));app.quit();});
app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length&&origin)openWindow();});
app.on('before-quit',()=>{shuttingDown=true;if(backend)backend.kill();});
app.on('window-all-closed',()=>app.quit());
}
