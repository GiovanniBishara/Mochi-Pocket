'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('mochi',{
  overview:()=>ipcRenderer.invoke('mochi:overview'),
  chooseKross:()=>ipcRenderer.invoke('mochi:choose-kross'),
  selectDroppedKross:file=>{
    let filePath;
    try{filePath=webUtils.getPathForFile(file);}catch{return Promise.resolve({ok:false,error:'Trascina un file Excel .xlsx dal computer.'});}
    if(!filePath)return Promise.resolve({ok:false,error:'Il file trascinato non è disponibile sul computer. Usa Scegli Excel.'});
    return ipcRenderer.invoke('mochi:drop-kross',filePath);
  },
  chooseKrossFolder:()=>ipcRenderer.invoke('mochi:choose-kross-folder'),
  runKross:input=>ipcRenderer.invoke('mochi:kross',input),
  latestKrossReport:()=>ipcRenderer.invoke('mochi:kross-report'),
  confirmKrossCancellation:input=>ipcRenderer.invoke('mochi:kross-cancel-booking',input),
  runAlloggiati:()=>ipcRenderer.invoke('mochi:alloggiati'),
  generateReceipt:input=>ipcRenderer.invoke('mochi:receipt',input),
  suggestReceiptNumber:input=>ipcRenderer.invoke('mochi:receipt-number',input),
  lookupReceiptBooking:input=>ipcRenderer.invoke('mochi:receipt-booking',input),
  taxLoad:input=>ipcRenderer.invoke('mochi:tax-load',input),
  taxSaveStay:input=>ipcRenderer.invoke('mochi:tax-save-stay',input),
  taxQuickConfirm:input=>ipcRenderer.invoke('mochi:tax-quick-confirm',input),
  taxSaveCoverage:input=>ipcRenderer.invoke('mochi:tax-save-coverage',input),
  taxExcludeStay:input=>ipcRenderer.invoke('mochi:tax-exclude-stay',input),
  taxExport:input=>ipcRenderer.invoke('mochi:tax-export',input),
  cleaningLoad:input=>ipcRenderer.invoke('mochi:cleaning-load',input),
  cleaningSetExcluded:input=>ipcRenderer.invoke('mochi:cleaning-set-excluded',input),
  krossColorsLoad:input=>ipcRenderer.invoke('mochi:kross-colors-load',input),
  krossColorsApply:input=>ipcRenderer.invoke('mochi:kross-colors-apply',input),
  profileDetails:()=>ipcRenderer.invoke('mochi:profiles'),
  saveProfile:profile=>ipcRenderer.invoke('mochi:save-profile',profile),
  reconnectGoogle:()=>ipcRenderer.invoke('mochi:google'),
  cancelGoogleConnection:()=>ipcRenderer.invoke('mochi:google-cancel'),
  checkGoogleConnection:()=>ipcRenderer.invoke('mochi:google-status'),
  openOutput:id=>ipcRenderer.invoke('mochi:open-output',id),
  openFolder:(kind,profileId)=>ipcRenderer.invoke('mochi:open-folder',kind,profileId),
  openAlloggiatiFolder:profileId=>ipcRenderer.invoke('mochi:open-alloggiati-folder',profileId),
  minimize:()=>ipcRenderer.send('mochi:minimize'),
  close:()=>ipcRenderer.send('mochi:close'),
  resize:height=>ipcRenderer.send('mochi:resize',height),
  onProgress:callback=>{const handler=(_event,value)=>callback(value);ipcRenderer.on('mochi:progress',handler);return()=>ipcRenderer.removeListener('mochi:progress',handler);}
});
