<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { closeQuickInput, workbench } from '../model/workbench';
import { files } from '../model/files';
import { commandList, type Command } from '../model/commands';
import { editors, openFile } from '../model/editors';
import { backend, openFolder } from '../model/host';
import FileIcon from './widgets/FileIcon.vue';

interface FileItem {
  kind: 'file';
  path: string;
  name: string;
  dir: string;
  highlights: number[];
}
interface CmdItem {
  kind: 'command';
  cmd: Command;
  highlights: number[];
}
interface FolderItem {
  kind: 'folder';
  /** 절대 경로 — up 이면 돌아갈 부모('/' 끝), 아니면 진입할 하위 디렉토리 */
  path: string;
  name: string;
  highlights: number[];
  /** true 면 ".." 상위 이동 행 */
  up?: boolean;
}
type Item = FileItem | CmdItem | FolderItem;

const widgetEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);
const listEl = ref<HTMLElement | null>(null);

/** Windows 드라이브 경로(C:\ 류)만 '/' 구분으로 정규화 — unix 파일명의 '\' 는 합법 문자다 */
function normPath(p: string): string {
  return /^[A-Za-z]:[\\/]/.test(p) ? p.replace(/\\/g, '/') : p;
}
/** browseDir 에 넘길 수 있는 절대 경로인지 — unix '/' 또는 Windows 드라이브 접두사 */
function isAbsDir(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p);
}
/** 파일시스템 루트('/'·'C:/')인지 — '..' 표시와 확정 대상의 꼬리 '/' 처리가 갈린다 */
function isFsRoot(dir: string): boolean {
  return dir === '/' || /^[A-Za-z]:\/$/.test(dir);
}

/** folder 모드 초기 입력 — 현재 워크스페이스 루트에서 시작한다 (VS Code 원격 열기와 동일) */
function initialQuery(mode: string): string {
  if (mode === 'commands') return '>';
  if (mode === 'folder') {
    const root = normPath(workbench.rootPath);
    return root.endsWith('/') ? root : `${root}/`;
  }
  return '';
}

const query = ref(initialQuery(workbench.quickInput.mode));
// folder 모드는 -1 = 목록 선택 없음(입력창 상태) — 화살표로만 목록에 들어간다.
// 파일·커맨드 모드는 종전대로 첫 항목이 기본 포커스다.
const focusedIndex = ref(workbench.quickInput.mode === 'folder' ? -1 : 0);

// folder 모드는 접두사 판별 밖 — 경로에 '>' 가 들어와도 모드가 흔들리지 않게 open 시점에 고정
const isFolderMode = computed(() => workbench.quickInput.mode === 'folder');
// WHY: VS Code 는 단일 위젯이 접두사('>')로 모드를 판별한다 — open 시점의 mode 는 초기값일 뿐.
const isCommandMode = computed(() => !isFolderMode.value && query.value.startsWith('>'));
const filter = computed(() =>
  (isCommandMode.value ? query.value.slice(1) : query.value).toLowerCase(),
);

// ------------------------------------------------------------ folder 모드
// 입력을 "부모 디렉토리(마지막 '/' 까지)" + "타이핑 중 조각" 으로 쪼갠다.
// 부모가 바뀔 때만 백엔드에 하위 디렉토리를 다시 묻고, 조각은 클라이언트에서 거른다.
const dirPart = computed(() => {
  const i = query.value.lastIndexOf('/');
  return i < 0 ? '' : query.value.slice(0, i + 1);
});
const fragment = computed(() => query.value.slice(dirPart.value.length));
/** dirPart 에 대한 최신 나열 결과 — dir 이 현재 입력과 다르면 무시한다 (늦은 응답 가드) */
const dirListing = ref<{ dir: string; names: string[] } | null>(null);

watch(
  [isFolderMode, dirPart],
  async () => {
    if (!isFolderMode.value || !backend.browseDir) return;
    const dir = dirPart.value;
    if (!isAbsDir(dir)) {
      dirListing.value = null;
      return;
    }
    try {
      const names = await backend.browseDir(dir);
      if (dirPart.value === dir) dirListing.value = { dir, names };
    } catch {
      // 실존하지 않는 경로 타이핑 중 — 후보 없음이 곧 피드백이다
      if (dirPart.value === dir) dirListing.value = null;
    }
  },
  { immediate: true },
);

