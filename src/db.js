import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.env.DB_PATH ?? './data/haru.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

// journal_mode은 DB 파일에 저장되지만 foreign_keys는 연결마다 켜야 함.
// better-sqlite3는 기본으로 ON이지만, 드라이버를 갈아탈 때 조용히 꺼지는 걸 막으려고 명시해 둔다.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function pad(n) {
  return String(n).padStart(2, '0');
}

// SQLite의 date('now','localtime')과 같은 시간대를 쓰도록 직접 포맷한다.
// toISOString()은 UTC라 자정 근처에서 날짜가 하루 밀린다.
export function localDateTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function localDate(d = new Date()) {
  return localDateTime(d).slice(0, 10);
}
