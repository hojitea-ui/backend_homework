import fs from 'node:fs';
import { db } from './db.js';

const schema = fs.readFileSync('./db/schema.sql', 'utf-8');
db.exec(schema);

// CREATE TABLE IF NOT EXISTS는 이미 있는 테이블을 건드리지 않으므로,
// 컬럼을 지울 때는 기존 DB를 여기서 따로 맞춰야 한다.
// weather_summary는 쓰는 코드 없이 항상 NULL이었어서 스키마에서 빼기로 했다.
const columns = db.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name);
if (columns.includes('weather_summary')) {
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
