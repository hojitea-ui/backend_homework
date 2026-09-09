## 오늘도 하루를 시작해볼까요?

기상 후 출석체크 앱. 목표 시간 안에 출석하면 연속 기록(스트릭)이 쌓이고, 닉네임별로 최고기록 랭킹을 볼 수 있습니다.

# **🔗 https://haru-checkin.fly.dev**

### 호스팅: https://fly.io/
#### 고른 이유<br>
① SQLite 기반 웹페이지를 배포하기에 적합합니다.<br>② 클로드 코드를 활용해 구축하기 편리했습니다.<br>③ 비교적 저렴한 비용으로 서버를 운영할 수 있습니다.

## 로컬 실행

```bash
npm install
cp .env.example .env
npm run initdb
npm start
```

http://localhost:3000

## 스크립트

| 명령 | 하는 일 |
|---|---|
| `npm start` | 서버 실행 |
| `npm run start:prod` | 스키마 적용 후 서버 실행 (컨테이너 시작 명령) |
| `npm run dev` | 파일 변경 시 자동 재시작 |
| `npm run initdb` | `db/schema.sql`을 DB에 적용 (여러 번 실행해도 안전) |
| `npm test` | 전체 검증 (스트릭 + 인증) |
| `npm run test:streak` | 스트릭 로직만 |
| `npm run test:auth` | 인증만 (별도 포트 3999에 서버를 띄워 확인) |

테스트는 `data/test.db`, `data/test-auth.db`를 따로 만들어 쓰므로 실제 DB를 건드리지 않습니다.

## 구조

```
db/schema.sql      테이블·뷰 정의
src/db.js          DB 연결, PRAGMA, 로컬 시간 포맷
src/initdb.js      스키마 적용
src/session.js     세션 쿠키 (express-session + SQLite 스토어)
src/attendance.js  출석 체크 + 스트릭 갱신 (트랜잭션)
src/geocode.js     위치 이름 -> 좌표 (Nominatim)
src/weather.js     Open-Meteo 호출 + 캐시
src/routes.js      REST API
src/server.js      Express 서버
public/sky.js      시각에 따라 배경 하늘을 고른다
public/            화면 (빌드 도구 없는 순수 HTML/CSS/JS)
test/streak.mjs    스트릭 로직 테스트
test/auth.mjs      인증 테스트
Dockerfile         이미지 빌드 (네이티브 모듈 + tzdata)
fly.toml           Fly.io 설정 (볼륨, 리전, TZ)
DEPLOY.md          배포 방법과 주의할 점
```

## 데이터베이스

SQLite 파일 하나(`data/haru.db`)에 테이블 5개와 뷰 2개.

```mermaid
erDiagram
    sessions }o..o| users : "sess JSON 안의 userId"
    users ||--|| user_settings : "1:1"
    users ||--o{ attendance : "1:N"
    user_settings }o..o| weather_cache : "location_key로 조회"

    sessions {
        TEXT sid PK
        JSON sess "userId 포함"
        TEXT expire "만료 시각"
    }
    users {
        INTEGER id PK
        TEXT nickname UK "COLLATE NOCASE"
        INTEGER best_streak "최고기록"
        INTEGER current_streak
        TEXT last_success_date "연속 판정 기준"
        TEXT recovery_code_hash UK "SHA-256, 평문 미저장"
        TEXT created_at
    }
    user_settings {
        INTEGER user_id PK "users.id 참조"
        TEXT goal_time "기본 06:00"
        TEXT location_name "기본 서울"
        REAL latitude "지오코딩 결과"
        REAL longitude "지오코딩 결과"
        TEXT updated_at
    }
    attendance {
        INTEGER id PK
        INTEGER user_id FK "users.id 참조"
        TEXT check_date "user_id와 함께 UNIQUE"
        TEXT checked_at "실제 누른 시각"
        TEXT goal_time_snapshot "그날의 목표 시간"
        INTEGER is_success "0 또는 1"
    }
    weather_cache {
        INTEGER id PK
        TEXT location_key UK "좌표 소수점 2자리"
        REAL temp_c
        TEXT condition
        TEXT payload_json "API 원본"
        TEXT fetched_at
        TEXT expires_at "만료 시각"
    }
```