/** 대소문자 무시 subsequence 매칭. 매칭되면 문자 인덱스 배열, 아니면 null. */
function matchSubsequence(target: string, q: string): number[] | null {
  if (!q) return [];
  const t = target.toLowerCase();
  const idx: number[] = [];
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti < 0) return null;
    idx.push(ti);
    ti += 1;
  }
  return idx;
}

function openTabPaths(): string[] {
  const out: string[] = [];
  for (const g of editors.groups) {
    for (const t of g.tabs) if (t.kind === 'file' && !out.includes(t.path)) out.push(t.path);
  }
  // WHY: VS Code 빈 Ctrl+P 의 첫 항목은 "직전" 에디터라 Enter 가 에디터 전환이 된다 —
  //      현재 활성 파일을 맨 뒤로 보내 같은 체감을 만든다.
  const g = editors.groups.find((x) => x.id === editors.activeGroupId);
  const activePath = g?.tabs.find((t) => t.id === g.activeTabId)?.path;
  if (activePath && out.length > 1) {
    out.splice(out.indexOf(activePath), 1);
    out.push(activePath);
  }
  return out;
}

const items = computed<Item[]>(() => {
  const q = filter.value;
  if (isFolderMode.value) {
    const out: FolderItem[] = [];
    const listing = dirListing.value;
    if (!listing || listing.dir !== dirPart.value) return out;
    const frag = fragment.value;
    // ".." 상위 이동 행 (VS Code simple file dialog 파리티) — 타이핑 중엔 필터 밖이라 숨긴다
    if (frag === '' && !isFsRoot(listing.dir)) {
      const parent = listing.dir.slice(0, listing.dir.lastIndexOf('/', listing.dir.length - 2) + 1);
      out.push({ kind: 'folder', path: parent, name: '..', highlights: [], up: true });
    }
    for (const name of listing.names) {
      const hl = matchSubsequence(name, frag.toLowerCase());
      if (hl === null) continue;
      out.push({ kind: 'folder', path: listing.dir + name, name, highlights: hl });
    }
    return out;
  }
  if (isCommandMode.value) {
    const out: CmdItem[] = [];
    for (const cmd of commandList) {
      const hl = matchSubsequence(cmd.title, q);
      if (hl === null) continue;
      out.push({ kind: 'command', cmd, highlights: hl });
    }
    return out;
  }
  const out: FileItem[] = [];
  // WHY: VS Code 의 빈 Ctrl+P 는 전체 파일이 아니라 에디터 히스토리를 보여준다.
  //      recency 추적이 없으므로 열린 탭 목록으로 근사하고, 없으면 전체 파일로 대체한다.
  const source = q === '' && openTabPaths().length ? openTabPaths() : files.allFiles;
  for (const path of source) {
    const slash = path.lastIndexOf('/');
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    // 파일명 우선 매칭, 실패하면 전체 경로로 재시도 (하이라이트는 파일명에만)
    let hl = matchSubsequence(name, q);
    if (hl === null) {
      if (matchSubsequence(path, q) === null) continue;
      hl = [];
    }
    out.push({ kind: 'file', path, name, dir: slash >= 0 ? path.slice(0, slash) : '', highlights: hl });
  }
  return out;
});

watch(query, () => {
  focusedIndex.value = isFolderMode.value ? -1 : 0;
});

// 외부(타이틀바 등)에서 열린 채로 모드가 바뀌는 경우 입력값을 재설정
watch(
  () => workbench.quickInput.mode,
  (mode) => {
    query.value = initialQuery(mode);
    focusedIndex.value = mode === 'folder' ? -1 : 0;
  },
);

watch(focusedIndex, async () => {
  await nextTick();
  listEl.value?.querySelector('.focused')?.scrollIntoView({ block: 'nearest' });
});

