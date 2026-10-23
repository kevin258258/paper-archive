const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{
  article:data=>ipcRenderer.invoke('archive:article',data),
  onArticleShortcut:callback=>{const listener=(_,data)=>callback(data);ipcRenderer.on('archive:article-shortcut',listener);return ()=>ipcRenderer.removeListener('archive:article-shortcut',listener);},
  setKey:key=>ipcRenderer.invoke('archive:set-key',key),
  chooseVault:()=>ipcRenderer.invoke('archive:choose-vault'),
  openSessionFile:(id,path)=>ipcRenderer.invoke('archive:open-session-file',{id,path})
});
