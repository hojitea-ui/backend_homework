const $ = (id) => document.getElementById(id);

// 신원은 httpOnly 쿠키에 있다. JS에서 읽을 수 없고 localStorage도 쓰지 않는다.
// 그래서 사용자 id를 프론트엔드가 들고 있을 필요가 없다.
let myNickname = null;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error ?? '요청에 실패했습니다.');
  return data;
}

function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
}

// ── 닉네임 정하기 ────────────────────────────
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;

  const nickname = $('nickname').value.trim();
  if (!nickname) return showError($('login-error'), '닉네임을 입력해 주세요.');

  try {
    await api('/signup', { method: 'POST', body: JSON.stringify({ nickname }) });
    await start();
  } catch (err) {
    showError($('login-error'), err.message);
  }
});

// ── 설정 (닉네임 · 목표 시간 · 위치) ─────────
$('edit-settings').addEventListener('click', () => {
  $('settings-form').hidden = false;
  $('edit-settings').hidden = true;
});

$('cancel-settings').addEventListener('click', () => {
  $('settings-form').hidden = true;
  $('edit-settings').hidden = false;
  $('settings-error').hidden = true;
});

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('settings-error').hidden = true;

  const nickname = $('edit-nickname').value.trim();
  const goalTime = $('goal-time').value;
  const locationName = $('location-name').value.trim();

  if (!nickname) return showError($('settings-error'), '닉네임을 입력해 주세요.');
  if (!goalTime) return showError($('settings-error'), '목표 시간을 입력해 주세요.');
  if (!locationName) return showError($('settings-error'), '위치를 입력해 주세요.');

  // 위치가 바뀌면 서버가 좌표를 찾아오므로 응답이 조금 걸린다.
  $('save-settings').disabled = true;
  $('save-settings').textContent = '저장 중...';

  try {
    if (nickname !== myNickname) {
      await api('/me/nickname', { method: 'PUT', body: JSON.stringify({ nickname }) });
    }
    await api('/me/settings', {
      method: 'PUT',
      body: JSON.stringify({ goal_time: goalTime, location_name: locationName }),
    });

    $('settings-form').hidden = true;
    $('edit-settings').hidden = false;
    await Promise.all([renderUser(), renderWeather(), renderLeaderboard()]);
  } catch (err) {
    if (err.status === 401) return showLogin();
    showError($('settings-error'), err.message);
  } finally {
    $('save-settings').disabled = false;
    $('save-settings').textContent = '저장';
  }
});

// ── 출석 체크 ────────────────────────────────
$('check-in').addEventListener('click', async () => {
  $('check-in').disabled = true;
  try {
    const result = await api('/me/attendance', { method: 'POST' });
    const ok = result.today.is_success === 1;
    const time = result.today.checked_at.slice(11, 16);
    setResult(
      ok
        ? `${time} 출석 완료. 목표 ${result.today.goal_time_snapshot} 안에 성공했어요.`
        : `${time} 출석. 목표 ${result.today.goal_time_snapshot}을 넘겨서 연속 기록이 끊겼어요.`,
      ok ? 'success' : 'fail'
    );
    await Promise.all([renderUser(), renderRecent(), renderLeaderboard()]);
  } catch (err) {
    if (err.status === 401) return showLogin();
    setResult(err.message, 'fail');
    // 버튼 상태는 DB의 오늘 기록을 보고 다시 결정한다.
    // '너무 이르다'고 거절된 경우엔 아침에 다시 누를 수 있어야 하므로 잠그면 안 된다.
    await renderUser();
  }
});

function setResult(message, kind) {
  const el = $('check-result');
  el.textContent = message;
  el.className = `result ${kind}`;
  el.hidden = false;
}

