import 'dotenv/config';
import { db } from './db.js';

const CACHE_MINUTES = Number(process.env.WEATHER_CACHE_MINUTES ?? 30);

// Open-Meteo가 돌려주는 WMO 날씨 코드 → 한글
const WMO = {
  0: '맑음', 1: '대체로 맑음', 2: '구름 조금', 3: '흐림',
  45: '안개', 48: '서린 안개',
  51: '약한 이슬비', 53: '이슬비', 55: '강한 이슬비',
  56: '얼어붙는 이슬비', 57: '얼어붙는 이슬비',
  61: '약한 비', 63: '비', 65: '강한 비',
  66: '얼어붙는 비', 67: '얼어붙는 비',
  71: '약한 눈', 73: '눈', 75: '강한 눈', 77: '진눈깨비',
  80: '소나기', 81: '소나기', 82: '강한 소나기',
  85: '소낙눈', 86: '강한 소낙눈',
  95: '뇌우', 96: '우박 뇌우', 99: '우박 뇌우',
};

const selectFresh = db.prepare(`
  SELECT temp_c, condition, fetched_at
  FROM weather_cache
  WHERE location_key = ? AND expires_at > datetime('now', 'localtime')
`);

const selectAny = db.prepare(
  'SELECT temp_c, condition, fetched_at FROM weather_cache WHERE location_key = ?'
);

const upsert = db.prepare(`
  INSERT INTO weather_cache (location_key, temp_c, condition, payload_json, fetched_at, expires_at)
  VALUES (?, ?, ?, ?, datetime('now', 'localtime'), datetime('now', 'localtime', ?))
  ON CONFLICT(location_key) DO UPDATE SET
    temp_c       = excluded.temp_c,
    condition    = excluded.condition,
    payload_json = excluded.payload_json,
    fetched_at   = excluded.fetched_at,
    expires_at   = excluded.expires_at
`);

export async function getWeather(latitude, longitude) {
  // 좌표를 소수점 2자리로 깎아서 캐시 키를 만든다.
  // 같은 도시 안에서 좌표가 조금씩 달라도 캐시 한 줄을 공유하게 하려는 목적.
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;

  const fresh = selectFresh.get(key);
  if (fresh) return { ...fresh, source: 'cache' };

  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${latitude}&longitude=${longitude}`
    + '&current=temperature_2m,weather_code&timezone=auto';

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);

    const payload = await res.json();
    const tempC = payload.current?.temperature_2m ?? null;
    const condition = WMO[payload.current?.weather_code] ?? '알 수 없음';

    upsert.run(key, tempC, condition, JSON.stringify(payload), `+${CACHE_MINUTES} minutes`);
    return { temp_c: tempC, condition, fetched_at: null, source: 'api' };
  } catch (err) {
    // API가 죽었거나 인터넷이 끊겼을 때 만료된 캐시라도 보여준다.
    // 캐시 테이블을 둔 이유의 절반이 이것.
    const stale = selectAny.get(key);
    if (stale) return { ...stale, source: 'stale' };
    return { temp_c: null, condition: '날씨를 불러올 수 없음', fetched_at: null, source: 'error' };
  }
}