실선은 외래키, 점선은 외래키 없는 논리적 연결입니다.

| 테이블 | 역할 |
|---|---|
| **users** | 닉네임(신원) + 스트릭. 최고기록을 여기 들고 있습니다 |
| **user_settings** | 목표 시간, 날씨 위치. users와 1:1이라 `user_id`가 곧 PK |
| **attendance** | 하루 1행. `UNIQUE (user_id, check_date)`로 중복 출석 차단 |
| **weather_cache** | 위치별 1행. 여러 사용자가 같은 도시면 한 행을 공유합니다 |
| **sessions** | 세션 스토어가 만들고 관리. `db/schema.sql`에는 없습니다 |

### 점선 관계 두 개

**`sessions` → `users`** — 사용자 id가 `sess` JSON 문자열 **안에** 있어서 SQLite가 강제할 수 있는 관계가 아닙니다. 그래서 `users` 행을 지워도 세션 행에 `ON DELETE CASCADE`가 걸리지 않습니다. 죽은 세션이 남지만, 다음 요청에서 사용자를 못 찾으면 401을 돌려줍니다([src/routes.js](src/routes.js)의 `me()`). 만료된 세션은 스토어가 15분마다 청소합니다.

**`user_settings` → `weather_cache`** — 캐시는 사용자가 아니라 **위치**에 속한 데이터입니다. `location_key`(좌표를 소수점 2자리로 깎은 문자열)로 조회할 뿐 관계가 아닙니다.

### 뷰 2개

**`v_recent_3days`** — 최근 3일을 `success` / `fail` / `absent` 세 상태로 돌려줍니다. `LEFT JOIN`이라 출석하지 않은 날도 빈 줄로 나옵니다.

**`v_leaderboard`** — `best_streak > 0`인 사람만 보여줍니다. `WHERE`가 윈도우 함수보다 먼저 평가되므로 걸러낸 뒤 1위부터 번호가 붙습니다. 동점자는 `RANK()`로 나란히 같은 순위입니다.

### sessions는 왜 schema.sql에 없나

`better-sqlite3-session-store`가 서버 시작 시 알아서 만듭니다. 라이브러리가 테이블 모양을 바꿀 수 있으니 직접 정의하지 않는 편이 안전합니다.

그 대가로 **`npm run initdb` 직후에는 테이블이 4개고, 서버를 한 번 띄우면 5개가 됩니다.** DB를 열어보고 혼란스럽지 않도록 `db/schema.sql`에도 주석으로 적어뒀습니다.

### 성공 조건

기본 목표 시간은 **06:00**이고, 그때 출석을 받는 창은 **03:00 ~ 06:00**입니다.

| 누른 시각 | 결과 |
|---|---|
| 02:59 이전 | 거절 (기록 남지 않음) |
| 03:00 | 성공 (하한 경계 포함) |
| 06:00 | 성공 (목표 경계 포함) |
| 06:01 이후 | 실패 — 연속 기록 끊김 |

**하한선은 목표 시간 −3시간입니다.** 밤을 새운 사람이 새벽에 눌러 성공을 챙기는 걸 막습니다. 목표를 05:00으로 당기면 하한도 02:00으로 함께 당겨집니다. `.env`의 `EARLY_CHECKIN_WINDOW_MINUTES`로 조절합니다.

**너무 이른 체크인은 실패로 기록하지 않고 거절합니다.** 하루 한 행(`UNIQUE`) 제약 때문에 여기서 행을 만들면 정작 아침에 진짜 출석을 못 하게 됩니다.

**유예 시간은 없습니다.** 목표가 06:00이면 06:01은 곧바로 실패입니다. 느슨하게 하려면 목표 시간 자체를 늦추면 됩니다.

