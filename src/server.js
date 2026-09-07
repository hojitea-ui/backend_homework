import 'dotenv/config';
import express from 'express';
import { sessionMiddleware } from './session.js';
import { router } from './routes.js';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Fly.io는 엣지에서 TLS를 끊고 X-Forwarded-Proto를 붙여 넘긴다.
// 이게 없으면 express-session이 요청을 http로 보고 secure 쿠키를 내려주지 않는다.
// 즉 배포하면 로그인이 조용히 안 된다.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static('public'));
app.use('/api', router);

app.listen(PORT, () => {
  console.log(`http://localhost:${PORT} 에서 실행 중`);
});