// ── 렌더링 ──────────────────────────────────
async function renderUser() {
  const user = await api('/me');
  myNickname = user.nickname;

  const date = new Date(`${user.server_date}T00:00:00`);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][date.getDay()];
  $('today-date').textContent = `${date.getMonth() + 1}월 ${date.getDate()}일 ${weekday}요일`;
  $('greeting').textContent = `${user.nickname}님, 좋은 아침이에요!`;

  const goal = user.settings.goal_time;
  $('goal-display').textContent = goal;
  // 하한선은 서버가 EARLY_CHECKIN_WINDOW_MINUTES로 계산한 값을 그대로 쓴다.
  const { earliest } = user.checkin_window;
  $('window-hint').textContent = `${earliest} ~ ${goal} 사이에 누르면 성공`;

  $('edit-nickname').value = user.nickname;
  $('goal-time').value = goal;
  $('location-name').value = user.settings.location_name;
  $('coord-hint').textContent =
    `현재 좌표 ${user.settings.latitude.toFixed(4)}, ${user.settings.longitude.toFixed(4)}`;

  $('best-streak').textContent = `${user.best_streak}일`;
  $('current-streak').textContent = `${user.current_streak}일`;

  if (user.today) {
    $('check-in').disabled = true;
    $('check-in').textContent = '오늘 출석 완료';
    if ($('check-result').hidden) {
      const time = user.today.checked_at.slice(11, 16);
      setResult(
        user.today.is_success === 1
          ? `${time}에 출석했어요. 목표 ${user.today.goal_time_snapshot} 달성.`
          : `${time}에 출석했어요. 목표 ${user.today.goal_time_snapshot}을 넘겼어요.`,
        user.today.is_success === 1 ? 'success' : 'fail'
      );
    }
  } else {
    $('check-in').disabled = false;
    $('check-in').textContent = '출석 체크';
  }
}

async function renderWeather() {
  const w = await api('/me/weather');
  const temp = w.temp_c === null ? '--' : `${Math.round(w.temp_c)}°`;
  $('weather').innerHTML = '';

  const strong = document.createElement('strong');
  strong.textContent = temp;
  const label = document.createElement('span');
  label.textContent = `${w.location_name} · ${w.condition}`;

  $('weather').append(strong, label);
}

const STATUS_LABEL = { success: '성공', fail: '실패', absent: '기록 없음' };

async function renderRecent() {
  const rows = await api('/me/recent');
  $('recent').innerHTML = '';

  for (const row of rows) {
    const [, month, day] = row.check_date.split('-');
    const li = document.createElement('li');

    const date = document.createElement('span');
    date.textContent = `${Number(month)}월 ${Number(day)}일`;

    const badge = document.createElement('span');
    badge.className = `badge ${row.status}`;
    badge.textContent = STATUS_LABEL[row.status];

    li.append(date, badge);
    $('recent').append(li);
  }
}

async function renderLeaderboard() {
  const rows = await api('/leaderboard');
  $('leaderboard').innerHTML = '';

  // 기록 0일인 사람은 뷰에서 걸러지므로, 아무도 성공한 적 없으면 목록이 빈다.
  if (rows.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 기록이 없어요. 첫 성공을 노려보세요.';
    $('leaderboard').append(li);
    return;
  }

  for (const row of rows) {
    const li = document.createElement('li');

    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = `${row.rank}위`;

    const name = document.createElement('span');
    name.textContent = row.nickname;

    const streak = document.createElement('span');
    streak.className = 'streak';
    streak.textContent = `${row.best_streak}일`;

    // 내 줄 강조는 여기서 해야 한다. 출석 체크 뒤 랭킹을 다시 그리므로
    // 최초 렌더 때 한 번만 칠하면 지워진다.
    if (row.nickname === myNickname) li.classList.add('me');

    li.append(rank, name, streak);
    $('leaderboard').append(li);
  }
}

async function start() {
  $('login').hidden = true;
  $('app').hidden = false;

  // 랭킹에서 내 줄을 강조하려면 닉네임이 필요하므로 사용자 정보를 먼저 받는다.
  await renderUser();
  await Promise.all([renderWeather(), renderRecent(), renderLeaderboard()]);
}

// 쿠키가 있으면 바로 앱으로, 없거나 만료됐으면 닉네임 화면으로.
start().catch((err) => {
  showLogin();
  if (!(err instanceof ApiError && err.status === 401)) {
    showError($('login-error'), err.message);
  }
});
