-- "오늘도 하루를 시작해볼까요?" — SQLite 스키마
-- 최고기록 = 연속 성공 일수(스트릭), 닉네임 다중 사용자 + 랭킹, 날씨는 캐시 테이블
--
-- 주의: 아래 두 PRAGMA는 성격이 다름
--   journal_mode = WAL  -> DB 파일에 기록됨. 한 번 켜면 계속 유지
--   foreign_keys = ON   -> 연결에만 적용됨. 이 스크립트가 끝나면 사라짐!
--                          앱에서 DB를 열 때마다 다시 실행해야 ON DELETE CASCADE가 동작함

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────
-- 1. users : 닉네임 = 신원, 스트릭 = 최고기록
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    best_streak       INTEGER NOT NULL DEFAULT 0 CHECK (best_streak    >= 0),
    current_streak    INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    last_success_date TEXT,   -- 'YYYY-MM-DD', 스트릭 연속 판정 기준
    created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    CHECK (length(trim(nickname)) BETWEEN 1 AND 20),
    CHECK (last_success_date IS NULL OR last_success_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE INDEX IF NOT EXISTS idx_users_best_streak ON users (best_streak DESC);

-- ─────────────────────────────────────────────
-- 2. user_settings : 목표 시간 + 날씨 위치 (users와 1:1)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_settings (
    user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    goal_time     TEXT NOT NULL DEFAULT '06:30',
    location_name TEXT NOT NULL DEFAULT '서울',
    latitude      REAL NOT NULL DEFAULT 37.5665,
    longitude     REAL NOT NULL DEFAULT 126.9780,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    CHECK (goal_time GLOB '[0-2][0-9]:[0-5][0-9]'),
    CHECK (latitude  BETWEEN  -90 AND  90),
    CHECK (longitude BETWEEN -180 AND 180)
);

-- ─────────────────────────────────────────────
-- 3. attendance : 출석 기록 (users와 1:N) — 하루 1행
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    check_date         TEXT    NOT NULL,          -- 'YYYY-MM-DD' 로컬 날짜
    checked_at         TEXT    NOT NULL,          -- 'YYYY-MM-DD HH:MM:SS' 실제 누른 시각
    goal_time_snapshot TEXT    NOT NULL,          -- 그날 적용된 목표 시간 (나중에 설정을 바꿔도 과거 판정 불변)
    is_success         INTEGER NOT NULL CHECK (is_success IN (0, 1)),
    UNIQUE (user_id, check_date),                 -- 하루 두 번 출석 방지
    CHECK (check_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    CHECK (goal_time_snapshot GLOB '[0-2][0-9]:[0-5][0-9]')
);

-- ─────────────────────────────────────────────
-- 4. weather_cache : 무료 API 호출 절약용. 사용자와 FK 관계 없음
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weather_cache (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    location_key TEXT NOT NULL UNIQUE,  -- 정규화된 위치 키, 예: '37.57,126.98'
    temp_c       REAL,
    condition    TEXT,
    payload_json TEXT NOT NULL,         -- API 원본 응답 (나중에 필요한 필드가 늘어도 스키마 변경 불필요)
    fetched_at   TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    expires_at   TEXT NOT NULL
);

-- ─────────────────────────────────────────────
-- sessions 테이블은 여기에 없다.
-- better-sqlite3-session-store가 서버 시작 시 알아서 만들고 관리한다.
--   sessions(sid TEXT PK, sess JSON, expire TEXT)
-- 사용자 id는 sess JSON 안에 들어 있어 users와 외래키 관계가 아니다.
-- 라이브러리가 테이블 모양을 바꿀 수 있으니 여기에 직접 정의하지 않는다.
-- 그래서 npm run initdb 직후에는 없고, 서버를 한 번 띄우면 생긴다.
-- ─────────────────────────────────────────────

-- ─────────────────────────────────────────────
-- 조회용 뷰
-- ─────────────────────────────────────────────

-- 최근 3일: 날짜 + 성공/실패/결석 세 가지 상태만
DROP VIEW IF EXISTS v_recent_3days;
CREATE VIEW v_recent_3days AS
WITH d(n) AS (VALUES (0), (1), (2))
SELECT u.id                                           AS user_id,
       u.nickname                                     AS nickname,
       date('now', 'localtime', '-' || d.n || ' day') AS check_date,
       CASE WHEN a.id IS NULL      THEN 'absent'
            WHEN a.is_success = 1  THEN 'success'
            ELSE                        'fail'
       END                                            AS status
FROM users u
CROSS JOIN d
LEFT JOIN attendance a
       ON a.user_id = u.id
      AND a.check_date = date('now', 'localtime', '-' || d.n || ' day');

-- 최고기록 랭킹. 기록이 0일인 사람은 제외한다.
-- WHERE는 윈도우 함수보다 먼저 평가되므로 걸러낸 뒤 1위부터 번호가 붙는다.
DROP VIEW IF EXISTS v_leaderboard;
CREATE VIEW v_leaderboard AS
SELECT nickname,
       best_streak,
       current_streak,
       RANK() OVER (ORDER BY best_streak DESC) AS rank
FROM users
WHERE best_streak > 0;

-- ─────────────────────────────────────────────
-- 출석 체크 시 앱이 실행할 스트릭 갱신 (참고용)
--
--   -- 성공했을 때
--   UPDATE users SET
--     current_streak = CASE
--         WHEN last_success_date = date(:check_date, '-1 day') THEN current_streak + 1
--         ELSE 1
--     END,
--     last_success_date = :check_date
--   WHERE id = :user_id;
--
--   UPDATE users SET best_streak = current_streak
--   WHERE id = :user_id AND current_streak > best_streak;
--
--   -- 실패했을 때
--   UPDATE users SET current_streak = 0 WHERE id = :user_id;
--
-- 결석은 별도 처리 불필요: last_success_date가 '어제'가 아니면 자동으로 1부터 다시 시작
-- ─────────────────────────────────────────────
