// 기상 시간 앱이라 배경이 지금 시각의 하늘을 따라간다.
//
// <head>에서 동기적으로 실행해야 첫 페인트 전에 색이 정해진다.
// body 끝에서 실행하면 낮 계열 기본값이 한 번 번쩍인 뒤 바뀐다.
const BANDS = [
  { until: 4, name: 'night' },    // 22:00~04:00
  { until: 7, name: 'dawn' },     // 04:00~07:00  목표 시간대
  { until: 11, name: 'morning' }, // 07:00~11:00
  { until: 17, name: 'day' },     // 11:00~17:00
  { until: 22, name: 'dusk' },    // 17:00~22:00
];

function skyFor(date = new Date()) {
  const hour = date.getHours();
  return (BANDS.find((band) => hour < band.until) ?? { name: 'night' }).name;
}

// ── 파비콘(탭·북마크바 아이콘)도 같은 하늘을 따라간다 ──
// 먹색 판에 하늘 창, 지평선 위 해(밤엔 초승달), 아래에 정체성 서명 3색 띠.
// 색은 style.css의 시간대별 값(하늘 그라데이션, --mark, --id-1~3)과 같게 맞춘다.
// public/favicon.svg는 스크립트가 돌기 전·크롤러용 기본값으로, 아래 'day'와 같은 그림이다.
const ICON = {
  //         하늘 위 → 아래              해·달 [cx, cy, r]   해·달빛      서명 3색
  night:   { sky: ['#070b20', '#1c2148'], sun: [21, 10, 5], mark: '#f0dc8c', id: ['#7088e0', '#6e5cd6', '#f0dc8c'], moon: true },
  dawn:    { sky: ['#27306a', '#e39c73'], sun: [16, 23, 7], mark: '#ffa463', id: ['#6e5cd6', '#ee7a9c', '#ffa463'] },
  morning: { sky: ['#86b6e3', '#f3e9da'], sun: [22, 11, 5], mark: '#ffd36b', id: ['#2763a3', '#4db8e6', '#ffd36b'] },
  day:     { sky: ['#a9cdec', '#eef1f1'], sun: [16, 8, 5],  mark: '#ffd36b', id: ['#1f6f86', '#4db8e6', '#a6e3c8'] },
  dusk:    { sky: ['#523263', '#e5964f'], sun: [10, 23, 7], mark: '#ffc066', id: ['#5a3b9e', '#ee7a9c', '#ffc066'] },
};

function iconSvg(name) {
  const { sky, sun: [cx, cy, r], mark, id, moon } = ICON[name] ?? ICON.day;
  // 초승달은 해 원에서 오른쪽 위로 비켜 놓은 원을 마스크로 도려낸다
  const body = moon
    ? `<mask id="m"><rect width="32" height="32" fill="#fff"/><circle cx="${cx + 3}" cy="${cy - 2}" r="${r}" fill="#000"/></mask>`
      + `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${mark}" mask="url(#m)"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${mark}"/>`;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">'
    + `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="1" stop-color="${sky[1]}"/></linearGradient>`
    + '<clipPath id="w"><path d="M3 3h21l5 5v15H3z"/></clipPath></defs>'
    + '<path d="M0 0h25l7 7v25H0z" fill="#30383d"/>'          // 먹색 판, 오른쪽 위 깎은 모서리
    + `<g clip-path="url(#w)"><rect width="32" height="32" fill="url(#g)"/>${body}</g>`
    + '<path d="M3 23h26" stroke="#e7e9e7" stroke-opacity=".55"/>' // 지평선
    + `<rect x="3" y="26" width="6" height="3" fill="${id[0]}"/>`
    + `<rect x="10" y="26" width="6" height="3" fill="${id[1]}"/>`
    + `<rect x="17" y="26" width="6" height="3" fill="${id[2]}"/>`
    + '</svg>';
}

let iconBand = null;
function applyIcon(name) {
  if (name === iconBand) return; // 같은 시간대면 다시 그리지 않는다(탭 아이콘 깜빡임 방지)
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  link.href = `data:image/svg+xml,${encodeURIComponent(iconSvg(name))}`;
  iconBand = name;
}

function applySky() {
  const now = new Date();
  const root = document.documentElement;
  const name = skyFor(now);
  root.dataset.sky = name;
  // 상단 하루 막대의 지금 시각 눈금(0~1). 하늘 구간과 같은 시계를 쓴다.
  root.style.setProperty('--now', ((now.getHours() * 60 + now.getMinutes()) / 1440).toFixed(4));
  applyIcon(name);
}

applySky();

// 화면을 켜둔 채 시간대가 넘어가도 따라가게
setInterval(applySky, 60 * 1000);
