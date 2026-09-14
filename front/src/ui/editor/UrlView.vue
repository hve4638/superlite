<script setup lang="ts">
// URL 탭 (ticket browser-tab-iframe) — 최소 브라우저 바(뒤로·앞으로·새로고침·주소칸·외부 열기) + sandbox iframe.
// 부모(EditorGroupView)가 v-show 로 붙여 두므로 탭을 오가도 페이지가 다시 로드되지 않는다.
//
// 보안: 앱 origin 과 같은 URL 은 거부한다 — allow-same-origin 이 붙은 같은 origin 프레임은 부모 window 와
// Tauri IPC(boot_info 의 데몬 토큰)에 닿는다. cross-origin 프레임에는 allow-same-origin 을 줘도 부모에 못 닿고
// (조사 실측 SecurityError), 빼면 dev 앱의 localStorage·cookie 가 깨지므로 준다. 리다이렉트로 앱 origin 에
// 도달하는 우회는 load 때 contentWindow.location 접근이 성공하는 성질로 잡아 프레임을 내린다.
// 스킴은 http(s) 만 — javascript: 프레임은 부모 origin 을 상속한다. allow-top-navigation 계열은 주지 않아
// 프레임이 앱 창 자체를 다른 URL 로 바꿀 수 없다.
//
// 주소칸은 입력한 URL 만 보인다 — 프레임 안에서 링크를 따라간 현재 URL 은 cross-origin 이라 읽을 수 없다
// (VS Code Simple Browser 와 같은 제약, 실제 추적은 browser-tab-full 의 자식 웹뷰). 새로고침·외부 열기도
// 입력한 URL 기준. 뒤로/앞으로는 부모 history 를 움직이되 urlNav 장부로 앱 페이지를 떠나지 않게 한다.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { editors, navigateUrlTab, pushUrlDiag } from '../../model/editors';
import { errText, notify } from '../../model/notifications';
import { clearWebviewCache, openExternal } from '../../model/window';
import { canGoBack, canGoForward, goBack, goForward, onFrameGone, onFrameLoad } from './urlNav';

const props = defineProps<{ groupId: number; tabId: string; url: string }>();
// iframe 안의 클릭은 부모에 mousedown 이 오지 않아 그룹 활성화가 빠진다 — HtmlPreview 와 같은 window blur 트릭
const emit = defineEmits<{ focus: [] }>();
const frame = ref<HTMLIFrameElement | null>(null);
const addr = ref<HTMLInputElement | null>(null);
const input = ref(props.url);
const src = ref(props.url);
/** 새로고침은 프레임을 다시 만든다 — src 재대입은 프레임 안 현재 문서와 같으면 무시될 수 있다 */
const frameKey = ref(0);
const error = ref('');
/** 현재 항해의 load 를 받았는가 — 받기 전에는 프레임 바탕을 흰색 대신 편집기 배경색으로 둔다 (흰 번쩍임 방지).
 *  숨기지는 않는다 — load 는 하위 리소스까지 끝나야 오므로 느린 리소스 하나에 페이지 전체가 가려진다 */
const loaded = ref(false);
/** 마지막으로 load 를 받은 프레임 요소 — 요소가 바뀌었으면 그 프레임의 첫 로드 (urlNav 가 세지 않는다) */
let loadedEl: HTMLIFrameElement | null = null;

// 진단 (ticket url-tab-slow-first-load, 임시) — 창 안에서 몇 번째 프레임 항해인지(첫 프레임 비용 분리)와 항해 시각.
// 같은 URL 을 프레임 밖에서 no-cors fetch 해 네트워크 왕복만 따로 잰다 (응답은 안 읽는다)
let navSeq = 0;
let navAt = 0;
let navNo = 0;
function diagNav(u: string): void {
  navNo = ++navSeq;
  navAt = performance.now();
  pushUrlDiag(props.tabId, `nav#${navNo} ${u}`);
  const t = performance.now();
  fetch(u, { mode: 'no-cors', cache: 'no-store', credentials: 'omit' }).then(
    () => pushUrlDiag(props.tabId, `fetch#${navNo} ok ${Math.round(performance.now() - t)}ms`),
    (e: unknown) => pushUrlDiag(props.tabId, `fetch#${navNo} fail ${Math.round(performance.now() - t)}ms ${String(e)}`),
  );
}

/** 입력 → URL. 스킴이 없으면 http://. http(s) 외·앱 origin 은 거부 (사유는 error 에) */
function normalize(raw: string): string | null {
  const s = raw.trim();
  if (s === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    error.value = `Invalid URL: ${s}`;
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    error.value = `Only http(s) URLs can be opened: ${s}`;
    return null;
  }
  if (u.origin === location.origin) {
    error.value = `Refusing to open the app's own origin: ${u.href}`;
    return null;
  }
  return u.href;
}

function submit(): void {
  error.value = '';
  const u = normalize(input.value);
  if (u === null) {
    if (error.value !== '') {
      onFrameGone(props.tabId);
      src.value = '';
    }
    return;
  }
  input.value = u;
  if (u === props.url) void reload();
  else navigateUrlTab(props.tabId, u);
}
/** hard(새로고침 아이콘 Ctrl+클릭)면 프레임을 다시 만들기 전에 웹뷰 캐시를 비운다 — cross-origin 프레임은
 *  부모가 캐시 무시 재로드를 시킬 수 없다 (주소에 임시 쿼리를 붙이는 우회는 사이트가 보는 URL 을 바꿔 쓰지 않는다).
 *  비우기가 실패해도 새로고침 자체는 한다 — 사유만 알린다 */
