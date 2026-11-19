import 'dotenv/config';
import express from 'express';
import { sessionMiddleware } from './session.js';
import { router } from './routes.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Fly 머신은 UTC로 뜬다. TZ=Asia/Seoul(fly.toml)과 tzdata 설치(Dockerfile)가
// 둘 다 있어야 로컬 시간 계산(db.js의 localDateTime)이 맞고, 하나라도 빠지면
// 출석 판정이 에러도 로그도 없이 조용히 틀어진다. 그래서 부팅 시점에 크게 실패시킨다.
function assertTimezone() {
  const KST_OFFSET_MINUTES = -540; // UTC+9. Date#getTimezoneOffset()은 UTC-로컬 이라 음수.
  const offset = new Date().getTimezoneOffset();
  if (offset !== KST_OFFSET_MINUTES) {
    console.error(
      `[FATAL] 서버 타임존이 Asia/Seoul이 아닙니다 (getTimezoneOffset=${offset}, 기대값=${KST_OFFSET_MINUTES}). `
      + 'TZ 환경 변수와 컨테이너의 tzdata 설치를 확인하세요. 이대로 띄우면 출석 성공/실패 판정이 조용히 틀어집니다.'
    );
    process.exit(1);
  }
}

// Fly.io는 엣지에서 TLS를 끊고 X-Forwarded-Proto를 붙여 넘긴다.
// 이게 없으면 express-session이 요청을 http로 보고 secure 쿠키를 내려주지 않는다.
// 즉 배포하면 로그인이 조용히 안 된다.
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
  assertTimezone();
}

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static('public'));
app.use('/api', router);

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 실행 중`);
});
