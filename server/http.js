import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AppError } from './store.js';
const MAX=9*1024*1024;
export function createApp({store,auth,publicDir,origin,secureCookie=false}){
  const failures=new Map();
  const publicFiles=new Map([
    ['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css'],
    ['/storage.js','storage.js'],['/report.html','report.html'],['/assets/xlsx.full.min.js','assets/xlsx.full.min.js']
  ]);
  function reply(res,status,data,headers={}){
    const body=JSON.stringify(data);
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(body);
  }
  async function body(req){
    if(!req.headers['content-type']?.startsWith('application/json'))throw new AppError(415,'JSON bekleniyor.');
    let size=0;const parts=[];
    for await(const chunk of req){size+=chunk.length;if(size>MAX)throw new AppError(413,'İstek 9 MB sınırını aşıyor.');parts.push(chunk);}
    try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new AppError(400,'JSON okunamadı.');}
  }
  return createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');
    const url=new URL(req.url,'http://localhost');
    try{
      if(!['GET','POST','PUT'].includes(req.method))throw new AppError(405,'Yöntem desteklenmiyor.');
      if(req.method!=='GET'&&req.headers.origin!==origin)throw new AppError(403,'İstek kaynağı reddedildi.');
      if(url.pathname==='/api/health'&&req.method==='GET'){
        await store.pool.query('SELECT 1');return reply(res,200,{ok:true,version:'2.5.0',storage:'postgres'});
      }
      const cookie=token=>`istakip_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token?43200:0}${secureCookie?'; Secure':''}`;
      if(url.pathname==='/api/login'&&req.method==='POST'){
        const key=req.socket.remoteAddress,now=Date.now();
        for(const [ip,item] of failures)if(item.until<now)failures.delete(ip);
        const attempt=failures.get(key)||{count:0,until:now+15*60*1000};
        if(attempt.count>=10)throw new AppError(429,'Çok fazla giriş denemesi. 15 dakika sonra tekrar deneyin.');
        attempt.count++;failures.set(key,attempt);
        const input=await body(req);
        if(typeof input.username!=='string'||input.username.length>100)throw new AppError(400,'Kullanıcı adı geçersiz.');
        const token=await auth.login(input.username,input.password);
        if(!token)throw new AppError(401,'Kullanıcı adı veya parola hatalı.');
        failures.delete(key);return reply(res,200,{username:input.username},{'Set-Cookie':cookie(token)});
      }
      if(url.pathname.startsWith('/api/')){
        const username=await auth.user(req);if(!username)throw new AppError(401,'Oturum açmanız gerekiyor.');
        if(url.pathname==='/api/me'&&req.method==='GET')return reply(res,200,{username,version:'2.5.0',storage:'postgres'});
        if(url.pathname==='/api/logout'&&req.method==='POST'){await auth.logout(req);return reply(res,200,{ok:true},{'Set-Cookie':cookie('')});}
        if(url.pathname==='/api/data'&&req.method==='GET'){
          const snapshot=await store.read();return reply(res,200,snapshot.data,{ETag:snapshot.etag});
        }
        if(url.pathname==='/api/data'&&req.method==='PUT'){
          const result=await store.write(await body(req),req.headers['if-match'],req.headers['idempotency-key'],username);
          return reply(res,200,{ok:true,replayed:result.replayed},{ETag:result.etag});
        }
        if(url.pathname==='/api/receipt'&&req.method==='GET')return reply(res,200,await store.receipt(url.searchParams.get('id')||''));
        throw new AppError(404,'İşlem bulunamadı.');
      }
      if(req.method!=='GET'||!publicFiles.has(url.pathname))throw new AppError(404,'Sayfa bulunamadı.');
      const file=publicFiles.get(url.pathname),bytes=await readFile(resolve(publicDir,file));
      const ext=file.split('.').pop(),mime={html:'text/html',js:'text/javascript',css:'text/css'}[ext];
      res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store'});res.end(bytes);
    }catch(e){
      const status=e.status||503;
      if(!e.status)console.error('Request failed:',e.code||e.name);
      if(!res.headersSent)reply(res,status,{error:e.status?e.message:'Veri deposuna erişilemiyor; taslağınızı koruyup tekrar deneyin.'});
      else res.end();
    }
  });
}
