import 'dotenv/config';
import { db, localDate, localDateTime } from './db.js';

// 목표 시간보다 이만큼 전부터만 출석을 받는다. 밤을 새운 사람이 00:30에 눌러
// 성공을 챙기는 걸 막는 하한선. 목표를 당기면 하한도 함께 당겨진다.
const EARLY_WINDOW_MINUTES = Number(process.env.EARLY_CHECKIN_WINDOW_MINUTES ?? 180);

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

const toHhmm = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

// 하한선: 목표 시간 −EARLY_WINDOW_MINUTES.
// 목표가 03:00처럼 이르면 하한이 자정을 넘어간다. 날짜가 걸쳐지는 걸 피하려고
// 그런 경우엔 00:00으로 자른다.
const earliestMinutes = (goalTime) => Math.max(0, toMinutes(goalTime) - EARLY_WINDOW_MINUTES);

// 출석을 받는 창. 화면 안내에 쓰라고 서버가 계산해서 내려준다.
// 프론트엔드가 EARLY_WINDOW_MINUTES를 따로 들고 있으면 .env를 바꿀 때
// 판정은 그대로인데 안내만 틀린 값을 보여준다.
export function checkInWindow(goalTime) {
  return { earliest: toHhmm(earliestMinutes(goalTime)), goal: goalTime };
}

const q = {
  settings: db.prepare('SELECT * FROM user_settings WHERE user_id = ?'),
  todayRow: db.prepare('SELECT * FROM attendance WHERE user_id = ? AND check_date = ?'),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
  insert: db.prepare(`
    INSERT INTO attendance (user_id, check_date, checked_at, goal_time_snapshot, is_success)
    VALUES (?, ?, ?, ?, ?)
  `),
  bumpStreak: db.prepare(`
    UPDATE users
       SET current_streak = CASE
             WHEN last_success_date = date(?, '-1 day') THEN current_streak + 1
             ELSE 1
           END,
           last_success_date = ?
     WHERE id = ?
  `),
  saveBest: db.prepare(
    'UPDATE users SET best_streak = current_streak WHERE id = ? AND current_streak > best_streak'
  ),
  resetStreak: db.prepare('UPDATE users SET current_streak = 0 WHERE id = ?'),
};

export class CheckInError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// now를 인자로 받는 이유: 여러 날에 걸친 스트릭 로직을 테스트하려면 날짜를 주입할 수 있어야 한다.
export const checkIn = db.transaction((userId, now = new Date()) => {
  const settings = q.settings.get(userId);
  if (!settings) throw new CheckInError(404, '사용자를 찾을 수 없습니다.');

  const checkDate = localDate(now);
  const checkedAt = localDateTime(now);

  if (q.todayRow.get(userId, checkDate)) {
    throw new CheckInError(409, '오늘은 이미 출석했어요.');
  }

  const goalMinutes = toMinutes(settings.goal_time);
  const nowMinutes = toMinutes(checkedAt.slice(11, 16));
  const earliest = earliestMinutes(settings.goal_time);

  // 너무 이른 체크인은 실패로 기록하지 않고 거절한다. 하루 한 행(UNIQUE) 제약 때문에
  // 여기서 행을 만들면 정작 아침에 진짜 출석을 못 하게 된다.
  if (nowMinutes < earliest) {
    throw new CheckInError(
      400,
      `아직 너무 일러요. ${toHhmm(earliest)} 이후에 눌러 주세요.`
    );
  }

  const isSuccess = nowMinutes <= goalMinutes ? 1 : 0;
  q.insert.run(userId, checkDate, checkedAt, settings.goal_time, isSuccess);

  if (isSuccess) {
    // last_success_date가 '어제'가 아니면 1로 리셋된다.
    // 덕분에 결석한 날을 따로 기록하거나 배치로 훑을 필요가 없다.
    q.bumpStreak.run(checkDate, checkDate, userId);
    q.saveBest.run(userId);
  } else {
    q.resetStreak.run(userId);
  }

  return { ...q.user.get(userId), today: q.todayRow.get(userId, checkDate) };
});
