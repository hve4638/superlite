// 모바일 셸 설치용 서비스 워커 (ticket mobile-shell) — Android Chrome 의 설치 판정(standalone 으로 뜨는 앱)이 fetch 핸들러가 있는
// 서비스 워커를 요구하던 시절의 조건을 채우기 위한 최소 구현. 캐시하지 않고 그대로 네트워크로 넘긴다 (WebSocket 은 원래
// 서비스 워커를 거치지 않는다)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
