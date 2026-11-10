import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
export const dataDir=path.resolve(process.env.DATA_DIR||'data');
mkdirSync(dataDir,{recursive:true,mode:0o700});
export const db=new DatabaseSync(path.join(dataDir,'library.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
export function get(key){const r=db.prepare('SELECT value FROM store WHERE key=?').get(key);return r?JSON.parse(r.value):null;}
export function set(key,value){db.prepare('INSERT INTO store(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
export function del(key){db.prepare('DELETE FROM store WHERE key=?').run(key);}
export function list(prefix){return db.prepare('SELECT value FROM store WHERE key LIKE ?').all(prefix+'%').map(r=>JSON.parse(r.value));}

export function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}}
