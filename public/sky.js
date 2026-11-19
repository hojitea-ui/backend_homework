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

function applySky() {
  const now = new Date();
  const root = document.documentElement;
  root.dataset.sky = skyFor(now);
  // 상단 하루 막대의 지금 시각 눈금(0~1). 하늘 구간과 같은 시계를 쓴다.
  root.style.setProperty('--now', ((now.getHours() * 60 + now.getMinutes()) / 1440).toFixed(4));
}

applySky();

// 화면을 켜둔 채 시간대가 넘어가도 따라가게
setInterval(applySky, 60 * 1000);
