// 인증 검증. 서버를 별도 포트/별도 DB로 띄워서 HTTP로 확인한다.
// 닉네임만 알면 남의 기록을 가져갈 수 있었던 문제가 다시 생기지 않게 막는 목적.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DB = './data/test-auth.db';

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) fs.rmSync(f, { force: true });

// 스키마를 먼저 적용한다. 서버는 세션 테이블만 알아서 만든다.
const initEnv = { ...process.env, DB_PATH: DB };
const init = spawn(process.execPath, ['src/initdb.js'], { env: initEnv, stdio: 'ignore' });
await new Promise((resolve) => init.on('exit', resolve));

const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...initEnv,
    PORT: String(PORT),
    SESSION_SECRET: 'x'.repeat(64),
    EARLY_CHECKIN_WINDOW_MINUTES: '90',   // 기본값 180과 다른 값으로 띄운다
    DEFAULT_GOAL_TIME: '06:30',           // 앱 기본값이 바뀌어도 아래 단정이 안 흔들리게 고정
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});

// 서버가 뜰 때까지 기다린다
for (let i = 0; i < 40; i += 1) {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(500) });
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed += 1;
};

// fetch는 쿠키를 보관하지 않으므로 기기별로 직접 들고 다닌다.
function device() {
  let cookie = null;
  return async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.()[0];
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, setCookie };
  };
}

try {
  const a = device();
  const b = device();

  console.log('세션 쿠키');
  const signup = await a('/api/signup', { method: 'POST', body: { nickname: '하루' } });
  check('가입 -> 201', signup.status === 201);
  check('쿠키에 HttpOnly', /HttpOnly/i.test(signup.setCookie ?? ''), signup.setCookie?.slice(0, 40));
  check('쿠키에 SameSite', /SameSite/i.test(signup.setCookie ?? ''));

  console.log('');
  console.log('기록 강탈 차단');
  const steal = await b('/api/signup', { method: 'POST', body: { nickname: '하루' } });
  check('다른 기기에서 같은 닉네임 -> 409', steal.status === 409, steal.data.error);

  for (const path of ['/api/me', '/api/me/recent', '/api/me/weather']) {
    const res = await b(path);
    check(`쿠키 없이 ${path} -> 401`, res.status === 401);
  }
  const post = await b('/api/me/attendance', { method: 'POST' });
  check('쿠키 없이 출석 체크 -> 401', post.status === 401);

  // 예전에는 /api/users/:id로 아무 id나 조회할 수 있었다 (IDOR)
  const idor = await b(`/api/users/${signup.data.id}`);
  check('예전 IDOR 경로 -> 404', idor.status === 404);

  console.log('');
  console.log('세션 보호');
  const again = await a('/api/signup', { method: 'POST', body: { nickname: '딴이름' } });
  check('세션 있는 채로 재가입 -> 기존 기록 반환', again.status === 200 && again.data.id === signup.data.id);
  check('새 사용자를 만들지 않는다', again.data.nickname === '하루');

  console.log('');
  console.log('닉네임 변경');
  await b('/api/signup', { method: 'POST', body: { nickname: '민수' } });
  const collide = await b('/api/me/nickname', { method: 'PUT', body: { nickname: '하루' } });
  check('남의 닉네임으로 개명 -> 409', collide.status === 409, collide.data.error);

  const same = await b('/api/me/nickname', { method: 'PUT', body: { nickname: '민수' } });
  check('자기 닉네임으로 개명 -> 200', same.status === 200);

  const renamed = await a('/api/me/nickname', { method: 'PUT', body: { nickname: '하루v2' } });
  check('개명해도 같은 사용자', renamed.status === 200 && renamed.data.id === signup.data.id);

  console.log('');
  console.log('출석 창은 서버가 계산한다');
  const mine = await a('/api/me');
  check('/api/me가 checkin_window를 내려준다', mine.data.checkin_window != null);
  // 서버를 EARLY_CHECKIN_WINDOW_MINUTES=90으로 띄웠으니 목표 06:30의 하한은 05:00이다.
  // 화면이 180을 하드코딩하고 있으면 03:30이 나와 여기서 어긋난다.
  check(
    '창이 환경변수를 따라간다',
    mine.data.checkin_window?.earliest === '05:00',
    `earliest=${mine.data.checkin_window?.earliest} goal=${mine.data.checkin_window?.goal}`
  );

  console.log('');
  console.log('랭킹은 공개');
  const board = await device()('/api/leaderboard');
  check('쿠키 없이 랭킹 -> 200', board.status === 200);
  check('랭킹에 설정값이 새지 않는다',
    board.data.every((r) => !('goal_time' in r) && !('latitude' in r)));
} finally {
  server.kill();
}

console.log('');
console.log(failed === 0 ? '전체 통과' : `${failed}개 실패`);
process.exit(failed === 0 ? 0 : 1);