**주말 예외는 없습니다.** 토·일에 안 누르면 스트릭이 끊깁니다.

목표가 03:00처럼 이르면 하한이 자정을 넘어가는데, 날짜가 걸쳐지는 걸 피하려고 그 경우엔 00:00으로 자릅니다.

### 설계에서 짚어둘 점

**`attendance.goal_time_snapshot`** — 그날 적용된 목표 시간을 행에 복사해 둡니다. 나중에 목표를 06:00에서 07:00으로 바꿔도 과거 기록의 성공/실패 판정이 뒤집히지 않습니다.

**출석 창은 서버가 계산해서 내려줍니다** — `GET /api/me`의 `checkin_window`(`{ earliest, goal }`)가 화면 안내에 그대로 쓰입니다. 예전에는 프론트엔드가 하한선을 직접 계산했는데, `EARLY_CHECKIN_WINDOW_MINUTES`를 바꾸면 판정은 새 값을 따르고 안내만 180분을 그대로 보여줬습니다.

**`npm run initdb`는 기존 DB도 맞춰 줍니다** — `CREATE TABLE IF NOT EXISTS`는 이미 있는 테이블을 건드리지 않아서, 컬럼을 지울 때는 따로 처리해야 합니다. 쓰지 않던 `attendance.weather_summary`를 뺄 때 `ALTER TABLE ... DROP COLUMN`을 `src/initdb.js`에 넣었습니다.

**스트릭에 결석 처리 로직이 없습니다** — `last_success_date`가 '어제'가 아니면 `current_streak`이 1부터 다시 시작합니다. 하루라도 비면 자동으로 끊기므로 결석을 따로 기록하거나 배치로 훑을 필요가 없습니다.

**`PRAGMA foreign_keys`는 연결마다 켜야 합니다** — `journal_mode = WAL`은 DB 파일에 저장되지만 `foreign_keys`는 연결에만 적용됩니다. 안 켜면 잘못된 `user_id`가 **에러 없이 조용히** 들어갑니다. `src/db.js`에서 처리합니다.

**날씨 캐시는 만료된 값도 씁니다** — API가 죽거나 인터넷이 끊기면 `expires_at`이 지난 캐시라도 보여줍니다(`source: 'stale'`).

## 배경 — 여는 시각의 하늘

기상 시간 앱이라 배경이 지금 시각의 하늘을 따라갑니다. 이미지도 라이브러리도 쓰지 않고 CSS 그라데이션만 씁니다. `public/sky.js`가 `<html>`에 `data-sky`를 붙이고(`dawn`/`morning`/`day`/`dusk`/`night`) CSS가 그 값에 따라 색 변수만 갈아끼웁니다. 첫 페인트 전에 색이 정해지도록 `<head>`에서 동기적으로 실행합니다 — `body` 끝에서 실행하면 기본값이 한 번 번쩍입니다.

목표 시간대(기본 06:00)는 **여명**에 들어갑니다. 여명과 황혼 그라데이션은 아래쪽이 밝아지므로(복숭아색, 주황색) 그 시간대에는 카드도 짙은 남색 반투명으로 바꿔야 흰 글씨가 읽힙니다.

5개 시간대 전부 본문·보조 글씨·버튼이 WCAG AA(4.5:1)를 넘습니다. 이 과정에서 원래 쓰던 초록색 `#1d9e75`가 흰 글씨와 3.39:1로 기준에 못 미친다는 걸 발견해서 `#15805e`(4.91:1)로 한 단계 어둡게 잡았습니다.

## 인증 — 쿠키 + 복구 코드

**비밀번호가 없습니다.** 닉네임을 정하면 서버가 세션을 만들고 httpOnly 쿠키를 내려줍니다. 평소 신원은 그 쿠키입니다.

- 세션 id 생성, 쿠키 서명, 만료는 직접 만들지 않고 `express-session`에 맡깁니다
- 세션은 `better-sqlite3-session-store`로 같은 SQLite 파일에 저장되므로 서버를 재시작해도 유지됩니다

