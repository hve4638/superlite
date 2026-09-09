<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { closeQuickInput, workbench } from '../model/workbench';
import { quickOpen } from '../model/files';
import { commandList, isWorkbenchChord, recentCommands, runCommandFromPalette, type Command } from '../model/commands';
import { editors, openFile } from '../model/editors';
import { openFolder, openFolderDialog, openRootDefault } from '../model/host';
import { inApp } from '../model/window';
import { browseBackend, remoteHost, sessions } from '../model/sessions';
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

/** folder 모드 초기 입력 — 현재 워크스페이스 루트에서 시작한다 (VS Code 원격 열기와 동일).
 *  열린 워크스페이스가 없으면(빈 세션) OS 기본 루트에서 시작한다 — Windows 는 드라이브
 *  루트('C:/'), 그 외 '/'. native 주입값(openRootDefault)이라 웹 서버 OS 와도 맞는다. */
function initialQuery(mode: string): string {
  if (mode === 'commands') return '>';
  if (mode === 'folder') {
    const root = normPath(workbench.rootPath) || openRootDefault;
    return root.endsWith('/') ? root : `${root}/`;
  }
  return '';
}

const query = ref(initialQuery(workbench.quickInput.mode));
// folder 모드는 -1 = 선택 없음. 타이핑 조각과 접두사가 일치하는 첫 후보로 자동 이동하고
// (VS Code simpleFileDialog.setActiveItems), 조각이 비거나 일치가 없으면 -1 이다.
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
    // 나열은 browseBackend — 활성 세션이 빈 세션(무연결)이면 형제 연결 세션에 위임한다
    // (browseDir 는 절대 경로 나열이라 세션과 무관하게 같은 결과다)
    const b = browseBackend();
    if (!isFolderMode.value || !b?.browseDir) return;
    const dir = dirPart.value;
    if (!isAbsDir(dir)) {
      dirListing.value = null;
      return;
    }
    try {
      const names = await b.browseDir(dir);
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

// ------------------------------------------------------------ 파일 모드
// 후보는 백엔드 검색(와이어 v12, VS Code anythingQuickAccess 방식) — 목록은 데몬이 들고
// 프론트는 패턴마다 상위 결과만 받는다. 늦은 응답은 seq 로 버린다
const fileResults = ref<FileItem[]>([]);
let fileSeq = 0;
watch(
  [isFolderMode, isCommandMode, filter],
  async () => {
    if (isFolderMode.value || isCommandMode.value) return;
    const q = filter.value;
    // WHY: VS Code 의 빈 Ctrl+P 는 전체 파일이 아니라 에디터 히스토리를 보여준다.
    //      recency 추적이 없으므로 열린 탭 목록으로 근사하고, 없으면 백엔드 결과로 대체한다.
    if (q === '' && openTabPaths().length) {
      fileResults.value = openTabPaths().map((path) => toFileItem(path, []));
      return;
    }
    const seq = ++fileSeq;
    let items: FileItem[] = [];
    try {
      items = (await quickOpen(q)).items.map((it) => toFileItem(it.path, it.highlights));
    } catch {
      // 연결 끊김 등 — 후보 없음이 곧 피드백이다
    }
    if (seq === fileSeq) fileResults.value = items;
  },
  { immediate: true },
);

function toFileItem(path: string, highlights: number[]): FileItem {
  const slash = path.lastIndexOf('/');
  return {
    kind: 'file', path, name: slash >= 0 ? path.slice(slash + 1) : path,
    dir: slash >= 0 ? path.slice(0, slash) : '', highlights,
  };
}

const items = computed<Item[]>(() => {
  const q = filter.value;
  if (isFolderMode.value) {
    const out: FolderItem[] = [];
    const listing = dirListing.value;
    if (!listing || listing.dir !== dirPart.value) return out;
    // WHY: VS Code simpleFileDialog 는 목록을 거르지 않는다(matchOnLabel=false) — 전체 하위
    //      폴더('..' 포함)를 항상 보이고 타이핑은 선택만 옮긴다 (autoFocusFolder).
    if (!isFsRoot(listing.dir)) {
      const parent = listing.dir.slice(0, listing.dir.lastIndexOf('/', listing.dir.length - 2) + 1);
      out.push({ kind: 'folder', path: parent, name: '..', up: true });
    }
    for (const name of listing.names) {
      out.push({ kind: 'folder', path: listing.dir + name, name });
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
    // 팔레트에서 최근 실행한 명령이 최근 순으로 위, 나머지는 등록 순 (VS Code "recently used" — 구분 라벨은
    // 없다, 사용자 결정 2026-09-09). 입력이 있어도 같은 규칙 — 매칭된 것 안에서만 앞으로 온다
    const rank = (it: CmdItem) => {
      const i = recentCommands.ids.indexOf(it.cmd.id);
      return i < 0 ? Infinity : i;
    };
    return out.sort((a, b) => rank(a) - rank(b));
  }
  return fileResults.value;
});

watch(query, () => {
  if (!isFolderMode.value) focusedIndex.value = 0;
});

/** folder 모드 자동 선택 — 조각과 접두사(대소문자 무시)가 일치하는 첫 후보. '..' 는 제외.
 *  조각이 비면(폴더 진입 직후 `a/b/c/`) 선택 없음. */
function autoFocusFolder(): void {
  const frag = fragment.value.toLowerCase();
  focusedIndex.value = frag === ''
    ? -1
    : items.value.findIndex((it) => it.kind === 'folder' && !it.up && it.name.toLowerCase().startsWith(frag));
}
// 나열이 늦게 도착해도(타이핑이 나열보다 빠른 경우) 선택을 다시 맞춘다
watch(dirListing, () => {
  if (isFolderMode.value) autoFocusFolder();
});

/** 입력창 선택 범위 — Vue 가 :value 를 반영한 뒤에 잡아야 한다 */
async function setInputSelection(start: number, end: number): Promise<void> {
  await nextTick();
  inputEl.value?.setSelectionRange(start, end);
}

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
  if (!isFolderMode.value) return null;
  const listing = dirListing.value;
  if (!listing || listing.dir !== dirPart.value) {
    // 나열 백엔드가 없다(연결 세션 부재 — 앱 첫 기동의 빈 세션 등): 자동완성은 없지만
    // 타이핑한 절대 경로를 그대로 확정 대상으로 삼는다. 실존·디렉토리 검증은 확정처가
    // 한다 (앱 native open_folder_path / 웹 relay ?folder=). 꼬리 '/' 는 그 디렉토리 자체.
    if (!browseBackend()) {
      const q = query.value;
      if (!isAbsDir(q)) return null;
      return isFsRoot(q) ? q : q.replace(/\/$/, '');
    }
    return null;
  }
  const frag = fragment.value;
  // 루트('/'·'C:/')는 꼬리 '/' 를 남긴다 — 'C:' 는 드라이브 상대 경로라 절대 경로가 아니다
  if (frag === '') return isFsRoot(listing.dir) ? listing.dir : listing.dir.slice(0, -1);
  return listing.names.includes(frag) ? listing.dir + frag : null;
});

