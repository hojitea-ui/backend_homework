import 'dotenv/config';
import crypto from 'node:crypto';
import session from 'express-session';
import SqliteStoreFactory from 'better-sqlite3-session-store';
import { db } from './db.js';

const SqliteStore = SqliteStoreFactory(session);

// 비밀번호가 없다. 평소 신원은 브라우저의 세션 쿠키다.
// 쿠키를 잃었을 때를 위한 우회로는 복구 코드다 (src/routes.js의 /recover).
//
// 세션 id 생성, 쿠키 서명, 만료 처리는 직접 만들지 않고 express-session에 맡긴다.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// 세션을 파기할 때 라우트에서도 같은 이름을 써야 해서 내보낸다
export const SESSION_COOKIE_NAME = 'haru.sid';

// 배포(Fly.io)에서는 HTTPS로 나가므로 secure 쿠키를 쓴다.
// localhost는 http라 켜면 쿠키가 아예 안 내려가므로 환경으로 가른다.
const isProduction = process.env.NODE_ENV === 'production';

// 비밀키가 없으면 서버를 띄우지 않는다. 임의값으로 대체하면 재시작마다
// 모든 사용자가 로그아웃되고, 복구 코드를 저장하지 않은 사람은 기록을 잃는다.
const SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.error('SESSION_SECRET이 없거나 너무 짧습니다 (32자 이상 필요).');
  console.error('아래 값을 .env의 SESSION_SECRET에 넣으세요:');
  console.error('  SESSION_SECRET=' + crypto.randomBytes(32).toString('hex'));
  process.exit(1);
}

export const sessionMiddleware = session({
  store: new SqliteStore({
    client: db,
    expired: { clear: true, intervalMs: 15 * 60 * 1000 },
  }),
  secret: SECRET,
  resave: false,
  saveUninitialized: false,   // 닉네임을 정하기 전에는 세션을 만들지 않는다
  name: SESSION_COOKIE_NAME,
  cookie: {
    httpOnly: true,           // JS에서 못 읽게 해서 토큰 탈취를 막는다
    sameSite: 'lax',
    secure: isProduction,     // Fly.io는 엣지에서 TLS를 끊고 넘겨준다
    maxAge: ONE_YEAR_MS,      // 브라우저를 닫아도 로그인이 유지되어야 매일 쓸 수 있다
  },
});

// 로그인된 사용자만 통과. 세션이 없으면 401을 돌려주고,
// 프론트엔드는 이걸 보고 닉네임 입력 화면으로 돌아간다.
export function requireSession(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: '닉네임을 먼저 정해 주세요.' });
  }
  next();
}