**쿠키를 잃어도 되찾을 길이 하나 있습니다.** 가입할 때 복구 코드를 한 번 보여줍니다. 그 코드를 가진 사람은 쿠키가 없어도, 다른 기기에서도 `POST /api/recover`로 기록을 되찾습니다.

처음에는 복구 수단 없이 순수 기기 바인딩이었는데, **브라우저 기록을 습관적으로 지우는 사용자에게는 앱을 쓸 수 없게 만드는 설계**였습니다. 쿠키를 한 번 밀면 스트릭이 초기화되고 닉네임은 주인 없이 잠깁니다.

### 복구 코드를 해시로 저장하는 이유

이 코드를 가진 사람은 어느 기기에서든 계정을 엽니다. **즉 사실상 비밀번호입니다.** 그래서 평문을 저장하지 않고 SHA-256 해시만 남깁니다. DB 파일이나 볼륨 스냅샷이 유출돼도 그 값으로는 로그인할 수 없습니다.

**느린 해시(bcrypt, argon2)를 쓰지 않았습니다.** 코드가 `randomBytes(16)` = 128비트 난수라 오프라인 전수 대입의 대상이 아니기 때문입니다. 느린 해시는 사람이 정한 짧은 비밀번호를 지키려는 장치이고, 여기서는 엔트로피가 그 역할을 대신합니다. 덕분에 해싱 라이브러리 없이 `node:crypto`만으로 끝납니다.

**대신 코드를 짧게 만들면 이 논리가 무너집니다.** 56비트쯤으로 줄이면 유출된 해시를 GPU로 밀어볼 수 있는 범위에 들어와서 느린 해시가 필요해집니다. 길이는 공짜라 128비트를 택했습니다 — 어차피 복사해 붙여넣는 값이라 사람이 외울 일이 없습니다.

### 다시 보여줄 수 없어서 '재발급'입니다

해시만 갖고 있으니 서버도 코드를 복원할 수 없습니다. 그래서 설정 화면에는 '코드 보기'가 없고 **'새로 발급'만 있습니다.** 새로 발급하면 옛 코드는 그 즉시 무효가 됩니다.

평문으로 저장해서 언제든 보여주는 선택지도 있었지만 택하지 않았습니다. **코드를 볼 수 있는 화면에 들어가려면 어차피 로그인 상태여야 하는데, 문제가 되는 상황은 정확히 로그인이 풀렸을 때**입니다. 그 경우 평문이어도 볼 방법이 없으므로, 보안만 낮추고 실익이 없습니다.

### 시도 횟수를 제한합니다

`POST /api/recover`는 이 앱에서 유일하게 추측을 시도할 수 있는 입구입니다. 128비트라 현실적으로 못 맞히지만, 무제한으로 두드릴 수 있게 두지는 않았습니다. IP당 10분에 10회까지이고 `RECOVER_MAX_ATTEMPTS`, `RECOVER_WINDOW_MINUTES`로 조절합니다. 머신 1대로만 돌리므로 메모리에 셉니다.

틀린 코드에는 401만 돌려줍니다. 코드가 틀렸는지 그런 계정이 없는지 구분해서 알려주지 않습니다.

### 그 밖의 규칙

**닉네임은 선점 방식입니다.** 이미 쓰는 닉네임으로 가입하면 409로 거절합니다. 복구 코드가 인증을 맡으므로 닉네임은 더 이상 신원이 아니지만, 남의 이름을 가로채 랭킹에서 혼동을 주는 것은 여전히 막아야 합니다.

이미 이 기기에 기록이 있는 상태에서 `/api/signup`을 부르면 새로 만들지 않고 기존 기록을 돌려줍니다. 세션을 새 사용자로 갈아타면 이전 기록이 주인 없이 남기 때문입니다.

닉네임을 바꾸고 싶을 때는 `PUT /api/me/nickname`으로 **이름만** 바꿉니다. 기록은 그대로 유지됩니다.

### 삭제는 사용자가 직접 합니다