function segments(text: string, hl: number[]): { text: string; hl: boolean }[] {
  if (!hl.length) return [{ text, hl: false }];
  const set = new Set(hl);
  const out: { text: string; hl: boolean }[] = [];
  let cur = '';
  let curHl = set.has(0);
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== curHl) {
      out.push({ text: cur, hl: curHl });
      cur = '';
      curHl = h;
    }
    cur += text[i];
  }
  out.push({ text: cur, hl: curHl });
  return out;
}

/** 타이핑된 입력이 가리키는 실존 디렉토리 — 조각이 비면 부모 자체(나열 성공이 실존
 *  증거), 아니면 후보와 정확 일치해야 한다. */
const openTarget = computed<string | null>(() => {
  const listing = dirListing.value;
  if (!isFolderMode.value || !listing || listing.dir !== dirPart.value) return null;
  const frag = fragment.value;
  // 루트('/'·'C:/')는 꼬리 '/' 를 남긴다 — 'C:' 는 드라이브 상대 경로라 절대 경로가 아니다
  if (frag === '') return isFsRoot(listing.dir) ? listing.dir : listing.dir.slice(0, -1);
  return listing.names.includes(frag) ? listing.dir + frag : null;
});

/** Enter·OK 의 확정 대상 — 화살표로 고른 후보가 있으면 그 경로, 없으면 타이핑된 경로 */
const confirmTarget = computed<string | null>(() => {
  const it = focusedIndex.value >= 0 ? items.value[focusedIndex.value] : null;
  if (it && it.kind === 'folder')
    return it.up ? (isFsRoot(it.path) ? it.path : it.path.slice(0, -1)) : it.path;
  return openTarget.value;
});

/** 입력창 표시 값 — 화살표 선택이 있으면 그 경로가 채워진다 (URL 바 자동완성 방식).
 *  필터(dirPart·fragment)는 타이핑된 query 기준이라 선택 중에도 목록이 안 흔들린다. */
const displayValue = computed(() =>
  isFolderMode.value && focusedIndex.value >= 0 ? (confirmTarget.value ?? query.value) : query.value,
);

function onInput(e: Event): void {
  // 선택 중 타이핑 → 선택 해제·입력창 복귀. 채워진 표시 값에서 이어서 편집된다.
  // normPath: Windows 경로 붙여넣기(C:\ 역슬래시)도 '/' 관례로 받아들인다
  focusedIndex.value = isFolderMode.value ? -1 : 0;
  query.value = normPath((e.target as HTMLInputElement).value);
}

// 확정 — 그 경로의 새 세션. 환경 분기(?folder= 이동 / Tauri native invoke)는 host.openFolder
function confirmOpen(): void {
  const target = confirmTarget.value;
  if (!target) return;
  closeQuickInput();
  openFolder(target);
}

function accept(it: Item): void {
  if (it.kind === 'folder') {
    // 진입·상위 이동 — 입력을 그 경로로 바꾸면 나열이 다시 돈다. 확정은 OK 버튼
    // (VS Code simple file dialog 파리티: Enter 는 탐색, OK 가 열기)
    query.value = it.up ? it.path : `${it.path}/`;
    return;
  }
  closeQuickInput();
  // WHY: VS Code 는 quick open 으로 연 에디터를 preview 로 열지 않는다
  //      (workbench.editor.enablePreviewFromQuickOpen 기본값 false)
  if (it.kind === 'file') void openFile(it.path);
  else it.cmd.run();
}

function moveFocus(dir: 1 | -1): void {
  const n = items.value.length;
  if (!n) return;
  if (isFolderMode.value) {
    // -1(입력창) ↔ 목록 순환 — 목록 끝을 지나면 입력창(타이핑 값 표시)으로 돌아온다
    let next = focusedIndex.value + dir;
    if (next < -1) next = n - 1;
    else if (next >= n) next = -1;
    focusedIndex.value = next;
    return;
  }
  focusedIndex.value = (focusedIndex.value + dir + n) % n;
}

