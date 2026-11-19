import fs from 'node:fs';
import { db } from './db.js';

const columnsOf = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// ── 스키마 적용 '전' 마이그레이션 ──
// 컬럼을 추가할 때는 스키마보다 먼저 해야 한다. schema.sql이 그 컬럼에
// 유니크 인덱스를 만드는데, 컬럼이 없는 기존 DB에서는 그 CREATE INDEX가
// 먼저 실패해서 스키마 적용 자체가 멈춘다.
const usersColumns = columnsOf('users');
if (usersColumns.length > 0 && !usersColumns.includes('recovery_code_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN recovery_code_hash TEXT');
  console.log('users.recovery_code_hash 컬럼을 추가했습니다');
  console.log('  (기존 사용자는 NULL입니다 — 로그인 후 재발급하면 생깁니다)');
}

// 목표 시간 '내일부터 적용'용 컬럼. CREATE TABLE IF NOT EXISTS는 기존 테이블에 컬럼을 더하지 않으므로 직접 추가한다
const settingsColumns = columnsOf('user_settings');
for (const col of ['pending_goal_time', 'pending_from']) {
  if (settingsColumns.length > 0 && !settingsColumns.includes(col)) {
    db.exec(`ALTER TABLE user_settings ADD COLUMN ${col} TEXT`);
    console.log(`user_settings.${col} 컬럼을 추가했습니다`);
  }
}

const schema = fs.readFileSync('./db/schema.sql', 'utf-8');
db.exec(schema);

// ── 스키마 적용 '후' 마이그레이션 ──
// 컬럼을 지울 때는 순서가 반대다. CREATE TABLE IF NOT EXISTS가 이미 있는
// 테이블을 건드리지 않으므로 스키마를 적용한 뒤 따로 떼어낸다.
if (columnsOf('attendance').includes('weather_summary')) {
  db.exec('ALTER TABLE attendance DROP COLUMN weather_summary');
  console.log('기존 attendance.weather_summary 컬럼을 제거했습니다');
}

console.log('스키마 적용 완료');
console.log('테이블:', db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map((r) => r.name).join(', '));
console.log('뷰    :', db.prepare(
  "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name"
).all().map((r) => r.name).join(', '));