async function reload(hard = false): Promise<void> {
  if (src.value === '') return;
  if (hard) await clearWebviewCache().catch((e: unknown) => notify('error', `Clearing cache failed: ${errText(e)}`));
  onFrameGone(props.tabId);
  loaded.value = false;
  frameKey.value++;
  diagNav(src.value);
}
function onLoad(): void {
  const el = frame.value;
  const first = el !== loadedEl;
  pushUrlDiag(props.tabId, `load#${navNo} ${Math.round(performance.now() - navAt)}ms since nav (first=${first})`);
  loadedEl = el;
  loaded.value = true;
  const w = el?.contentWindow;
  // cross-origin 이면 location 접근이 던진다 — 성공하면 앱 origin 문서가 프레임에 들어온 것 (about:blank 제외)
  let reached: string | null = null;
  try {
    reached = w?.location.href ?? null;
  } catch {
    reached = null;
  }
  if (reached !== null && reached !== 'about:blank') {
    onFrameGone(props.tabId);
    src.value = '';
    error.value = `Refusing to show the app's own origin (reached via redirect): ${reached}`;
    return;
  }
  onFrameLoad(props.tabId, first);
}

watch(() => props.url, (u) => {
  input.value = u;
  error.value = '';
  loaded.value = false;
  src.value = u;
  if (u !== '') diagNav(u);
});

// 포커스 요청 소비 — 빈 탭은 주소칸으로. 페이지가 있으면 프레임에 주지 않는다 (프레임이 포커스를 가지면
// 앱 단축키가 안 먹어 탭바 클릭으로 돌아올 길이 막힌다) — 요청만 지운다
const isActiveTab = () => {
  if (editors.activeGroupId !== props.groupId) return false;
  const g = editors.groups.find((g) => g.id === props.groupId);
  return g?.activeTabId === props.tabId;
};
function consumeFocus(): void {
  editors.pendingFocus = false;
  if (props.url === '') void nextTick(() => addr.value?.focus());
}
watch(
  () => editors.pendingFocus && isActiveTab(),
  (on) => { if (on) consumeFocus(); },
);
function onWindowBlur(): void {
  if (frame.value !== null && document.activeElement === frame.value) emit('focus');
}
onMounted(() => {
  window.addEventListener('blur', onWindowBlur);
  pushUrlDiag(props.tabId, 'mount');
  if (src.value !== '') diagNav(src.value);
  if (editors.pendingFocus && isActiveTab()) consumeFocus();
});
onBeforeUnmount(() => {
  window.removeEventListener('blur', onWindowBlur);
  onFrameGone(props.tabId);
});
</script>

<template>
  <div class="url-view">
    <div class="bar">
      <span class="nav codicon codicon-arrow-left" :class="{ disabled: !canGoBack(tabId) }" title="Back" @click="goBack(tabId)" />
      <span class="nav codicon codicon-arrow-right" :class="{ disabled: !canGoForward(tabId) }" title="Forward" @click="goForward(tabId)" />
      <span
        class="nav codicon codicon-refresh"
        :class="{ disabled: src === '' }"
        title="Reload (Ctrl+Click to clear cache)"
        @click="void reload($event.ctrlKey)"
      />
      <input
        ref="addr"
        v-model="input"
        class="addr"
        type="text"
        spellcheck="false"
        placeholder="http://localhost:5173/"
        @keydown.enter.prevent="submit()"
        @keydown.escape.prevent="input = url"
        @focus="($event.target as HTMLInputElement).select()"
      >
      <span class="nav codicon codicon-link-external" :class="{ disabled: url === '' }" title="Open in External Browser" @click="openExternal(url)" />
    </div>
    <div v-if="error !== ''" class="blocked">{{ error }}</div>
    <iframe
      v-else-if="src !== ''"
      ref="frame"
      :key="frameKey"
      class="frame"
      :class="{ loaded }"
      :src="src"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
      :title="url"
      @load="onLoad"
    />
    <div v-else class="empty" />
  </div>
</template>

<style scoped>
.url-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--vscode-editor-background);
}
.bar {
  flex-shrink: 0;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-bottom: 1px solid var(--vscode-editorGroup-border);
  color: var(--vscode-foreground);
  user-select: none;
}
.nav {
  font-size: 16px;
  padding: 3px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--vscode-icon-foreground);
}
.nav:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.nav.disabled {
  opacity: 0.35;
  pointer-events: none;
}
.addr {
  flex: 1;
  min-width: 0;
  margin: 0 6px;
  height: 22px;
  padding: 0 6px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font: inherit;
  outline: none;
}
.addr:focus {
  border-color: var(--vscode-focusBorder);
}
.frame {
  flex: 1;
  min-height: 0;
  border: 0;
  background: var(--vscode-editor-background);
}
.frame.loaded {
  background: #fff;
}
.empty {
  flex: 1;
}
.blocked {
  padding: 16px;
  color: var(--vscode-errorForeground, #f48771);
  word-break: break-all;
}
</style>