function onKeydown(e: KeyboardEvent): void {
  // WHY: 팔레트가 열려 있는 동안 전역 키바인딩(ctrl+b 등)이 동작하면 안 된다.
  e.stopPropagation();
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      // folder 모드에서 선택 중이면 먼저 선택만 해제(타이핑 값 복원) — 한 번 더 누르면 닫힘
      if (isFolderMode.value && focusedIndex.value >= 0) focusedIndex.value = -1;
      else closeQuickInput();
      return;
    case 'ArrowDown':
      e.preventDefault();
      moveFocus(1);
      return;
    case 'ArrowUp':
      e.preventDefault();
      moveFocus(-1);
      return;
    case 'Enter': {
      e.preventDefault();
      // folder 모드 — 선택 중이면 자동완성만(그 경로로 진입해 계속 탐색), 입력창 상태면 확정 이동
      if (isFolderMode.value) {
        const it = focusedIndex.value >= 0 ? items.value[focusedIndex.value] : null;
        if (it && it.kind === 'folder') query.value = it.up ? it.path : `${it.path}/`;
        else confirmOpen();
        return;
      }
      const it = items.value[focusedIndex.value];
      if (it) accept(it);
      return;
    }
    case 'Tab': {
      // folder 모드 셸식 완성 — 선택(없으면 첫 후보) 하위 디렉토리를 입력에 반영하고 계속 탐색
      if (!isFolderMode.value) break;
      e.preventDefault();
      const it = items.value[Math.max(focusedIndex.value, 0)];
      if (it && it.kind === 'folder' && !it.up) query.value = `${it.path}/`;
      return;
    }
    case 'F1':
      if (isFolderMode.value) break;
      e.preventDefault();
      query.value = '>';
      return;
  }
  if (!isFolderMode.value && e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    // VS Code: 열린 상태의 Ctrl+Shift+P 는 커맨드 모드 전환, Ctrl+P 는 다음 항목 이동
    if (e.shiftKey) query.value = '>';
    else moveFocus(1);
  }
}

function onWindowMouseDown(e: MouseEvent): void {
  if (!widgetEl.value?.contains(e.target as Node)) closeQuickInput();
}

