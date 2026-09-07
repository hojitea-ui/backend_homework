// 스트릭(최고기록) 로직 검증. 실제 DB를 건드리지 않도록 별도 테스트 DB를 쓴다.
// db.js가 import 시점에 DB_PATH를 읽으므로, 먼저 덮어쓰고 동적 import해야 한다.
process.env.DB_PATH = './data/test.db';

// 하한선도 .env에 의존하지 않게 고정한다.
// 아래 경계 테스트가 '목표 06:30 − 180분 = 03:30'을 전제하므로,
// .env의 값이 다르면 테스트가 엉뚱하게 실패한다.
process.env.EARLY_CHECKIN_WINDOW_MINUTES = '180';

import fs from 'node:fs';

for (const f of ['./data/test.db', './data/test.db-wal', './data/test.db-shm']) {
  fs.rmSync(f, { force: true });
}

const { db } = await import('../src/db.js');
db.exec(fs.readFileSync('./db/schema.sql', 'utf-8'));

const { checkIn, checkInWindow } = await import('../src/attendance.js');

db.prepare("INSERT INTO users (id, nickname) VALUES (1, 'tester')").run();
db.prepare("INSERT INTO user_settings (user_id, goal_time) VALUES (1, '06:30')").run();

const at = (date, hhmm) => new Date(`${date}T${hhmm}:00`);
const streak = () => db.prepare('SELECT current_streak, best_streak FROM users WHERE id = 1').get();
const rowFor = (date) => db.prepare(
  'SELECT is_success FROM attendance WHERE user_id = 1 AND check_date = ?'
).get(date);
const rowCount = () => db.prepare('SELECT count(*) c FROM attendance').get().c;

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

// ── 스트릭 누적 (목표 06:30, 하한 03:30) ──
console.log('스트릭 누적');
const steps = [
  ['2026-03-01', '06:00', '1일차 성공', 1, 1],
  ['2026-03-02', '06:15', '2일차 연속', 2, 2],
  ['2026-03-03', '05:50', '3일차 연속', 3, 3],
  // 3월 4일은 결석 — 아무 것도 하지 않는다
  ['2026-03-05', '06:00', '하루 빠진 뒤 성공', 1, 3],
  ['2026-03-06', '08:00', '늦잠 = 실패', 0, 3],
  ['2026-03-07', '06:00', '실패 다음날 성공', 1, 3],
];

for (const [date, time, label, wantCurrent, wantBest] of steps) {
  checkIn(1, at(date, time));
  const s = streak();
  check(
    label,
    s.current_streak === wantCurrent && s.best_streak === wantBest,
    `current=${s.current_streak} best=${s.best_streak}`
  );
}

// ── 하한선 (목표 -3시간) ──
console.log('');
console.log('이른 체크인 하한선');

const before = rowCount();
let rejected = false;
let message = '';
try {
  checkIn(1, at('2026-03-10', '03:00'));
} catch (err) {
  rejected = true;
  message = err.message;
}
check('03:00은 거절된다', rejected, message);

// 기록이 남으면 UNIQUE 제약 때문에 아침에 진짜 출석을 못 한다
check('거절 시 기록이 남지 않는다', rowCount() === before);

checkIn(1, at('2026-03-10', '06:00'));
check('거절된 날 아침에 다시 누르면 성공', rowFor('2026-03-10')?.is_success === 1);

checkIn(1, at('2026-03-11', '03:30'));
check('하한 경계 03:30은 성공', rowFor('2026-03-11')?.is_success === 1);

checkIn(1, at('2026-03-12', '06:30'));
check('목표 경계 06:30은 성공', rowFor('2026-03-12')?.is_success === 1);

checkIn(1, at('2026-03-13', '06:31'));
check('06:31은 실패 (유예 없음)', rowFor('2026-03-13')?.is_success === 0);

// ── 하루 두 번 ──
console.log('');
console.log('중복 출석');
let dupBlocked = false;
let dupMessage = '';
try {
  checkIn(1, at('2026-03-13', '06:40'));
} catch (err) {
  dupBlocked = true;
  dupMessage = err.message;
}
check('같은 날 두 번은 막힌다', dupBlocked, dupMessage);

// ── 화면에 안내할 출석 창 ──
// 서버가 계산해 /api/me로 내려주는 값. 프론트엔드가 하한선을 다시 계산하면
// EARLY_CHECKIN_WINDOW_MINUTES를 바꿀 때 판정과 안내가 어긋난다.
console.log('');
console.log('출석 창');
const earliestOf = (goal) => checkInWindow(goal).earliest;
check('06:30 -> 03:30', earliestOf('06:30') === '03:30', earliestOf('06:30'));
check('05:00 -> 02:00', earliestOf('05:00') === '02:00', earliestOf('05:00'));
check('03:00은 자정으로 자른다', earliestOf('03:00') === '00:00', earliestOf('03:00'));
check('창의 끝은 목표 시간', checkInWindow('06:30').goal === '06:30');

// ── 스키마 ──
console.log('');
console.log('스키마');
const attendanceColumns = db.prepare('PRAGMA table_info(attendance)').all().map((c) => c.name);
check(
  'attendance에 쓰지 않는 컬럼이 없다',
  !attendanceColumns.includes('weather_summary'),
  attendanceColumns.join(', ')
);

// ── 뷰 ──
console.log('');
console.log('뷰');
const statuses = db.prepare('SELECT status FROM v_recent_3days WHERE user_id = 1').all();
check(
  '최근 3일 상태값은 success/fail/absent',
  statuses.every((s) => ['success', 'fail', 'absent'].includes(s.status))
);

db.prepare("INSERT INTO users (id, nickname, best_streak) VALUES (2, 'zero', 0)").run();
const board = db.prepare('SELECT nickname FROM v_leaderboard').all().map((r) => r.nickname);
check('랭킹에서 0일은 제외된다', !board.includes('zero'), `랭킹=${board.join(',')}`);

console.log('');
console.log(failed === 0 ? '전체 통과' : `${failed}개 실패`);
process.exit(failed === 0 ? 0 : 1);
