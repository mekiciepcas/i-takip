// Password arrives on stdin, never in command-line arguments or logs.
import pg from 'pg';
import { createUser } from './auth.js';
let password='';for await(const chunk of process.stdin)password+=chunk;
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
try{await createUser(pool,process.argv[2],password.replace(/\r?\n$/,''));console.log('Kullanıcı oluşturuldu.');}
finally{await pool.end();}
