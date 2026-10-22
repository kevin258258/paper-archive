const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{
  setKey:key=>ipcRenderer.invoke('archive:set-key',key),
  chooseVault:()=>ipcRenderer.invoke('archive:choose-vault'),
  openSessionFile:(id,path)=>ipcRenderer.invoke('archive:open-session-file',{id,path})
});