function onInput(e: Event): void {
  // normPath: Windows 경로 붙여넣기(C:\ 역슬래시)도 '/' 관례로 받아들인다
  query.value = normPath((e.target as HTMLInputElement).value);
  // folder 모드: 방향키로 반영된 이름은 선택 상태라 타이핑이 덮어쓴다 — 새 조각으로 다시 자동 선택
  if (isFolderMode.value) autoFocusFolder();
  else focusedIndex.value = 0;
}

/** OK 확정 대상 — 선택 후보가 있으면 그 경로(VS Code: selectedItems[0].uri), 없으면 입력 경로 */
const confirmTarget = computed<string | null>(() => {
  const it = isFolderMode.value && focusedIndex.value >= 0 ? items.value[focusedIndex.value] : null;
  if (it && it.kind === 'folder') return isFsRoot(it.path) ? it.path : it.path.replace(/\/$/, '');
  return openTarget.value;
});

// 확정 — 입력창 경로의 새 세션. 환경 분기(?folder= 이동 / Tauri native invoke)는 host.openFolder
function confirmOpen(): void {
  const target = confirmTarget.value;
  if (!target) return;
  closeQuickInput();
  openFolder(target);
}

function accept(it: Item): void {
  if (it.kind === 'folder') {
    // 진입·상위 이동 — 입력을 그 경로로 바꾸면 나열이 다시 돈다. 확정은 OK 버튼 또는 선택
    // 없는 상태의 Enter (VS Code simple file dialog 파리티: Enter 는 탐색, OK 가 열기)
    query.value = it.up ? it.path : `${it.path}/`;
    focusedIndex.value = -1;
    void setInputSelection(query.value.length, query.value.length);
    return;
  }
  closeQuickInput();
  // WHY: VS Code 는 quick open 으로 연 에디터를 preview 로 열지 않는다
  //      (workbench.editor.enablePreviewFromQuickOpen 기본값 false)
  if (it.kind === 'file') void openFile(it.path);
  else runCommandFromPalette(it.cmd);
}