`DELETE /api/me`로 기록을 지웁니다. `users` 한 행만 지우면 `ON DELETE CASCADE`가 설정과 출석 기록을 함께 지우고, 닉네임도 다시 쓸 수 있게 풀립니다. `sessions`는 외래키 관계가 아니라 CASCADE가 안 걸리므로 `req.session.destroy()`로 직접 파기합니다.

**닉네임을 그대로 입력해야 지워집니다.** 이 앱은 '우발적 상실은 막는다'는 원칙으로 만들어져서 로그아웃 버튼도 두지 않았는데, 삭제 버튼만 클릭 한 번으로 동작하면 앞뒤가 맞지 않습니다. 되돌릴 수 없는 동작이라 의사를 한 번 더 확인합니다.

**활동이 없다고 자동으로 지우지는 않습니다.** 쿠키가 지워진 것과 며칠 안 들어온 것이 서버에서 똑같이 보이기 때문입니다. 부재를 추측해 지우면 여행 다녀온 사람의 기록이 날아갑니다. 그래서 삭제는 사용자가 명시적으로 요청할 때만 합니다.

그 대가로 **쿠키와 복구 코드를 모두 잃은 계정은 주인 없이 남습니다.** 닉네임이 잠기고, 성공 기록이 있었다면 랭킹에도 남습니다. 지금 규모에서는 감수할 만한 비용이라고 봤습니다.

## 위치 설정

위치 이름만 입력하면 서버가 좌표를 찾아옵니다. 좌표를 직접 입력할 필요가 없습니다.

지오코딩은 **OpenStreetMap Nominatim**을 씁니다. Open-Meteo의 지오코딩을 먼저 시도했지만 한글이 신뢰할 수 없었습니다. `서울`과 `제주`는 결과가 없고 `부산`은 경북의 작은 마을이 1순위로 나왔습니다. Nominatim은 `서울`, `부산`, `제주`, `강남구` 모두 정확합니다.

Nominatim은 커뮤니티 서비스이고 이용 정책(User-Agent 명시, 초당 1회 이하)이 있습니다. 사용자가 위치를 바꿀 때만 호출하므로 개인용 규모에서는 문제없지만, 사용자가 많아지면 유료 지오코더로 갈아타야 합니다.

## API

인증이 필요한 경로는 쿠키가 없으면 401을 돌려줍니다.

| 메서드 | 경로 | 인증 | 설명 |
|---|---|---|---|
| POST | `/api/signup` | — | 닉네임 선점 + 세션 생성. 복구 코드를 한 번 돌려줍니다. 중복이면 409 |
| POST | `/api/recover` | — | 복구 코드로 기록 되찾기. 틀리면 401, 너무 잦으면 429 |
| GET | `/api/me` | 필요 | 내 정보 + 설정 + 오늘 출석 상태 + 출석 창 |
| PUT | `/api/me/nickname` | 필요 | 닉네임만 변경 (기록 유지) |
| PUT | `/api/me/settings` | 필요 | 목표 시간, 날씨 위치 변경 |
| POST | `/api/me/attendance` | 필요 | 오늘 출석 체크 |
| POST | `/api/me/recovery-code` | 필요 | 복구 코드 재발급 (옛 코드는 즉시 무효) |
| DELETE | `/api/me` | 필요 | 기록 영구 삭제. 닉네임을 그대로 보내야 합니다 |
| GET | `/api/me/recent` | 필요 | 최근 3일 |
| GET | `/api/me/weather` | 필요 | 날씨 (캐시 우선) |
| GET | `/api/leaderboard` | — | 최고기록 순위 (공개) |

경로에 사용자 id가 없습니다. 예전에는 `/api/users/:id`였는데 아무 id나 넣으면 남의 기록이 그대로 나왔습니다(IDOR). 지금은 항상 세션의 사용자만 봅니다.

## 환경 변수

`.env.example`을 `.env`로 복사해서 씁니다. `.env`는 `.gitignore`에 있습니다.

