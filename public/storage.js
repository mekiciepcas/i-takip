/* Classic script intentionally supports opening index.html directly with file://. */
(() => {
  'use strict';
  const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(n=>n.toString(16).padStart(2,'0')).join('');
  const error=(status,message)=>Object.assign(new Error(message),{status});
  class ApiStorage {
    kind='postgres';
    async request(path,options={}){
      const response=await fetch(path,{cache:'no-store',...options});
      const payload=await response.json();
      if(!response.ok)throw error(response.status,payload.error||'Sunucuya erişilemiyor.');
      return {payload,etag:response.headers.get('ETag')};
    }
    async me(){return (await this.request('/api/me')).payload;}
    async login(username,password){return (await this.request('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})).payload;}
    async logout(){await this.request('/api/logout',{method:'POST'});}
    async read(){const r=await this.request('/api/data');return {data:r.payload,etag:r.etag};}
    async write(data,etag,id){return this.request('/api/data',{method:'PUT',headers:{'Content-Type':'application/json','If-Match':etag,'Idempotency-Key':id},body:JSON.stringify(data)});}
    async receipt(id){return (await this.request('/api/receipt?id='+encodeURIComponent(id))).payload;}
  }
  class JsonStorage {
    kind='json';
    constructor(directory,file){this.directory=directory;this.file=file;}
    async read(){
      const file=await this.file.getFile();
      if(file.size>9*1024*1024)throw error(413,'JSON dosyası 9 MB sınırını aşıyor.');
      const raw=await file.text();let data;
      try{data=JSON.parse(raw);}catch{throw error(400,'JSON dosyası bozuk; mevcut dosyanın üzerine yazılmadı.');}
      if(!Array.isArray(data?.topics)||!Array.isArray(data?.sheets))throw error(400,'İş Takip JSON biçimi bekleniyor: topics ve sheets.');
      const ids=data.topics.map(t=>t?.id);
      if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length)throw error(400,'JSON konu kimlikleri eksik veya yineleniyor. Boş bir çalışma dosyası oluşturup Yedekten yükle ile bu dosyayı içe aktarın.');
      return {data,raw,etag:'"'+await hash(raw)+'"'};
    }
    async write(data,etag,id){
      const current=await this.read();
      const contentHash=await hash(JSON.stringify(data));
      const old=current.data._v25?.operations?.find(op=>op.id===id);
      if(old){if(old.hash!==contentHash)throw error(409,'İşlem kimliği farklı içerikle kullanıldı.');return {etag:current.etag};}
      if(current.etag!==etag)throw error(412,'JSON dosyası başka bir uygulamada değişti.');
      if(await this.file.queryPermission({mode:'readwrite'})!=='granted')throw error(403,'Dosyaya yazma izni yok. Klasörü yeniden seçin.');
      // Keep the previous full document before opening a write stream on the main file.
      const backupDir=await this.directory.getDirectoryHandle('yedekler',{create:true});
      const backup=await backupDir.getFileHandle(new Date().toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomUUID()+'.json',{create:true});
      const backupStream=await backup.createWritable();
      try{await backupStream.write(current.raw);await backupStream.close();}catch(e){await backupStream.abort().catch(()=>{});throw error(503,'Yedek oluşturulamadı. Ana dosya değiştirilmedi.');}
      // This detects intervening changes, but is not a distributed file lock.
      if((await this.read()).etag!==etag)throw error(412,'JSON dosyası kayıt öncesinde değişti.');
      const operations=[...(current.data._v25?.operations||[]).slice(-99),{id,hash:contentHash}];
      const payload={...data,_v25:{format:1,updatedAt:new Date().toISOString(),operations}};
      let stream;
      try{
        stream=await this.file.createWritable();await stream.write(JSON.stringify(payload,null,2));await stream.close();
        const saved=await this.read();
        if(!saved.data._v25?.operations?.some(op=>op.id===id))throw new Error('Yazılan kayıt doğrulanamadı.');
        return {etag:saved.etag};
      }catch(e){if(stream)await stream.abort().catch(()=>{});throw error(503,'Dosya kaydının sonucu belirsiz. İşlem sonucunu denetleyin.');}
    }
    async receipt(id){const current=await this.read();return {committed:!!current.data._v25?.operations?.some(op=>op.id===id)};}
  }
  window.IsTakipStorage={ApiStorage,JsonStorage};
})();
