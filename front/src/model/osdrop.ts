import { openFile } from './editors';
import { workbench } from './workbench';

/**
 * OS 파일/폴더 드롭 — 앱(WebView2) 전용. DOM 의 File 객체에는 경로가 없으므로 드롭된
 * File 객체를 chrome.webview 로 native 에 넘기고(경로는 native 만 읽는다), 폴더는 native 가
 * 세션을 전환하며, 파일은 native 가 돌려준 절대 경로를 여기서 루트 상대화해 연다.
 * 브라우저 모드에서는 chrome.webview 가 없어 무동작이다.
 * 탐색기 업로드 존([data-upload-zone] — 원격 세션의 트리, ticket explorer-download) 위의 드롭은
 * 건드리지 않는다 — 그 드롭은 "열기" 가 아니라 원격으로 업로드이고, 탐색기가 DOM 에서 직접 처리한다.
 */

interface WebView2Channel {
  postMessageWithAdditionalObjects?: (message: unknown, objects: unknown[]) => void;
  addEventListener: (type: 'message', cb: (e: { data: unknown }) => void) => void;
}

/** 드롭 대상이 탐색기 업로드 존 안인가 — 그 드롭은 탐색기 몫이라 여기서 손대지 않는다 */
function inUploadZone(e: DragEvent): boolean {
  return (e.target as Element | null)?.closest?.('[data-upload-zone]') != null;
}

export function initOsDrop(): void {
  const webview = (window as { chrome?: { webview?: WebView2Channel } }).chrome?.webview;
  const post = webview?.postMessageWithAdditionalObjects?.bind(webview);
  if (!webview || !post) return;

  // 캡처 단계 + stopPropagation — 'Files' 타입은 OS 발 드래그에만 있어 내부 DnD 는
  // 건드리지 않고, monaco 등 내부 위젯이 OS 드롭을 삼키는 것을 막는다
  for (const type of ['dragenter', 'dragover'] as const) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.dataTransfer?.types.includes('Files') || inUploadZone(e)) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
      },
      { capture: true },
    );
  }
  window.addEventListener(
    'drop',
    (e) => {
      if (!e.dataTransfer?.types.includes('Files') || inUploadZone(e)) return;
      e.preventDefault();
      e.stopPropagation();
      // WHY: File 객체만 넘긴다 — FileSystemHandle 은 WebView2 가 컬렉션에 null 로 넣어
      //      쓸 수 없다 (실측). 드롭된 폴더도 Chromium 은 File 로 주므로 경로는 나오고,
      //      파일/폴더 구분은 native 가 그 경로를 직접 stat 해서 한다.
      const files = [...e.dataTransfer.items]
        .filter((it) => it.kind === 'file')
        .map((it) => it.getAsFile())
        .filter((f) => f !== null);
      if (!files.length) return;
      // WHY: 메시지는 문자열로 — wry IPC 핸들러도 같은 이벤트를 받는데, 문자열이 아니면
      //      오류를 반환해 (구현에 따라) 뒤에 등록된 우리 핸들러까지 건너뛸 수 있다.
      //      우리 쪽 구분은 메시지 내용이 아니라 부속 객체 유무로 한다.
      post('superlite:os-drop', files);
    },
    { capture: true },
  );

  webview.addEventListener('message', (e) => {
    const files = (e.data as { superliteOsDrop?: { files?: string[] } })?.superliteOsDrop?.files;
    if (!files) return;
    for (const abs of files) {
      // 루트 밖 파일도 연다 (VS Code 파리티) — 와이어 절대 경로('/' 구분자)로 그대로
      const rel = relativize(abs);
      void openFile(rel ?? abs.replaceAll('\\', '/'));
    }
  });
}

/** Windows(WebView2) 전용 경로 — 구분자 정규화 후 대소문자 무시 prefix 비교로 루트 상대화 */
function relativize(abs: string): string | null {
  const root = workbench.rootPath.replaceAll('\\', '/').replace(/\/+$/, '');
  const p = abs.replaceAll('\\', '/');
  if (!root || !p.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  return p.slice(root.length + 1);
}

