import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export class AppError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
export const digest=text=>createHash('sha256').update(text).digest('hex');
export function validate(data){
  const fail=message=>{throw new AppError(400,message);};
  if(!data||!Array.isArray(data.topics)||!Array.isArray(data.sheets))fail('topics ve sheets dizileri gerekli.');
  if(data.topics.length>10000||data.sheets.length<1||data.sheets.length>200)fail('Konu veya sayfa sınırı aşıldı.');
  if(data.sheets.some(s=>typeof s!=='string'||!s.trim()||s.length>31||/[\\/:*?\[\]]/.test(s))||new Set(data.sheets).size!==data.sheets.length)fail('Sayfa adları geçersiz veya yineleniyor.');
  const ids=new Set();
  const string=(value,name,limit=100000)=>{if(typeof value!=='string'||value.length>limit)fail(`${name} geçersiz.`);return value;};
  const topics=data.topics.map(t=>{
    if(!t||typeof t!=='object')fail('Konu geçersiz.');
    const id=string(t.id,'Kimlik',1024);
    if(!id||ids.has(id))fail('Konu kimliği eksik veya yineleniyor.');ids.add(id);
    if(!data.sheets.includes(t.sheet))fail('Konunun sayfası bulunamadı.');
    const topic=string(t.topic,'Konu');if(!topic.trim())fail('Konu boş bırakılamaz.');
    if(!['Aktif','Askıda','Kapandı'].includes(t.status)||!['','1','2','3','4','5'].includes(t.priority))fail('Durum veya önem geçersiz.');
    if(!Array.isArray(t.updates)||t.updates.length>20000)fail('Haftalık geçmiş geçersiz.');
    const updateIds=new Set();
    const updates=t.updates.map(u=>{
      if(!u||typeof u!=='object')fail('Haftalık kayıt geçersiz.');
      const uid=string(u.id,'Not kimliği',100000);
      if(!uid||updateIds.has(uid))fail('Not kimliği yineleniyor.');updateIds.add(uid);
      return {id:uid,date:string(u.date,'Not tarihi'),note:string(u.note,'Not')};
    });
    return {id,sheet:t.sheet,topic,service:string(t.service,'Servis'),owner:string(t.owner,'Sorumlu'),topicType:string(t.topicType,'Tip'),priority:t.priority,status:t.status,closingDate:string(t.closingDate,'Kapanış'),current:string(t.current,'Güncel durum'),updates};
  });
  return {version:1,sheets:[...data.sheets],topics};
}

export class PgStore {
  constructor(pool){this.pool=pool;}
  async initialize(){
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(250025)');
      await c.query(await readFile(new URL('./schema.sql',import.meta.url),'utf8'));
      await c.query('INSERT INTO workspace(id,store_id) VALUES(1,$1) ON CONFLICT DO NOTHING',[randomUUID()]);
      await c.query("INSERT INTO sheets(name,position) SELECT 'Konular',0 WHERE NOT EXISTS(SELECT 1 FROM sheets)");
      await c.query('COMMIT');
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  etag(row){return `"${row.store_id}:${row.revision}"`;}
  async data(c){
    const sheets=(await c.query('SELECT name FROM sheets ORDER BY position')).rows.map(r=>r.name);
    const topics=(await c.query('SELECT id,sheet,topic,service,owner,topic_type AS "topicType",priority,status,closing_date AS "closingDate",current_note AS current FROM topics ORDER BY id')).rows;
    const notes=(await c.query('SELECT topic_id,id,date,note FROM weekly_updates ORDER BY topic_id,position')).rows;
    const byId=new Map(topics.map(t=>{t.updates=[];return [t.id,t];}));
    for(const {topic_id,...note} of notes)byId.get(topic_id).updates.push(note);
    return {version:1,sheets,topics};
  }
  async read(){
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const row=(await c.query('SELECT * FROM workspace WHERE id=1')).rows[0];
      const data=await this.data(c);await c.query('COMMIT');return {data,etag:this.etag(row)};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  async receipt(id){
    const row=(await this.pool.query('SELECT revision,created_at AS "createdAt" FROM operations WHERE id=$1',[id])).rows[0];
    return {committed:!!row,result:row||null};
  }
  async write(input,expected,id,actor){
    if(!expected)throw new AppError(428,'Kayıt sürümü gerekli.');
    if(!/^[0-9a-f-]{36}$/i.test(id||''))throw new AppError(400,'İşlem kimliği geçersiz.');
    const data=validate(input),hash=digest(JSON.stringify(data));
    const c=await this.pool.connect();
    try{
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='5s'");
      const row=(await c.query('SELECT * FROM workspace WHERE id=1 FOR UPDATE')).rows[0];
      const existing=(await c.query('SELECT payload_hash,revision FROM operations WHERE id=$1',[id])).rows[0];
      if(existing){
        if(existing.payload_hash!==hash)throw new AppError(409,'İşlem kimliği farklı içerikle tekrar kullanıldı.');
        await c.query('COMMIT');return {etag:this.etag({...row,revision:existing.revision}),replayed:true};
      }
      if(this.etag(row)!==expected)throw new AppError(412,'Veri başka kullanıcı tarafından değiştirildi.');
      const prior=await this.data(c),byId=new Map(prior.topics.map(t=>[t.id,t])),incoming=new Set(data.topics.map(t=>t.id)),changed=[];
      for(const [position,name] of data.sheets.entries())await c.query('INSERT INTO sheets(name,position) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET position=EXCLUDED.position',[name,position]);
      for(const old of prior.topics)if(!incoming.has(old.id)){await c.query('DELETE FROM topics WHERE id=$1',[old.id]);changed.push(old.id);}
      for(const t of data.topics){
        if(JSON.stringify(byId.get(t.id))===JSON.stringify(t))continue;
        changed.push(t.id);
        await c.query(`INSERT INTO topics(id,sheet,topic,service,owner,topic_type,priority,status,closing_date,current_note)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET
          sheet=EXCLUDED.sheet,topic=EXCLUDED.topic,service=EXCLUDED.service,owner=EXCLUDED.owner,
          topic_type=EXCLUDED.topic_type,priority=EXCLUDED.priority,status=EXCLUDED.status,
          closing_date=EXCLUDED.closing_date,current_note=EXCLUDED.current_note`,
          [t.id,t.sheet,t.topic,t.service,t.owner,t.topicType,t.priority,t.status,t.closingDate,t.current]);
        await c.query('DELETE FROM weekly_updates WHERE topic_id=$1',[t.id]);
        for(const [position,u] of t.updates.entries())await c.query('INSERT INTO weekly_updates(topic_id,id,date,note,position) VALUES($1,$2,$3,$4,$5)',[t.id,u.id,u.date,u.note,position]);
      }
      await c.query('DELETE FROM sheets WHERE NOT(name=ANY($1::text[]))',[data.sheets]);
      const revision=(await c.query('UPDATE workspace SET revision=revision+1 WHERE id=1 RETURNING revision')).rows[0].revision;
      await c.query('INSERT INTO operations(id,payload_hash,revision,actor,changed_topics) VALUES($1,$2,$3,$4,$5)',[id,hash,revision,actor,JSON.stringify(changed)]);
      await c.query('COMMIT');return {etag:this.etag({...row,revision}),replayed:false};
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
}
