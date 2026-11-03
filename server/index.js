import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { PgStore } from './store.js';
import { Auth,createUser } from './auth.js';
import { createApp } from './http.js';
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL gerekli. Yerel JSON modu için public/index.html açın.');
if(process.env.DATABASE_URL.includes('CHANGE_THIS')||process.env.ADMIN_PASSWORD?.includes('CHANGE_THIS'))throw new Error('Örnek bağlantı/parola değerlerini gerçek değerlerle değiştirin.');
const port=Number(process.env.PORT||3000),host=process.env.HOST||'127.0.0.1';
const origin=process.env.APP_ORIGIN||`http://localhost:${port}`;
if(new URL(origin).origin!==origin)throw new Error('APP_ORIGIN yalnız şema ve alan adı/port içermeli; yol ve sondaki / kaldırılmalı.');
if(process.env.NODE_ENV==='production'&&!origin.startsWith('https://'))throw new Error('Üretimde APP_ORIGIN HTTPS olmalı; TLS reverse proxy kullanın.');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:10,connectionTimeoutMillis:10000,statement_timeout:30000});
const store=new PgStore(pool);await store.initialize();
const users=await pool.query('SELECT count(*)::int AS count FROM app_users');
if(!users.rows[0].count){
  if(!process.env.ADMIN_USERNAME||!process.env.ADMIN_PASSWORD)throw new Error('İlk açılışta ADMIN_USERNAME ve en az 12 karakterlik ADMIN_PASSWORD gerekli.');
  await createUser(pool,process.env.ADMIN_USERNAME,process.env.ADMIN_PASSWORD);
}
const server=createApp({store,auth:new Auth(pool),publicDir:fileURLToPath(new URL('../public/',import.meta.url)),origin,secureCookie:origin.startsWith('https://')});
server.listen(port,host,()=>console.log(`İş Takip v2.5 hazır: ${origin}`));
async function stop(){server.close(async()=>{await pool.end();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
