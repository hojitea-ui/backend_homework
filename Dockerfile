# better-sqlite3는 네이티브 모듈이라 컨테이너 안에서 빌드해야 한다.
# 로컬 node_modules를 복사하면 Windows용으로 컴파일된 바이너리가 들어가 리눅스에서 안 돈다.
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./

# prebuild 내려받기가 실패하면 소스에서 컴파일해야 하므로 빌드 도구를 넣어 둔다.
#
# npm 11은 의존성의 install 스크립트를 기본으로 차단한다. better-sqlite3는 그 스크립트
# (prebuild-install || node-gyp rebuild)로 네이티브 바이너리를 만들기 때문에, 차단되면
# 설치는 조용히 성공하고 런타임에 bindings 파일을 못 찾아 죽는다.
# CLI 플래그(--allow-scripts)는 프로젝트 설치에서 거부되므로
# package.json의 allowScripts 필드에 better-sqlite3만 허용해 두었다.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev \
 && rm -rf /var/lib/apt/lists/*

FROM node:24-slim
WORKDIR /app

# TZ=Asia/Seoul이 실제로 먹으려면 tzdata가 있어야 한다.
# 없으면 SQLite의 date('now','localtime')과 JS의 getHours()가 조용히 UTC로 떨어지고,
# 한국 아침 06:30 출석이 '전날 21:30, 목표 초과 = 실패'로 기록된다.
RUN apt-get update && apt-get install -y --no-install-recommends tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db
COPY public ./public

# session.js의 secure 쿠키와 server.js의 trust proxy가 이 값으로 켜진다
ENV NODE_ENV=production

EXPOSE 3000

# 볼륨은 비어 있는 상태로 시작하므로 부팅 때 스키마를 적용한다.
# [deploy] release_command는 쓸 수 없다 — 그 머신에는 볼륨이 붙지 않는다.
CMD ["npm", "run", "start:prod"]
