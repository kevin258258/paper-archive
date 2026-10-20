const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('desktop',{
  setKey:key=>ipcRenderer.invoke('archive:set-key',key),
  chooseVault:()=>ipcRenderer.invoke('archive:choose-vault')
});
