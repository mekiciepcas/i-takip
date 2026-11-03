import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { database,topic,root } from './fixture.js';
import { PgStore } from '../server/store.js';
import { Auth,createUser } from '../server/auth.js';
import { createApp } from '../server/http.js';
let db,store;
before(async()=>{db=await database();store=new PgStore(db.pool);await store.initialize();});
after(async()=>{if(db)await db.close();});
test('PostgreSQL round trip preserves Unicode, long notes and sheet names',async()=>{
  const before=await store.read(),data={version:1,sheets:['Konular','İş','Is'],topics:[{...topic(),updates:[{id:'note1',date:'2026-11-03',note:'şğıüöç '.repeat(500)}]}]};
  await store.write(data,before.etag,randomUUID(),'deniz');
  assert.deepEqual((await store.read()).data,data);
});
test('two writers with one revision: exactly one commit',async()=>{
  const snapshot=await store.read();
  const results=await Promise.allSettled(['bir','iki'].map(owner=>store.write({...snapshot.data,topics:[{...snapshot.data.topics[0],owner}]},snapshot.etag,randomUUID(),'deniz')));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.status,412);
});
test('replayed operation is idempotent and different content is rejected',async()=>{
  const snapshot=await store.read(),id=randomUUID();
  const first=await store.write(snapshot.data,snapshot.etag,id,'deniz');
  const second=await store.write(snapshot.data,snapshot.etag,id,'deniz');
  assert.equal(first.etag,second.etag);assert.equal(second.replayed,true);
  assert.equal((await store.receipt(id)).committed,true);
  await assert.rejects(store.write({...snapshot.data,topics:[]},snapshot.etag,id,'deniz'),e=>e.status===409);
});
test('invalid input does not change the revision',async()=>{
  const before=await store.read();
  await assert.rejects(store.write({...before.data,topics:[topic(),topic()]},before.etag,randomUUID(),'deniz'),e=>e.status===400);
  assert.equal((await store.read()).etag,before.etag);
});
test('transaction rollback protects existing topics after a database error',async()=>{
  const before=await store.read();
  // Force a genuine database failure after topic updates, before receipt commit.
  await db.pool.query("ALTER TABLE operations ADD CONSTRAINT test_fail_actor CHECK(actor <> 'reject-me')");
  try{await assert.rejects(store.write({...before.data,topics:[{...before.data.topics[0],owner:'rollback'}]},before.etag,randomUUID(),'reject-me'));
    assert.deepEqual(await store.read(),before);
  }finally{await db.pool.query('ALTER TABLE operations DROP CONSTRAINT test_fail_actor');}
});
test('authentication, origin checks, private files and audit actor',async()=>{
  await createUser(db.pool,'deniz','synthetic-password-123');
  const origin='http://localhost:9999',server=createApp({store,auth:new Auth(db.pool),publicDir:root+'/public',origin});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  try{
    assert.equal((await fetch(base+'/api/data')).status,401);
    assert.equal((await fetch(base+'/.env')).status,404);
    assert.equal((await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://wrong.example'},body:'{}'})).status,403);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({username:'deniz',password:'synthetic-password-123'})});
    assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const response=await fetch(base+'/api/data',{headers:{Cookie:cookie}}),data=await response.json(),id=randomUUID();
    const write=await fetch(base+'/api/data',{method:'PUT',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','If-Match':response.headers.get('etag'),'Idempotency-Key':id},body:JSON.stringify(data)});
    assert.equal(write.status,200);
    assert.equal((await db.pool.query('SELECT actor FROM operations WHERE id=$1',[id])).rows[0].actor,'deniz');
    await fetch(base+'/api/logout',{method:'POST',headers:{Cookie:cookie,Origin:origin}});
    assert.equal((await fetch(base+'/api/me',{headers:{Cookie:cookie}})).status,401);
  }finally{await new Promise(r=>server.close(r));}
});