onMounted(async () => {
  window.addEventListener('mousedown', onWindowMouseDown, true);
  await nextTick();
  const el = inputEl.value;
  if (el) {
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', onWindowMouseDown, true);
});

function chips(keybinding: string): string[] {
  return keybinding.split('+');
}

const placeholder = computed(() =>
  isFolderMode.value
    ? 'Enter the absolute path of the folder to open'
    : 'Search files by name (append : to go to line or @ to go to symbol)',
);

function keyOf(it: Item): string {
  if (it.kind === 'command') return it.cmd.id;
  return it.path;
}
</script>

<template>
  <div ref="widgetEl" class="quick-input">
    <div v-if="isFolderMode" class="qi-title">Open Folder</div>
    <div class="qi-header">
      <div class="qi-inputbox">
        <input
          ref="inputEl"
          :value="displayValue"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="placeholder"
          @input="onInput"
          @keydown="onKeydown"
        />
      </div>
      <button
        v-if="isFolderMode"
        class="qi-ok"
        :disabled="!confirmTarget"
        @mousedown.prevent
        @click="confirmOpen"
      >
        OK
      </button>
    </div>
    <div ref="listEl" class="qi-list">
      <div
        v-for="(it, i) in items"
        :key="keyOf(it)"
        class="qi-row"
        :class="{ focused: i === focusedIndex }"
        @mousedown.prevent
        @click="accept(it)"
      >
        <template v-if="it.kind === 'file'">
          <FileIcon :name="it.name" />
          <span class="qi-label">
            <template v-for="(seg, si) in segments(it.name, it.highlights)" :key="si">
              <span v-if="seg.hl" class="qi-hl">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
          <span v-if="it.dir" class="qi-desc">{{ it.dir }}</span>
        </template>
        <template v-else-if="it.kind === 'folder'">
          <span class="qi-label">
            <template v-for="(seg, si) in segments(it.name, it.highlights)" :key="si">
              <span v-if="seg.hl" class="qi-hl">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
        </template>
        <template v-else>
          <span class="qi-label">
            <template v-for="(seg, si) in segments(it.cmd.title, it.highlights)" :key="si">
              <span v-if="seg.hl" class="qi-hl">{{ seg.text }}</span>
              <template v-else>{{ seg.text }}</template>
            </template>
          </span>
          <span class="qi-spacer" />
          <span v-if="it.cmd.keybinding" class="qi-kb">
            <template v-for="(key, ki) in chips(it.cmd.keybinding)" :key="ki">
              <span v-if="ki > 0" class="qi-kb-sep">+</span>
              <span class="qi-kb-key">{{ key }}</span>
            </template>
          </span>
        </template>
      </div>
      <div v-if="items.length === 0" class="qi-row qi-empty">No matching results</div>
    </div>
  </div>
</template>

<style scoped>
.quick-input {
  position: fixed;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 602px;
  max-width: calc(100vw - 16px);
  box-sizing: border-box;
  background: var(--vscode-quickInput-background);
  color: var(--vscode-quickInput-foreground);
  border: 1px solid var(--vscode-widget-border);
  border-radius: 12px;
  box-shadow: var(--vscode-shadow-xl);
  z-index: 2000;
  font-size: 13px;
}
.qi-title {
  text-align: center;
  height: 24px;
  line-height: 24px;
  background: var(--vscode-quickInputTitle-background);
  border-radius: 12px 12px 0 0;
}
.qi-header {
  display: flex;
  gap: 6px;
  padding: 6px 6px 4px;
}
.qi-ok {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border: none;
  border-radius: 4px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  font-size: 13px;
  cursor: pointer;
}
.qi-ok:hover:not(:disabled) {
  background: var(--vscode-button-hoverBackground);
}
.qi-ok:disabled {
  opacity: 0.5;
  cursor: default;
}
.qi-inputbox {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 28px;
  box-sizing: border-box;
  background: var(--vscode-input-background);
  /* WHY: 팔레트가 열려 있는 동안 입력은 항상 포커스 상태 — focusBorder 상시 표시 */
  border: 1px solid var(--vscode-focusBorder);
  border-radius: 4px;
}
.qi-inputbox input {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0 6px;
  background: transparent;
  border: none;
  outline: none;
  color: var(--vscode-input-foreground);
  font-size: 13px;
}
.qi-inputbox input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
.qi-list {
  padding: 2px 6px 7px;
  max-height: min(40vh, 440px);
  overflow-y: auto;
  overflow-x: hidden;
}
.qi-row {
  display: flex;
  align-items: center;
  height: 22px;
  line-height: 22px;
  padding: 0 6px 0 11px;
  border-radius: 3px;
  cursor: pointer;
  white-space: nowrap;
}
.qi-row:not(.focused):not(.qi-empty):hover {
  background: var(--vscode-list-hoverBackground);
}
.qi-row.focused {
  background: var(--vscode-quickInputList-focusBackground);
  color: var(--vscode-quickInputList-focusForeground);
}
.qi-empty {
  cursor: default;
  color: var(--vscode-descriptionForeground);
}
.qi-row .file-icon {
  margin-right: 4px;
  line-height: 22px;
}
.qi-label {
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.qi-desc {
  margin-left: 0.5em;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
.qi-hl {
  color: var(--vscode-list-highlightForeground);
}
.qi-row.focused .qi-hl {
  color: var(--vscode-list-focusHighlightForeground);
}
.qi-spacer {
  flex: 1;
}
.qi-kb {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  /* WHY: 레퍼런스에서 키칩 우측 끝은 행 우측 모서리에서 18px (row padding 6 + 12) */
  margin-right: 12px;
}
.qi-kb-key {
  background: var(--vscode-keybindingLabel-background);
  color: var(--vscode-keybindingLabel-foreground);
  border: 1px solid var(--vscode-keybindingLabel-border);
  border-bottom-color: var(--vscode-keybindingLabel-bottomBorder);
  box-shadow: inset 0 -1px 0 var(--vscode-widget-shadow);
  border-radius: 3px;
  font-size: 11px;
  line-height: 10px;
  padding: 3px 5px;
}
.qi-kb-sep {
  margin: 0 2px;
}
</style>
