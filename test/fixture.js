import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { randomUUID,randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export const root=resolve(import.meta.dirname,'..');
export async function freePort(){
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;await new Promise(r=>server.close(r));return port;
}
export async function database(){
  const port=await freePort(),password=randomBytes(24).toString('hex');
  const databaseDir=resolve(root,'test-data',randomUUID());
  await mkdir(databaseDir,{recursive:true});
  const engine=new EmbeddedPostgres({databaseDir,port,user:'postgres',password,persistent:true,
    authMethod:'scram-sha-256',initdbFlags:['--encoding=UTF8','--locale=C'],
    postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
  await engine.initialise();await engine.start();
  const pool=new pg.Pool({host:'127.0.0.1',port,user:'postgres',password,database:'postgres',max:10});
  return {pool,engine,async close(){
    await pool.end();
    if(process.platform==='win32'){
      const {pg_ctl}=await import('@embedded-postgres/windows-x64');
      await promisify(execFile)(pg_ctl,['-D',databaseDir,'stop','-m','fast','-w'],{windowsHide:true,timeout:20000});
      engine.process=undefined;
    }else await engine.stop();
  }};
}
export const topic=(id='a')=>({id,sheet:'Konular',topic:'IoT geçişi',service:'IoT',owner:'Deniz',topicType:'Proje',priority:'3',status:'Aktif',closingDate:'Planlanıyor',current:'',updates:[]});
