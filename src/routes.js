import crypto from 'node:crypto';
import express from 'express';
import { db, localDate } from './db.js';
import { checkIn, checkInWindow } from './attendance.js';
import { geocode } from './geocode.js';
import { getWeather } from './weather.js';
import { requireSession, SESSION_COOKIE_NAME } from './session.js';

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
  insertUser: db.prepare('INSERT INTO users (nickname, recovery_code_hash) VALUES (?, ?)'),
  byRecovery: db.prepare('SELECT * FROM users WHERE recovery_code_hash = ?'),
  setRecovery: db.prepare('UPDATE users SET recovery_code_hash = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  rename: db.prepare('UPDATE users SET nickname = ? WHERE id = ?'),
  insertSettings: db.prepare(
    'INSERT INTO user_settings (user_id, goal_time, location_name, latitude, longitude) VALUES (?, ?, ?, ?, ?)'
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

const createUser = db.transaction((nickname, place, recoveryHash) => {
  const { lastInsertRowid } = q.insertUser.run(nickname, recoveryHash);
  q.insertSettings.run(
    lastInsertRowid, DEFAULT_GOAL_TIME, place.location_name, place.latitude, place.longitude
  );
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

const GOAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

// 새 사용자의 기본 목표 시간. 스키마 DEFAULT가 아니라 여기서 정한다 —
// CREATE TABLE IF NOT EXISTS는 이미 있는 테이블을 건드리지 않고
// SQLite는 컬럼 DEFAULT를 ALTER로 바꿀 수 없어서, 스키마만 고치면
// 이미 배포된 DB의 새 사용자는 옛 기본값을 계속 받는다.
const DEFAULT_GOAL_TIME = process.env.DEFAULT_GOAL_TIME ?? '06:00';
if (!GOAL_TIME_PATTERN.test(DEFAULT_GOAL_TIME)) {
  // 여기서 막지 않으면 CHECK 제약에 걸려 가입하는 순간 500으로 터진다
  console.error(`DEFAULT_GOAL_TIME이 HH:MM 형식이 아닙니다: ${DEFAULT_GOAL_TIME}`);
  process.exit(1);
}

const DEFAULT_PLACE = {
  location_name: process.env.DEFAULT_LOCATION_NAME ?? '서울',
  latitude: Number(process.env.DEFAULT_LATITUDE ?? 37.5665),
  longitude: Number(process.env.DEFAULT_LONGITUDE ?? 126.978),
};

// ── 복구 코드 ────────────────────────────────
// 이 코드를 가진 사람은 어느 기기에서든 계정을 연다. 즉 사실상 비밀번호다.
// 그래서 평문을 저장하지 않고 SHA-256 해시만 남긴다 — DB나 스냅샷이 유출돼도
// 그 값으로는 로그인할 수 없다.
//
// bcrypt 같은 느린 해시를 쓰지 않는 이유: 코드가 128비트 난수라서
// 오프라인 전수 대입의 대상이 아니다. 사람이 정한 비밀번호와 다른 상황이고,
// 그래서 해싱 라이브러리 없이 node:crypto만으로 충분하다.
const RECOVERY_CODE_BYTES = 16;                    // 128비트
const RECOVERY_CODE_PATTERN = /^[0-9a-f]{32}$/;    // 정규화한 뒤의 모양

// 대시를 빼거나 대문자로 붙여넣어도 통해야 한다. 대시는 읽기 편하라고 넣은 것이고
// 보안과는 무관하다.
const normalizeCode = (raw) => String(raw ?? '').replace(/[\s-]/g, '').toLowerCase();

const hashCode = (code) =>
  crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');

function newRecoveryCode() {
  const hex = crypto.randomBytes(RECOVERY_CODE_BYTES).toString('hex');
  return hex.match(/.{8}/g).join('-');
}

// 복구 코드 해시는 응답에 실어 보내지 않는다. 128비트라 유출돼도 뚫리지는 않지만,
// 내보낼 이유가 없는 값이다.
function publicUser({ recovery_code_hash, ...rest }) {
  return rest;
}

// 복구 엔드포인트는 이 앱에서 유일하게 '추측할 수 있는 입구'다.
// 코드가 128비트라 현실적으로 못 맞히지만, 시도 자체를 제한해 둔다.
// 머신 1대로만 돌리므로 메모리에 둬도 된다 (재시작하면 초기화).
const RECOVER_MAX_ATTEMPTS = Number(process.env.RECOVER_MAX_ATTEMPTS ?? 10);
const RECOVER_WINDOW_MS = Number(process.env.RECOVER_WINDOW_MINUTES ?? 10) * 60 * 1000;
const recoverAttempts = new Map();

function throttleRecover(req) {
  const now = Date.now();

  // 만료된 항목이 쌓여 메모리를 먹지 않게 가끔 훑어낸다
  if (recoverAttempts.size > 1000) {
    for (const [key, entry] of recoverAttempts) {
      if (entry.resetAt <= now) recoverAttempts.delete(key);
    }
  }

  const ip = req.ip ?? 'unknown';
  const entry = recoverAttempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    recoverAttempts.set(ip, { count: 1, resetAt: now + RECOVER_WINDOW_MS });
    return;
  }

  entry.count += 1;
  if (entry.count > RECOVER_MAX_ATTEMPTS) {
    const seconds = Math.ceil((entry.resetAt - now) / 1000);
    throw new HttpError(429, `시도가 너무 많아요. ${seconds}초 후에 다시 해 주세요.`);
  }
}

// 닉네임 선점. 이미 쓰는 닉네임이면 거절한다.
// 이전에는 기존 사용자를 그대로 돌려줬는데, 그러면 닉네임만 알면 남의 기록을 가져갈 수 있었다.
router.post('/signup', (req, res) => {
  // 이미 이 기기에 기록이 있으면 새로 만들지 않고 그것을 돌려준다.
  // 세션을 새 사용자로 갈아타면 이전 기록의 쿠키가 사라진다. 복구 코드를
  // 저장해 둔 사람은 되찾을 수 있지만, 저장 안 한 사람은 그대로 잃는다.
  if (req.session?.userId) {
    const existing = q.byId.get(req.session.userId);
    if (existing) return res.status(200).json(publicUser(existing));
  }

  const nickname = cleanNickname(req.body?.nickname);

  if (q.byNick.get(nickname)) {
    throw new HttpError(409, `'${nickname}'은(는) 이미 사용 중이에요. 다른 닉네임을 써 주세요.`);
  }

  // 코드는 이 응답에서 딱 한 번 나간다. 해시만 저장하므로 서버도 다시 알려줄 수 없다.
  const code = newRecoveryCode();
  const id = createUser(nickname, DEFAULT_PLACE, hashCode(code));
  req.session.userId = id;
  res.status(201).json({ ...publicUser(q.byId.get(id)), recovery_code: code });
});

router.get('/me', requireSession, (req, res) => {
  const user = me(req);
  const settings = q.settings.get(user.id);
  res.json({
    ...publicUser(user),
    settings,
    // 코드 자체는 알려줄 수 없으니 '있는지'만 내려준다.
    // 화면이 코드 없는 사용자에게 발급을 권하는 데 쓴다.
    has_recovery_code: user.recovery_code_hash !== null,
    // 출석 창은 서버가 계산해서 내려준다. 화면이 하한선을 다시 계산하면
    // EARLY_CHECKIN_WINDOW_MINUTES를 바꿀 때 안내만 틀려진다.
    checkin_window: checkInWindow(settings.goal_time),
    today: q.todayRow.get(user.id, localDate()) ?? null,
    server_date: localDate(),
  });
});

// 닉네임 변경. 기록은 그대로 유지된다.
// 새로 가입하면 기록이 딸려오지 않으므로 '이름만 바꾸고 싶은' 경우를 위해 별도로 둔다.
router.put('/me/nickname', requireSession, (req, res) => {
  const user = me(req);
  const nickname = cleanNickname(req.body?.nickname);

  const taken = q.byNick.get(nickname);
  if (taken && taken.id !== user.id) {
    throw new HttpError(409, `'${nickname}'은(는) 이미 사용 중이에요.`);
  }

  q.rename.run(nickname, user.id);
  res.json(publicUser(q.byId.get(user.id)));
});

router.put('/me/settings', requireSession, async (req, res) => {
  const user = me(req);
  const current = q.settings.get(user.id);

  const goalTime = String(req.body?.goal_time ?? current.goal_time);
  if (!GOAL_TIME_PATTERN.test(goalTime)) {
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
  res.status(201).json(publicUser(checkIn(user.id)));
});

router.get('/me/recent', requireSession, (req, res) => {
  res.json(q.recent.all(me(req).id));
});

router.get('/me/weather', requireSession, async (req, res) => {
  const settings = q.settings.get(me(req).id);
  const weather = await getWeather(settings.latitude, settings.longitude);
  res.json({ ...weather, location_name: settings.location_name });
});

// 복구 코드로 기록을 되찾는다. 쿠키가 없어도, 다른 기기에서도 된다.
// 이게 있어서 '쿠키가 신원의 전부'가 아니게 되었다.
router.post('/recover', (req, res) => {
  throttleRecover(req);

  const code = normalizeCode(req.body?.code);
  if (!RECOVERY_CODE_PATTERN.test(code)) {
    throw new HttpError(400, '복구 코드 형식이 올바르지 않아요.');
  }

  const user = q.byRecovery.get(hashCode(code));
  // 코드가 틀렸는지, 그런 계정이 없는지 구분해서 알려주지 않는다
  if (!user) throw new HttpError(401, '복구 코드를 찾을 수 없어요.');

  // 세션 고정 공격을 막으려고 세션 id를 새로 발급한 뒤 사용자를 붙인다
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: '세션을 만들 수 없어요.' });
    req.session.userId = user.id;
    res.json(publicUser(user));
  });
});

