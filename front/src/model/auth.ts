/**
 * 웹 접속 인증 게이트 (ticket web-remote-access). 백엔드가 SUPERLITE_PASSWORD 로 떠 있으면 /ws·/nvim·HTTP API
 * 전부가 superlite_auth 쿠키를 요구한다 — 브라우저 WebSocket 은 헤더를 못 붙이므로 쿠키가 유일한 통로다.
 * 부팅(host.ts)이 세션 연결을 열기 전에 ensureWebAuth 로 /auth 를 물어, 401 이면 비밀번호 입력 화면을 띄우고
 * /auth/login 이 쿠키를 심은 뒤에야 진행한다. 쿠키는 HttpOnly·1년 — 폰이 저장해 이후 자동 접속한다.
 * 종전 ?tkn= URL 쿼리는 주소창·히스토리·북마크에 비밀이 남아 폐기했다 (앱은 프로세스 내부 주입이라 그대로).
 * 로그인 화면은 Vue 마운트 전(모듈 평가 중)이라 DOM 을 직접 만든다 — 데스크톱·모바일 셸이 같이 쓴다.
 */

/** 이 페이지의 쿠키가 백엔드에 통하는가 — 401 만 "비밀번호를 물어라". 그 밖(무인증 로컬 204, vite 개발
 *  서버의 404 등)은 통과 */
async function authorized(): Promise<boolean> {
  try {
    return (await fetch('/auth')).status !== 401;
  } catch {
    return true; // 백엔드 부재는 WS 재연결 경로가 알린다 — 여기서 막지 않는다
  }
}

/** 비밀번호 제출 — 일치면 백엔드가 쿠키를 심고 true */
export async function login(password: string): Promise<boolean> {
  const res = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: password });
  return res.ok;
}

/** 부팅 게이트 — 인증될 때까지 돌아오지 않는다 (웹 실백엔드 모드만 부른다) */
export async function ensureWebAuth(): Promise<void> {
  if (await authorized()) return;
  await promptPassword();
}

/** 최소 로그인 화면 — 비밀번호 하나. 성공하면 화면을 걷고 resolve, 실패는 같은 화면에서 재시도 */
function promptPassword(): Promise<void> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.style.cssText =
      'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#1f1f1f;color:#ccc;' +
      'font:14px system-ui,sans-serif;z-index:1000';
    root.innerHTML =
      '<form style="display:flex;flex-direction:column;gap:12px;width:min(320px,90vw)">' +
      '<div style="font-size:18px">Superlite</div>' +
      '<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus ' +
      'style="font:inherit;padding:10px;border:1px solid #3c3c3c;border-radius:4px;background:#313131;color:#ccc;outline:none">' +
      '<button type="submit" style="font:inherit;padding:10px;border:0;border-radius:4px;background:#0078d4;color:#fff">Sign in</button>' +
      '<div data-err style="min-height:1.2em;color:#f48771"></div>' +
      '</form>';
    const form = root.querySelector('form')!;
    const input = root.querySelector('input')!;
    const err = root.querySelector('[data-err]')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void login(input.value).then(
        (ok) => {
          if (!ok) {
            err.textContent = 'Wrong password';
            input.select();
            return;
          }
          root.remove();
          resolve();
        },
        () => {
          err.textContent = 'Cannot reach the backend';
        },
      );
    });
    document.body.append(root);
    input.focus();
  });
}