**`SESSION_SECRET`이 진짜 비밀값입니다.** 쿠키 서명에 쓰이며, 이 값이 바뀌면 모든 사용자가 로그아웃됩니다. 복구 코드를 저장해 둔 사람은 되찾을 수 있지만 그렇지 않은 사람은 기록을 잃으므로, 한 번 정하면 바꾸지 않습니다. 없거나 32자보다 짧으면 서버가 새 값을 만들어 알려주고 종료합니다.

새로 만들기:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`RECOVER_MAX_ATTEMPTS`(기본 10)와 `RECOVER_WINDOW_MINUTES`(기본 10)로 복구 시도 횟수를 제한합니다.

새 사용자의 기본 목표 시간은 `DEFAULT_GOAL_TIME`(기본 `06:00`)으로 정합니다. 스키마의 `DEFAULT`가 아니라 앱이 들고 있는 값입니다 — `CREATE TABLE IF NOT EXISTS`는 이미 있는 테이블을 건드리지 않고 SQLite는 컬럼 `DEFAULT`를 `ALTER`로 바꿀 수 없어서, 스키마만 고치면 이미 배포된 DB의 새 사용자가 옛 기본값을 계속 받습니다.

`NODE_ENV`와 `TZ`는 `.env`에 없습니다. 배포에서만 필요하고 `Dockerfile`과 `fly.toml`이 넣어 줍니다. 로컬에서는 둘 다 없는 게 정상입니다 — `NODE_ENV`가 없으면 `secure` 쿠키가 꺼지고(localhost는 http라 켜면 로그인이 안 됩니다), `TZ`는 OS 설정을 씁니다.

날씨(Open-Meteo)와 지오코딩(Nominatim)은 API 키가 필요 없습니다. 키가 필요한 API로 갈아타면 `WEATHER_API_KEY`를 `.env`에 넣고 `src/weather.js`의 URL 조립 부분만 고치면 됩니다.

## 배포

배포된 앱은 **https://haru-checkin.fly.dev** 입니다 (Fly.io 도쿄 리전, 머신 1대 + 1GB 볼륨에 SQLite).

배포 방법과 주의할 점은 [DEPLOY.md](DEPLOY.md)에 따로 정리했습니다 — 타임존을 안 맞추면 출석 판정이 조용히 깨지는 문제, 볼륨이 머신 1대에만 붙는 제약, `secure` 쿠키와 `trust proxy`가 짝이어야 하는 이유가 거기 있습니다.

## 사용한 것

Express 5, better-sqlite3, express-session, better-sqlite3-session-store, dotenv, Open-Meteo, Nominatim. 모두 무료입니다.

세션은 직접 만들지 않고 `express-session`을 씁니다. 복구 코드가 128비트 난수라 느린 해시가 필요 없어서, 해싱은 `node:crypto`의 SHA-256으로 끝냅니다 — 해싱 라이브러리를 따로 쓰지 않습니다.

## 회고

백엔드 과제를 시작하기 전까지는 사이트를 구현한다는 것 자체가 막막하게 느껴졌지만, 막상 실습해보니 생각보다 어렵지 않다는 것을 알게 되었다.

처음에는 단순히 아침 일찍 일어나고 싶은 사람들을 위한 '미라클 모닝 앱'으로 기획하고 AI에게도 그 방향으로만 지시했는데, 대화를 이어가며 낮밤이 바뀌어 낮에 일어나야 하는 사람들도 있다는 점을 고려해 설계를 확장하게 되었다. AI와의 대화를 통해 미처 생각하지 못했던 관점을 발견할 수 있어 좋았다.

기록이 영구적으로 유실되지 않도록 쿠키 삭제 시를 대비한 코드 발급 기능을 넣었는데, 이는 예전에 비슷한 서비스를 이용했던 경험에서 착안했다. 다만 사용자가 직접 삭제할 수 없는 기록이 더미 데이터로 남아 운영자 측 DB만 불필요하게 무거워지지 않을지도 함께 고민했다.