function moveFocus(step: 1 | -1): void {
  const n = items.value.length;
  if (!n) return;
  // 선택 없음(-1)에서 아래는 첫 항목, 위는 마지막 항목 (VS Code 리스트 동작). 이후 순환.
  focusedIndex.value = focusedIndex.value < 0
    ? (step > 0 ? 0 : n - 1)
    : (focusedIndex.value + step + n) % n;
  if (!isFolderMode.value) return;
  // folder 모드: 선택 후보 이름을 입력창에 반영하고 그 이름만 선택 상태로 둔다 — 이어서
  // 타이핑하면 덮어써진다. '..' 는 반영하지 않고 폴더 경로만 남긴다
  // (VS Code simpleFileDialog.setAutoComplete force 경로).
  const it = items.value[focusedIndex.value];
  if (!it || it.kind !== 'folder') return;
  const dir = dirPart.value;
  query.value = it.up ? dir : dir + it.name;
  void setInputSelection(dir.length, query.value.length);
}

function onKeydown(e: KeyboardEvent): void {
  // WHY: 팔레트가 열려 있는 동안 전역 키바인딩(ctrl+b 등)이 동작하면 안 된다.
  e.stopPropagation();
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      closeQuickInput();
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
      // folder 모드 — 선택 후보가 있으면 그 폴더로 진입(계속 탐색), 없으면 입력 경로를 확정
      if (isFolderMode.value) {
        const it = focusedIndex.value >= 0 ? items.value[focusedIndex.value] : null;
        if (it && it.kind === 'folder') accept(it);
        else confirmOpen();
        return;
      }
      const it = items.value[focusedIndex.value];
      if (it) accept(it);
      return;
    }
    case 'Tab':
      // folder 모드 — Tab·Shift+Tab 은 아래·위 방향키와 동일
      if (!isFolderMode.value) break;
      e.preventDefault();
      moveFocus(e.shiftKey ? -1 : 1);
      return;
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
    return;
  }
  // 전파를 막은 워크벤치 키바인딩(Ctrl+O 등)은 브라우저 기본 동작(OS 파일 다이얼로그)도 막는다
  if (isWorkbenchChord(e)) e.preventDefault();
  // folder 모드에서 Ctrl+O 를 한 번 더 — 앱은 OS 폴더 다이얼로그로 넘어간다 (웹은 없음).
  // 활성 세션이 원격(ssh://)이면 무시 — OS 다이얼로그는 로컬 폴더만 고르므로 의미가 없다
  if (isFolderMode.value && inApp && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
    const active = sessions.list.find((t) => t.id === sessions.activeId);
    if (active?.root && remoteHost(active.root) !== null) return;
    closeQuickInput();
    openFolderDialog();
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
          :value="query"
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
          <span class="qi-label">{{ it.name }}</span>
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
