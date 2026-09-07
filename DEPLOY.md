# 배포 — Fly.io

배포된 앱은 **https://haru-checkin.fly.dev** 입니다 (도쿄 리전, 머신 1대 + 1GB 볼륨).

SQLite 파일을 볼륨에 그대로 얹습니다. Postgres로 갈아타지 않으므로 `COLLATE NOCASE`, `GLOB`, `AUTOINCREMENT`, 동기 트랜잭션 같은 SQLite 고유 문법을 한 줄도 고칠 필요가 없습니다.

| 파일 | 하는 일 |
|---|---|
| `Dockerfile` | 이미지 빌드. 네이티브 모듈을 컨테이너 안에서 컴파일하고 `tzdata`를 넣습니다 |
| `.dockerignore` | `node_modules`, `data/`, `.env`를 이미지에서 뺍니다 |
| `fly.toml` | 리전, 볼륨 마운트, 환경 변수, 머신 크기 |

## 타임존이 제일 중요합니다

Fly 머신은 UTC로 돕니다. 이 앱은 로컬 시간 기준으로 날짜와 성공을 판정하므로(`getHours()`, SQLite `date('now','localtime')`) 그대로 두면 조용히 망가집니다.

목표 06:30에 정확히 출석했을 때:

| TZ | check_date | checked_at | 판정 |
|---|---|---|---|
| `Asia/Seoul` | 2026-03-02 | 2026-03-02 06:30:00 | 성공 |
| `UTC` | 2026-03-01 | 2026-03-01 21:30:00 | **실패** |

UTC에서는 21:30이 목표 06:30을 넘겼다고 계산되어 **매일 실패로 기록되고 스트릭이 끊깁니다.** 에러도 안 나고 로그에도 안 남습니다. [src/db.js](src/db.js)의 `localDateTime()` 주석이 걱정하던 상황이 배포하면 현실이 됩니다.

대응 두 가지가 **한 쌍**입니다. `fly.toml`의 `TZ = "Asia/Seoul"`만으로는 부족하고, `node:24-slim`에 `tzdata`가 없어서 `Dockerfile`에서 설치해야 합니다. 하나라도 빠지면 위 표의 UTC 행이 됩니다.

## 머신은 1대여야 합니다

Fly 볼륨은 머신 한 대에만 붙습니다. 2대로 늘리면 두 번째 머신은 빈 볼륨을 보고 **별개의 DB를 만듭니다.** 사용자가 요청마다 다른 기록을 보게 됩니다. 배포 후 `flyctl scale count 1`로 확인합니다.

그 대가로 **배포할 때마다 짧은 다운타임이 있고, 호스트 장애 시 앱이 내려갑니다.** Fly 문서는 볼륨을 2개 이상 두라고 권하지만 순수 SQLite로는 불가능합니다 — 그 답은 LiteFS인데 이 규모에 과합니다. 자동 스냅샷이 기본 5일 보관되지만 Fly도 자체 백업을 따로 하라고 명시합니다. 기기 바인딩이라 기록을 되찾을 방법이 없다는 점과 겹치므로, **볼륨이 날아가면 전부 사라집니다.**

## 스키마는 부팅 때 적용합니다

`[deploy] release_command`를 쓰면 안 됩니다. **릴리스 커맨드 머신에는 볼륨이 붙지 않아서** 빈 임시 디스크에 테이블을 만들고 버려집니다.

그래서 `npm run start:prod`(= `initdb` 후 `server`)를 컨테이너 시작 명령으로 씁니다. `initdb`는 여러 번 실행해도 안전하므로 매 부팅 실행에 문제가 없습니다.

## 쿠키 설정 두 개가 짝입니다

배포하면 HTTPS로 나가므로 `secure` 쿠키를 씁니다. 그런데 Fly는 엣지에서 TLS를 끊고 내부로는 http로 넘기기 때문에, `app.set('trust proxy', 1)`이 없으면 express-session이 요청을 http로 보고 **쿠키를 아예 안 내려줍니다.** 로그인이 조용히 안 되는 형태라 둘은 항상 같이 켜야 합니다. `NODE_ENV=production`이 둘 다를 켭니다.

| 요청 | Set-Cookie |
|---|---|
| `X-Forwarded-Proto: https` | `HttpOnly; Secure; SameSite=Lax` |
| 평문 http | 없음 |

## 배포 순서

```bash
flyctl launch --no-deploy
flyctl secrets set SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
flyctl deploy
flyctl scale count 1
```

`SESSION_SECRET`은 `fly.toml`의 `[env]`가 아니라 **secrets로** 넣습니다. `fly.toml`은 커밋되는 파일입니다. 그리고 **한 번 정하면 바꾸지 않습니다** — 바뀌면 모든 쿠키가 무효가 되고, 기기 바인딩이라 기록을 되찾을 수 없습니다.

## 배포 후 확인

```bash
flyctl ssh console -C "date"          # KST여야 한다
flyctl ssh console -C "ls -la /data"  # haru.db가 볼륨에 있어야 한다
```

`haru.db`가 `/data`가 아니라 `/app/data/`에 있으면 `DB_PATH`가 안 먹은 것이고, 재배포하면 기록이 날아갑니다. 브라우저에서는 쿠키에 `Secure`가 붙는지, 출석 창 안내가 `03:30 ~ 06:30`으로 나오는지(TZ와 `checkin_window`를 한 번에 확인), **머신을 재시작해도 기록이 남는지**(`flyctl machine restart <id>`)를 봅니다. 마지막이 볼륨이 실제로 동작하는지 보는 유일한 테스트입니다.

---

앱 자체에 대한 설명은 [README.md](README.md)에 있습니다.
