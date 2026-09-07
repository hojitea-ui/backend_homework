// 위치 이름 -> 좌표. OpenStreetMap Nominatim을 쓴다. 무료이고 API 키가 없다.
//
// Open-Meteo 지오코딩을 먼저 시도했지만 한글 입력이 신뢰할 수 없었다.
// '서울'과 '제주'는 결과가 없고, '부산'은 경북의 작은 마을이 1순위로 나왔다.
// Nominatim은 한글 도시명을 정확히 찾는다.
//
// 주의: Nominatim은 커뮤니티 서비스이고 이용 정책이 있다.
//   - User-Agent를 반드시 밝힐 것
//   - 초당 1회 이하
// 사용자가 위치를 바꿀 때만 호출하므로 개인용 규모에서는 문제없다.
// 사용자가 많아지면 유료 지오코더로 갈아타야 한다.
const URL_BASE = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'haru-attendance-app/1.0 (local homework project)';

export class GeocodeError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

export async function geocode(name) {
  const url = `${URL_BASE}?q=${encodeURIComponent(name)}&format=json&limit=1&countrycodes=kr`;

  let results;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    results = await res.json();
  } catch {
    throw new GeocodeError('위치를 찾는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.');
  }

  const hit = results?.[0];
  if (!hit) {
    throw new GeocodeError(`'${name}'을(를) 찾을 수 없어요. 도시나 동 이름으로 입력해 주세요.`);
  }

  return {
    // 화면에 보일 이름은 사용자가 입력한 값을 그대로 쓴다.
    // Nominatim의 display_name은 '금호동, 속초시, 강원특별자치도, 대한민국'처럼 너무 길다.
    location_name: name,
    latitude: Number(hit.lat),
    longitude: Number(hit.lon),
  };
}