// 코드를 새로 발급한다. 해시만 저장하므로 잃어버린 코드를 다시 보여줄 방법이 없다 —
// 그래서 '다시 보기'가 아니라 '다시 만들기'다. 옛 코드는 즉시 무효가 된다.
router.post('/me/recovery-code', requireSession, (req, res) => {
  const user = me(req);
  const code = newRecoveryCode();
  q.setRecovery.run(hashCode(code), user.id);
  res.status(201).json({ recovery_code: code });
});

// 기록 삭제. 되돌릴 수 없다.
//
// 이 앱은 '우발적 상실은 막는다'는 원칙으로 만들어져서 로그아웃 버튼도 두지 않았다.
// 그래서 의도적인 삭제도 클릭 한 번으로는 안 되게 닉네임을 그대로 입력받아 대조한다.
//
// users 한 행만 지우면 ON DELETE CASCADE가 user_settings와 attendance를 함께 지우고
// 닉네임도 풀린다. sessions는 외래키 관계가 아니라 CASCADE가 안 걸리므로 직접 파기한다.
router.delete('/me', requireSession, (req, res) => {
  const user = me(req);

  if (String(req.body?.nickname ?? '').trim() !== user.nickname) {
    throw new HttpError(400, '지우려면 닉네임을 정확히 입력해 주세요.');
  }

  q.deleteUser.run(user.id);

  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: '세션을 지우지 못했어요.' });
    res.clearCookie(SESSION_COOKIE_NAME);
    res.status(204).end();
  });
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
