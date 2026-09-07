import express from 'express';
import { db, localDate } from './db.js';
import { checkIn, checkInWindow } from './attendance.js';
import { geocode } from './geocode.js';
import { getWeather } from './weather.js';
import { requireSession } from './session.js';

export const router = express.Router();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const q = {
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byNick: db.prepare('SELECT * FROM users WHERE nickname = ?'),
  insertUser: db.prepare('INSERT INTO users (nickname) VALUES (?)'),
  rename: db.prepare('UPDATE users SET nickname = ? WHERE id = ?'),
  insertSettings: db.prepare(
    'INSERT INTO user_settings (user_id, location_name, latitude, longitude) VALUES (?, ?, ?, ?)'
  ),
  settings: db.prepare('SELECT * FROM user_settings WHERE user_id = ?'),
  updateSettings: db.prepare(`
    UPDATE user_settings
       SET goal_time = ?, location_name = ?, latitude = ?, longitude = ?,
           updated_at = datetime('now', 'localtime')
     WHERE user_id = ?
  `),
  todayRow: db.prepare('SELECT * FROM attendance WHERE user_id = ? AND check_date = ?'),
  recent: db.prepare(
    'SELECT check_date, status FROM v_recent_3days WHERE user_id = ? ORDER BY check_date DESC'
  ),
  leaderboard: db.prepare(
    'SELECT nickname, best_streak, current_streak, rank FROM v_leaderboard ORDER BY rank, nickname LIMIT 20'
  ),
};

const createUser = db.transaction((nickname, place) => {
  const { lastInsertRowid } = q.insertUser.run(nickname);
  q.insertSettings.run(lastInsertRowid, place.location_name, place.latitude, place.longitude);
  return Number(lastInsertRowid);
});

function cleanNickname(raw) {
  const nickname = String(raw ?? '').trim();
  if (nickname.length < 1 || nickname.length > 20) {
    throw new HttpError(400, '닉네임은 1~20자로 입력해 주세요.');
  }
  return nickname;
}

function me(req) {
  const user = q.byId.get(req.session.userId);
  // 세션은 살아 있는데 사용자가 사라진 경우 (DB를 비웠을 때 등)
  if (!user) throw new HttpError(401, '기록을 찾을 수 없어요. 닉네임을 다시 정해 주세요.');
  return user;
}

const DEFAULT_PLACE = {
  location_name: process.env.DEFAULT_LOCATION_NAME ?? '서울',
  latitude: Number(process.env.DEFAULT_LATITUDE ?? 37.5665),
  longitude: Number(process.env.DEFAULT_LONGITUDE ?? 126.978),
};

// 닉네임 선점. 이미 쓰는 닉네임이면 거절한다.
// 이전에는 기존 사용자를 그대로 돌려줬는데, 그러면 닉네임만 알면 남의 기록을 가져갈 수 있었다.
router.post('/signup', (req, res) => {
  // 이미 이 기기에 기록이 있으면 새로 만들지 않고 그것을 돌려준다.
  // 기기 바인딩이라 세션을 새 사용자로 갈아타면 이전 기록의 쿠키가 사라져
  // 주인 없는 기록이 되고 영구히 되찾을 수 없다.
  if (req.session?.userId) {
    const existing = q.byId.get(req.session.userId);
    if (existing) return res.status(200).json(existing);
  }

  const nickname = cleanNickname(req.body?.nickname);

  if (q.byNick.get(nickname)) {
    throw new HttpError(409, `'${nickname}'은(는) 이미 사용 중이에요. 다른 닉네임을 써 주세요.`);
  }

  const id = createUser(nickname, DEFAULT_PLACE);
  req.session.userId = id;
  res.status(201).json(q.byId.get(id));
});

router.get('/me', requireSession, (req, res) => {
  const user = me(req);
  const settings = q.settings.get(user.id);
  res.json({
    ...user,
    settings,
    // 출석 창은 서버가 계산해서 내려준다. 화면이 하한선을 다시 계산하면
    // EARLY_CHECKIN_WINDOW_MINUTES를 바꿀 때 안내만 틀려진다.
    checkin_window: checkInWindow(settings.goal_time),
    today: q.todayRow.get(user.id, localDate()) ?? null,
    server_date: localDate(),
  });
});

// 닉네임 변경. 기록은 그대로 유지된다.
// 기기 바인딩이라 로그아웃 후 재입장하면 기록을 되찾을 수 없으므로,
// '닉네임만 바꾸고 싶은' 경우를 위해 별도로 둔다.
router.put('/me/nickname', requireSession, (req, res) => {
  const user = me(req);
  const nickname = cleanNickname(req.body?.nickname);

  const taken = q.byNick.get(nickname);
  if (taken && taken.id !== user.id) {
    throw new HttpError(409, `'${nickname}'은(는) 이미 사용 중이에요.`);
  }

  q.rename.run(nickname, user.id);
  res.json(q.byId.get(user.id));
});

router.put('/me/settings', requireSession, async (req, res) => {
  const user = me(req);
  const current = q.settings.get(user.id);

  const goalTime = String(req.body?.goal_time ?? current.goal_time);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(goalTime)) {
    throw new HttpError(400, '목표 시간은 HH:MM 형식이어야 합니다.');
  }

  const locationName = String(req.body?.location_name ?? current.location_name).trim();
  if (!locationName) throw new HttpError(400, '위치 이름을 입력해 주세요.');

  // 이름이 그대로면 지오코딩을 건너뛴다. 목표 시간만 바꿀 때 불필요한 외부 호출을 막는다.
  const place = locationName === current.location_name
    ? { location_name: current.location_name, latitude: current.latitude, longitude: current.longitude }
    : await geocode(locationName);

  q.updateSettings.run(goalTime, place.location_name, place.latitude, place.longitude, user.id);
  res.json(q.settings.get(user.id));
});

router.post('/me/attendance', requireSession, (req, res) => {
  const user = me(req);
  res.status(201).json(checkIn(user.id));
});

router.get('/me/recent', requireSession, (req, res) => {
  res.json(q.recent.all(me(req).id));
});

router.get('/me/weather', requireSession, async (req, res) => {
  const settings = q.settings.get(me(req).id);
  const weather = await getWeather(settings.latitude, settings.longitude);
  res.json({ ...weather, location_name: settings.location_name });
});

// 랭킹은 인증 없이 볼 수 있다. 닉네임과 기록 일수만 나가고 설정은 나가지 않는다.
router.get('/leaderboard', (req, res) => {
  res.json(q.leaderboard.all());
});

router.use((err, req, res, next) => {
  const status = err.status ?? 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message ?? '서버 오류' });
});
