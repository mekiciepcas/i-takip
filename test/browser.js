import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile,writeFile,mkdir,readdir,stat } from 'node:fs/promises';
import { resolve,sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { database,topic,root,freePort } from './fixture.js';
import { PgStore } from '../server/store.js';
import { Auth,createUser } from '../server/auth.js';
import { createApp } from '../server/http.js';
const output=resolve(root,'test-output');await mkdir(output,{recursive:true});
const db=await database(),store=new PgStore(db.pool);await store.initialize();
await createUser(db.pool,'deniz','synthetic-password-123');
const port=await freePort(),origin='http://127.0.0.1:'+port;
const server=createApp({store,auth:new Auth(db.pool),publicDir:resolve(root,'public'),origin});
await new Promise(r=>server.listen(port,'127.0.0.1',r));
let browser;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.locator('#username').fill('deniz');await page.locator('#password').fill('synthetic-password-123');await page.locator('#loginSubmit').click();
  await page.waitForFunction(()=>!document.querySelector('#loginDialog').open);
  await page.route('**/api/data',async route=>{
    if(route.request().method()==='PUT'){assert((await route.fetch()).ok());await route.abort();}
    else await route.continue();
  });
  await page.locator('#quickTopic').fill('IoT platform geçişi');await page.locator('#quickOwner').fill('Deniz Yılmaz');await page.locator('#quickAdd button').click();
  await page.locator('#checkCommit').waitFor({state:'visible'});await page.unroute('**/api/data');await page.locator('#checkCommit').click();
  await page.waitForFunction(()=>document.querySelector('#checkCommit').hidden);
  assert.equal(await page.locator('#quickTopic').inputValue(),'');
  assert.equal((await store.read()).data.topics.length,1);
  await page.locator('[data-field="topic"]').waitFor();
  await page.locator('[data-field="owner"]').fill('Ece Demir');await page.locator('[data-field="owner"]').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#gridStatus').textContent.includes('Tüm değişiklikler'));
  assert.equal((await store.read()).data.topics[0].owner,'Ece Demir');
  await page.locator('[data-weekly-add]').click();await page.locator('#weeklyNote').fill('Geçiş testleri tamamlandı.');await page.locator('#saveWeeklyBtn').click();
  await page.waitForFunction(()=>!document.querySelector('#weeklyDialog').open);
  assert.equal((await store.read()).data.topics[0].updates.length,1);
  await page.locator('[data-quick="weekly"]').click();assert(await page.locator('#emptyState').isVisible());await page.locator('[data-quick="all"]').click();
  // A lost HTTP response is verified by operation ID, without duplicating a note.
  await page.route('**/api/data',async route=>{
    if(route.request().method()==='PUT'){const response=await route.fetch();assert(response.ok());await route.abort();}
    else await route.continue();
  });
  await page.locator('[data-field="current"]').fill('Yanıt kaybı denemesi');await page.locator('[data-field="current"]').press('Enter');
  await page.locator('#checkCommit').waitFor({state:'visible'});await page.unroute('**/api/data');await page.locator('#checkCommit').click();
  await page.waitForFunction(()=>document.querySelector('#checkCommit').hidden);
  assert.equal((await store.read()).data.topics[0].updates.length,2);
  // Second browser account/context: read shared state, then receive updates.
  const other=await browser.newPage();await other.goto(origin);await other.locator('#username').fill('deniz');await other.locator('#password').fill('synthetic-password-123');await other.locator('#loginSubmit').click();
  await other.locator('[data-field="topic"]').waitFor();
  await page.locator('[data-field="owner"]').fill('Yeni sorumlu');await page.locator('[data-field="owner"]').press('Enter');
  await page.waitForFunction(()=>document.querySelector('#gridStatus').textContent.includes('Tüm değişiklikler'));
  await other.waitForFunction(()=>document.querySelector('[data-field="owner"]').value==='Yeni sorumlu');
  let resolveReportDownload;const reportDownload=new Promise(r=>resolveReportDownload=r);
  context.once('page',p=>{p.on('download',resolveReportDownload);p.on('pageerror',e=>console.log('REPORT ERROR:',e.message));p.on('console',m=>{if(m.type()==='error')console.log('REPORT CONSOLE:',m.text());});});
  const popupPromise=page.waitForEvent('popup');await page.locator('#htmlReportBtn').click();const report=await popupPromise;
  let reportTimer;
  const download=await Promise.race([reportDownload,new Promise((_,reject)=>{reportTimer=setTimeout(()=>reject(new Error('Report download timeout')),10000);})]).finally(()=>clearTimeout(reportTimer));await download.saveAs(resolve(output,'yonetici-raporu.html'));
  assert((await readFile(resolve(output,'yonetici-raporu.html'),'utf8')).includes('IoT platform'));
  await page.screenshot({path:resolve(output,'postgres-arayuz.png'),fullPage:true});
  assert.deepEqual(errors,[]);
  console.log('PASS browser/PostgreSQL: login, autosave, weekly history, filters, two contexts, lost response, report download');

  // file:// runs the production adapter; only the OS directory chooser is replaced
  // with test handles backed by a dedicated real test directory.
  const directory=resolve(root,'test-data','json-'+randomUUID());await mkdir(directory,{recursive:true});
  await writeFile(resolve(directory,'mevcut.json'),JSON.stringify({version:1,sheets:['Konular'],topics:[topic('local-1')]}));
  const local=await browser.newContext({viewport:{width:1440,height:1000},acceptDownloads:true});
  await local.exposeBinding('__disk',async(_,action,name='',value)=>{
    const path=resolve(directory,name);if(path!==directory&&!path.startsWith(directory+sep))throw new Error('Test path rejected');
    if(action==='read')return readFile(path,'utf8');
    if(action==='write'){await writeFile(path,value);return;}
    if(action==='mkdir'){await mkdir(path,{recursive:true});return;}
    if(action==='exists'){try{await stat(path);return true;}catch{return false;}}
    if(action==='list')return (await readdir(path,{withFileTypes:true})).map(e=>({name:e.name,directory:e.isDirectory()}));
  });
  await local.addInitScript(()=>{
    const fileHandle=name=>({kind:'file',name:name.split('/').at(-1),queryPermission:async()=> 'granted',
      getFile:async()=>{const text=await window.__disk('read',name);return new File([text],name);},
      createWritable:async()=>{let text;return {write:async value=>{text=value;},close:async()=>window.__disk('write',name,text),abort:async()=>{}};}});
    const dirHandle=(name='')=>({kind:'directory',name:name||'Test JSON klasörü',
      async *entries(){for(const e of await window.__disk('list',name))yield [e.name,e.directory?dirHandle(name+'/'+e.name):fileHandle((name?name+'/':'')+e.name)];},
      getDirectoryHandle:async child=>{const next=(name?name+'/':'')+child;await window.__disk('mkdir',next);return dirHandle(next);},
      getFileHandle:async(child,options={})=>{const next=(name?name+'/':'')+child;if(!await window.__disk('exists',next)){if(!options.create)throw new DOMException('Missing','NotFoundError');await window.__disk('write',next,'');}return fileHandle(next);}});
    window.showDirectoryPicker=async()=>dirHandle();
  });
  const lp=await local.newPage(),localErrors=[];lp.on('pageerror',e=>localErrors.push(e.message));
  await lp.goto(pathToFileURL(resolve(root,'public/index.html')).href);
  assert(await lp.locator('#connectFolder').isVisible());await lp.locator('#connectFolder').click();await lp.locator('#jsonChoice').selectOption('mevcut.json');await lp.locator('#openJson').click();
  await lp.locator('[data-field="topic"]').waitFor();
  await lp.locator('[data-field="owner"]').fill('JSON kullanıcısı');await lp.locator('[data-field="owner"]').press('Enter');
  await lp.waitForFunction(()=>document.querySelector('#gridStatus').textContent.includes('Tüm değişiklikler'));
  assert.equal(JSON.parse(await readFile(resolve(directory,'mevcut.json'),'utf8')).topics[0].owner,'JSON kullanıcısı');
  assert.equal((await readdir(resolve(directory,'yedekler'))).length,1);
  const updated=JSON.parse(await readFile(resolve(directory,'mevcut.json'),'utf8'));updated.topics[0].owner='Dışarıdan güncellendi';
  await writeFile(resolve(directory,'mevcut.json'),JSON.stringify(updated));
  await lp.waitForFunction(()=>document.querySelector('[data-field="owner"]').value==='Dışarıdan güncellendi');
  let resolveLocalDownload;const localDownloadPromise=new Promise(r=>resolveLocalDownload=r);
  local.once('page',p=>p.on('download',resolveLocalDownload));
  const localPopup=lp.waitForEvent('popup');await lp.locator('#htmlReportBtn').click();await localPopup;
  let localTimer;const localDownload=await Promise.race([localDownloadPromise,new Promise((_,reject)=>{localTimer=setTimeout(()=>reject(new Error('Local report download timeout')),10000);})]).finally(()=>clearTimeout(localTimer));await localDownload.saveAs(resolve(output,'json-yonetici-raporu.html'));
  await lp.screenshot({path:resolve(output,'json-arayuz.png'),fullPage:true});
  assert.deepEqual(localErrors,[]);
  console.log('PASS browser/file JSON: existing file, autosave to disk, prior-version backup, external refresh, report download (chooser simulated)');
}finally{
  if(browser)await browser.close();await new Promise(r=>server.close(r));await db.close();
}
