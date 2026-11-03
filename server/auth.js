import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { digest } from './store.js';
const scrypt=promisify(derive);
export async function hashPassword(password){
  if(typeof password!=='string'||password.length<12||password.length>512)throw new Error('Parola 12–512 karakter olmalı.');
  const salt=randomBytes(16).toString('hex');
  return salt+':'+(await scrypt(password,salt,64)).toString('hex');
}
export async function verifyPassword(password,hash){
  if(typeof password!=='string'||password.length>512)return false;
  const [salt,hex]=hash.split(':');const expected=Buffer.from(hex,'hex');
  const actual=await scrypt(password,salt,64);
  return actual.length===expected.length&&timingSafeEqual(actual,expected);
}
export async function createUser(pool,username,password){
  if(!/^[\p{L}\p{N}_.@-]{2,100}$/u.test(username||''))throw new Error('Kullanıcı adı 2–100 karakter olmalı.');
  await pool.query('INSERT INTO app_users(username,password_hash) VALUES($1,$2)',[username,await hashPassword(password)]);
}
export class Auth {
  constructor(pool){this.pool=pool;}
  async login(username,password){
    const row=(await this.pool.query('SELECT password_hash FROM app_users WHERE username=$1',[username])).rows[0];
    // Same KDF cost for unknown users.
    const dummy='00000000000000000000000000000000:'+Buffer.alloc(64).toString('hex');
    const valid=await verifyPassword(password,row?.password_hash||dummy);
    if(!row||!valid)return null;
    const token=randomBytes(32).toString('hex');
    await this.pool.query('DELETE FROM sessions WHERE expires_at<now()');
    await this.pool.query("INSERT INTO sessions(token_hash,username,expires_at) VALUES($1,$2,now()+interval '12 hours')",[digest(token),username]);
    return token;
  }
  token(req){return /(?:^|;\s*)istakip_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie||'')?.[1];}
  async user(req){
    const token=this.token(req);if(!token)return null;
    return (await this.pool.query('SELECT username FROM sessions WHERE token_hash=$1 AND expires_at>now()',[digest(token)])).rows[0]?.username||null;
  }
  async logout(req){const token=this.token(req);if(token)await this.pool.query('DELETE FROM sessions WHERE token_hash=$1',[digest(token)]);}
}
