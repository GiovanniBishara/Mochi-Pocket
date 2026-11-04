'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,screen,session,Menu}=require('electron');
const path=require('node:path');const fs=require('node:fs/promises');const os=require('node:os');const {createService}=require('./service.cjs');
const {restoreReceiptProfiles,findLegacyProfileDirectories}=require('./profile-storage.cjs');
const appDir=path.resolve(__dirname,'..');
const appId='io.github.giovannibishara.mochipocket';
const iconPath=path.join(appDir,'assets','mochi-windows-large-v2.ico');
// --mochi-qa (npm run prova): a separate data folder, so a trial never touches real settings, profiles or receipts.
const testDir=(process.argv.includes('--mochi-qa')||process.argv.includes('--smoke-test'))?(process.env.MOCHI_TEST_DATA_DIR||path.join(os.homedir(),'Documents','Mochi Pocket prova')):undefined;
const dataDir=testDir?path.resolve(testDir):path.join(os.homedir(),'AppData','Local','MochiPocket');
// Packaged launchers can virtualize AppData. Fiscal profiles need one shared path.
const profilePath=path.join(testDir?dataDir:path.join(os.homedir(),'.mochi-pocket'),'receipt-profiles.json');
app.setName('Mochi Pocket');app.setPath('userData',dataDir);
if(process.platform==='win32')app.setAppUserModelId(appId);
const gotLock=app.requestSingleInstanceLock();if(!gotLock){app.quit();}else{
let win,service,closing=false;
app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.focus();}});
app.whenReady().then(async()=>{
  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
  const work=screen.getPrimaryDisplay().workAreaSize;const width=Math.min(1020,work.width-40);
  win=new BrowserWindow({width,height:Math.min(760,work.height-40),frame:false,transparent:true,backgroundColor:'#00000000',resizable:false,maximizable:false,show:false,hasShadow:false,title:'Mochi Pocket',icon:iconPath,webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
  if(process.platform==='win32'){
    win.setAppDetails({appId,appIconPath:iconPath,appIconIndex:0,relaunchCommand:'"'+process.execPath+'"',relaunchDisplayName:'Mochi Pocket'});
  }
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',event=>event.preventDefault());
  win.on('close',event=>{if(service?.busy&&!closing){event.preventDefault();if(service.busy==='google'){closing=true;service.cancelGoogleConnection().then(()=>win.close()).catch(()=>{closing=false;});return;}dialog.showMessageBox(win,{type:'info',title:'Operazione in corso',message:'Mochi sta ancora lavorando.',detail:'Aspetta il risultato prima di chiudere, per conservare l’esito dell’operazione.',buttons:['Va bene']});}});
  const trusted=event=>event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame;
  const handle=(name,fn)=>ipcMain.handle('mochi:'+name,async(event,...args)=>{if(!trusted(event))throw new Error('Origine non autorizzata');try{return await fn(...args);}catch{return {ok:false,error:'Operazione non completata. Controlla i dati e riprova.'};}});
  if(!testDir)await restoreReceiptProfiles({profilePath,findLegacyDirs:()=>findLegacyProfileDirectories(os.homedir())});
  service=createService({appDir,dataDir,profilePath,outputDir:testDir?path.join(dataDir,'ricevute'):path.join(app.getPath('documents'),'Ricevute ospiti'),onProgress:value=>{if(!win.isDestroyed())win.webContents.send('mochi:progress',value);}});
  await service.initialize({inspect:false});
  handle('overview',()=>service.overview());
  handle('choose-kross',async()=>{const answer=await dialog.showOpenDialog(win,{title:'Scegli l’export prenotazioni Kross',filters:[{name:'Prenotazioni Excel',extensions:['xlsx']}],properties:['openFile']});return answer.canceled?{ok:false,canceled:true}:service.selectKross(answer.filePaths[0]);});
  handle('drop-kross',file=>service.selectKross(file));
  handle('choose-kross-folder',async()=>{const answer=await dialog.showOpenDialog(win,{title:'Trova la cartella dei calendari (quella con config.json)',properties:['openDirectory']});return answer.canceled?{ok:false,canceled:true}:service.setKrossFolder(answer.filePaths[0]);});
  handle('kross',input=>service.runKross(input));handle('alloggiati',()=>service.runAlloggiati());handle('receipt',input=>service.generateReceipt(input));
  handle('kross-report',()=>service.latestKrossReport());
  handle('kross-cancel-booking',input=>service.confirmKrossCancellation(input));
  handle('receipt-booking',input=>service.lookupReceiptBooking(input));
  handle('receipt-number',input=>service.suggestReceiptNumber(input));
  handle('tax-load',input=>service.taxLoad(input));handle('tax-save-stay',input=>service.taxSaveStay(input));
  handle('tax-quick-confirm',input=>service.taxQuickConfirm(input));
  handle('tax-save-coverage',input=>service.taxSaveCoverage(input));handle('tax-export',input=>service.taxExport(input));
  handle('tax-exclude-stay',input=>service.taxExcludeStay(input));
  handle('cleaning-load',input=>service.cleaningLoad(input));
  handle('cleaning-set-excluded',input=>service.cleaningSetExcluded(input));
  handle('kross-colors-load',input=>service.krossColorsLoad(input));
  handle('kross-colors-apply',input=>service.krossColorsApply(input));
  handle('profiles',()=>service.profileDetails());handle('save-profile',input=>service.saveProfile(input));handle('google',()=>service.reconnectGoogle());handle('google-status',()=>service.checkGoogleConnection());
  handle('google-cancel',()=>service.cancelGoogleConnection());
  handle('open-output',async id=>{const file=service.outputPath(id);if(!file)return {ok:false,error:'Il file non è disponibile in questa sessione.'};const error=await shell.openPath(file);return error?{ok:false,error:'Impossibile aprire il file.'}:{ok:true};});
  handle('open-folder',async(kind,profileId)=>{const folder=service.folderPath(kind,profileId);if(!folder)return {ok:false,error:'Scegli un profilo ricevute valido.'};await fs.mkdir(folder,{recursive:true});const error=await shell.openPath(folder);return {ok:!error,...(error?{error:'Impossibile aprire la cartella. Verifica che la cartella configurata sia raggiungibile.'}:{})};});
  handle('open-alloggiati-folder',async profileId=>{
    const folder=await service.alloggiatiFolderPath(profileId);
    if(!folder)return {ok:false,error:'Cartella schedine non configurata per questo appartamento.'};
    try{if(!(await fs.stat(folder)).isDirectory())throw Error();}
    catch{return {ok:false,error:'La cartella schedine non è disponibile. Verifica che la cartella configurata sia raggiungibile (per esempio che Google Drive sia avviato).'};}
    const error=await shell.openPath(folder);
    return error?{ok:false,error:'Impossibile aprire la cartella schedine. Verifica che la cartella configurata sia raggiungibile.'}:{ok:true};
  });
  ipcMain.on('mochi:minimize',e=>{if(trusted(e))win.minimize();});ipcMain.on('mochi:close',e=>{if(trusted(e))win.close();});
  ipcMain.on('mochi:resize',(e,height)=>{if(!trusted(e)||!Number.isFinite(height))return;const area=screen.getDisplayMatching(win.getBounds()).workArea;const target=Math.max(580,Math.min(Math.ceil(height),area.height-30));const [,h]=win.getSize();if(Math.abs(target-h)>3)win.setBounds({width,height:target});});
  await win.loadFile(path.join(__dirname,'ui','index.html'));
  if(process.argv.includes('--smoke-test')){
    await new Promise(resolve=>setTimeout(resolve,1200));const overview=await win.webContents.executeJavaScript('window.mochi.overview()');
    const image=await win.webContents.capturePage();await fs.writeFile(path.join(appDir,'smoke-test.png'),image.toPNG());
    console.log(JSON.stringify({window:{transparent:true,frameless:true},modules:{kross:overview.kross.configured,alloggiati:overview.alloggiati.configured,receipt:overview.receipt.configured},receiptProfiles:overview.receipt.profiles?.map(p=>({id:p.id,label:p.label})),renderer:await win.webContents.executeJavaScript('({title:document.title,modules:document.querySelectorAll("[data-module]").length,bridge:!!window.mochi})')}));
    closing=true;win.destroy();app.quit();
  }else if(!process.env.MOCHI_TEST_HIDE){win.show();}
}).catch(error=>{dialog.showErrorBox('Mochi Pocket','Avvio non riuscito. Controlla i file del programma e i runtime.');console.error(error.message);app.quit();});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{service?.cancelGoogleConnection().catch(()=>{});});
}
