<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  scm, activeRepo, selectRepo, openChange, openChangeFile, commit, refreshScm, rescanRepos, stage, unstage,
  requestDiscard, confirmDiscard, cancelDiscard, branches, checkout, sync, CHANGE_LETTER, CHANGE_COLOR,
  type ScmChange, type ScmRepo,
} from '../../model/scm';
import { gitAuth, signInGithub, removeCredential, refreshCredentials } from '../../model/gitauth';
import { openContextMenu, showViewlet, workbench } from '../../model/workbench';
import { revealPath } from '../../model/files';
import { errText, notify } from '../../model/notifications';
import FileIcon from '../widgets/FileIcon.vue';
import ConfirmDialog from '../widgets/ConfirmDialog.vue';
import GitAuthDialog from './GitAuthDialog.vue';

const inputEl = ref<HTMLTextAreaElement>();

/** 선택된 저장소 — 변경·Graph pane 은 이 하나만 보인다 (VS Code Source Control Repositories 뷰 방식) */
const repo = computed(() => activeRepo());
/** 저장소가 둘 이상일 때만 리포지토리 pane 이 보인다 (VS Code 기본 동작) */
const multi = computed(() => scm.repos.length > 1);

/** 저장소 표시 이름 — 루트 저장소는 워크스페이스 이름, 하위는 폴더명 (VS Code 동일) */
function repoTitle(r: ScmRepo): string {
  return r.path === '' ? workbench.workspaceName : r.name;
}
const placeholder = computed(() => `Message (Ctrl+Enter to commit on "${repo.value?.branch ?? ''}")`);
const staged = computed(() => repo.value?.changes.filter((c) => c.staged) ?? []);
const unstaged = computed(() => repo.value?.changes.filter((c) => !c.staged) ?? []);
/** staged 가 없으면 커밋 불가 — 버튼·헤더 체크·Ctrl+Enter 모두 막는다 */
const canCommit = computed(() => staged.value.length > 0);
function doCommit(): void {
  if (repo.value && canCommit.value) void commit(repo.value);
}

// ---- 접기 — 'repos'·'changes'·'graph' pane, 's'·'u' 그룹. 세션 전환·재마운트에 초기화 (ponytail)
const collapsed = reactive(new Set<string>());
function toggle(key: string): void {
  if (collapsed.has(key)) collapsed.delete(key);
  else collapsed.add(key);
}
const twisty = (key: string): string => (collapsed.has(key) ? 'codicon-chevron-right' : 'codicon-chevron-down');

// ---- 선택 — VS Code 리스트처럼 클릭 선택, Ctrl 토글, Shift 범위. 키는 staged 쪽 + 경로
const keyOf = (c: ScmChange): string => `${c.staged ? 's' : 'u'}:${c.path}`;
const selected = reactive(new Set<string>());
let anchor: string | null = null;
/** 리스트가 포커스를 가진 동안만 활성 선택색 — 커밋 입력에 있을 땐 비활성색 (VS Code 동일) */
const listActive = ref(false);
function onFocusIn(e: FocusEvent): void {
  listActive.value = !(e.target instanceof HTMLTextAreaElement);
}
function onFocusOut(e: FocusEvent): void {
  if (!(e.relatedTarget instanceof Node) || !(e.currentTarget as HTMLElement).contains(e.relatedTarget)) listActive.value = false;
}
/** 화면에 보이는 순서의 전체 행 — Shift 범위 선택의 좌표 (접힌 그룹은 제외) */
function visibleRows(): ScmChange[] {
  return [...(collapsed.has('s') ? [] : staged.value), ...(collapsed.has('u') ? [] : unstaged.value)];
}
function onRowClick(c: ScmChange, e: MouseEvent): void {
  const k = keyOf(c);
  if (e.shiftKey && anchor !== null) {
    const keys = visibleRows().map(keyOf);
    const a = keys.indexOf(anchor);
    const b = keys.indexOf(k);
    if (a !== -1 && b !== -1) {
      selected.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selected.add(keys[i]);
      return;
    }
  }
  if (e.ctrlKey || e.metaKey) {
    if (selected.has(k)) selected.delete(k);
    else selected.add(k);
    anchor = k;
    return;
  }
  selected.clear();
  selected.add(k);
  anchor = k;
  void open(c);
}
/** 행 액션의 대상 — 그 행이 선택에 들어 있으면 같은 그룹(staged 쪽)의 선택 전체, 아니면 그 행만 (VS Code 동일) */
function targets(c: ScmChange): ScmChange[] {
  if (!selected.has(keyOf(c))) return [c];
  // WHY: 디렉토리 항목(중첩 저장소)은 명시적으로 그 행을 누른 경우에만 — 범위 선택에 딸려 들어가면
  //      git add 가 안쪽 저장소를 gitlink 로 박아 버린다 (embedded repository 경고 없이)
  return scm.changes.filter((x) => x.staged === c.staged && selected.has(keyOf(x)) && (x === c || !x.rel.endsWith('/')));
}
/** 그룹 전체 액션의 대상 — 디렉토리 항목(중첩 저장소)은 제외한다 (targets 와 같은 이유) */
const bulk = (changes: ScmChange[]): ScmChange[] => changes.filter((c) => !c.rel.endsWith('/'));
/** 변경 목록이 바뀌거나 저장소가 바뀌면 사라진 항목을 선택에서 뺀다 */
watch(() => repo.value?.changes, (changes) => {
  const live = new Set((changes ?? []).map(keyOf));
  for (const k of [...selected]) if (!live.has(k)) selected.delete(k);
});
/** 행 열기 — 디렉토리 항목(중첩 저장소가 부모에 남기는 'vendor/nested/')은 파일이 아니라 탐색기에서 드러낸다 */
async function open(c: ScmChange): Promise<void> {
  if (c.rel.endsWith('/')) {
    showViewlet('explorer');
    await revealPath(c.path.slice(0, -1));
    return;
  }
  await openChange(c);
}

// VS Code git 확장의 discard 확인 문구 — untracked 는 파일 삭제라 DELETE 로 강조한다
const discardMessage = computed(() => {
  const list: ScmChange[] = scm.discardConfirm ?? [];
  const untracked = list.filter((c) => c.kind === 'untracked').length;
  if (list.length === 1) {
    const c = list[0];
    return c.kind === 'untracked'
      ? { message: `Are you sure you want to DELETE '${c.name}'?`,
          detail: 'This is IRREVERSIBLE! This file will be FOREVER LOST if you proceed.',
          label: 'Delete File' }
      : { message: `Are you sure you want to discard changes in '${c.name}'?`,
          detail: 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST.',
          label: 'Discard Changes' };
  }
  return {
    message: `Are you sure you want to discard ALL changes in ${list.length} files?`,
    detail: untracked
      ? `This will DELETE ${untracked} untracked file(s)! This is IRREVERSIBLE!`
      : 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST.',
    label: 'Discard All Changes',
  };
});

/** 브랜치 전환 — 라벨 아래에 브랜치 목록 메뉴 (현재 브랜치는 비활성) */
async function pickBranch(e: MouseEvent): Promise<void> {
  const r = repo.value;
  if (!r) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  let names: string[];
  try {
    names = await branches(r);
  } catch (err) {
    notify('error', `Failed to list branches: ${errText(err)}`);
    return;
  }
  if (!names.length) return;
  openContextMenu(rect.left, rect.bottom + 4, names.map((name) => ({
    label: name === r.branch ? `${name} (current)` : name,
    enabled: name !== r.branch,
    run: () => void checkout(r, name),
  })));
}

/** 재탐색 — 자동 탐색이 놓친 하위 저장소를 다시 찾는다. 알림은 총 개수 (파일 감시·트리 펼침으로
 *  이미 등록된 것과 구분하지 않는다 — "새로 몇 개" 는 사용자가 기대한 수와 어긋나기 쉽다) */
async function rescan(): Promise<void> {
  await rescanRepos();
  const n = scm.repos.length;
  notify('info', n === 0 ? 'No git repositories found' : `${n} git repositor${n === 1 ? 'y' : 'ies'} found`);
}

/** "More Actions..." — 원격 동기화(pull/push/fetch)와 git 계정 관리 (VS Code SCM 제목 메뉴의 자리).
 *  동기화 진행 중이면 그 저장소의 동기화 항목은 비활성. 저장된 자격은 호스트별 Forget 항목으로 */
function moreActions(e: MouseEvent): void {
  const r = repo.value;
  if (!r) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const idle = !r.syncing;
  openContextMenu(rect.left, rect.bottom + 4, [
    { label: 'Pull', enabled: idle, run: () => void sync(r, 'pull') },
    { label: 'Push', enabled: idle, run: () => void sync(r, 'push') },
    { label: 'Fetch', enabled: idle, run: () => void sync(r, 'fetch') },
    { separator: true },
    { label: 'Sign in to GitHub...', run: () => signInGithub() },
    { label: 'Add Git Credential...', run: () => { gitAuth.manual = true; } },
    ...gitAuth.credentials.map((c) => ({
      label: `Forget ${c.label ? `${c.label} (${c.username})` : `${c.username}@${c.host}`}${c.insecure ? ' (file)' : ''}`,
      run: () => void removeCredential(c.host).catch((e) => notify('error', `Failed to forget: ${errText(e)}`)),
    })),
  ]);
}
const authOpen = computed(() => gitAuth.prompt !== null || gitAuth.device !== null || gitAuth.manual);

// WHY: VS Code 는 SCM 뷰를 열면 커밋 입력에 포커스를 준다 — 레퍼런스 스크린샷의
//      파란 focusBorder 상태가 기본 모습이므로 동일하게 재현한다.
onMounted(() => {
  inputEl.value?.focus();
  void refreshCredentials(); // "…" 메뉴의 Forget 목록·대화상자의 키체인 안내
});
</script>

<template>
  <div class="scm-view" :class="{ 'list-active': listActive }" tabindex="0" @focusin="onFocusIn" @focusout="onFocusOut">
    <!-- 리포지토리 pane — 저장소가 둘 이상일 때만 (VS Code Source Control Repositories 뷰). 행 클릭이 아래 두 pane 의 대상을 정한다 -->
    <section v-if="multi" class="pane repos-pane" :class="{ collapsed: collapsed.has('repos') }">
      <div class="pane-header" @click="toggle('repos')">
        <span class="twisty codicon" :class="twisty('repos')" />
        <span class="pane-title">Repositories</span>
        <div class="pane-actions" @click.stop>
          <span class="action codicon codicon-refresh" title="Rescan Repositories" @click="rescan()" />
        </div>
      </div>
      <div v-show="!collapsed.has('repos')" class="pane-body">
        <div
          v-for="r in scm.repos"
          :key="r.path"
          class="repo-row"
          :class="{ selected: r === repo }"
          :title="r.path || workbench.workspaceName"
          @click="selectRepo(r.path)"
        >
          <span class="codicon codicon-repo" />
          <span class="repo-name">{{ repoTitle(r) }}</span>
          <span class="repo-branch">
            <span class="codicon codicon-git-branch" />
            <span>{{ r.branch }}{{ r.dirty ? '*' : '' }}</span>
          </span>
        </div>
      </div>
    </section>
    <section v-if="!repo" class="pane">
      <div class="pane-header">
        <span class="twisty codicon codicon-chevron-down" />
        <span class="pane-title">Source Control</span>
        <div class="pane-actions">
          <span class="action codicon codicon-refresh" title="Rescan Repositories" @click="rescan()" />
        </div>
      </div>
      <div class="pane-body empty-note">No git repositories found in this folder.</div>
    </section>
    <section v-else class="pane" :class="{ collapsed: collapsed.has('changes') }">
      <div class="pane-header" @click="toggle('changes')">
        <span class="twisty codicon" :class="twisty('changes')" />
        <span class="pane-title">Changes</span>
        <span v-if="multi" class="pane-desc">{{ repoTitle(repo) }}</span>
        <div class="pane-actions" @click.stop>
          <span v-if="repo.syncing" class="action codicon codicon-loading codicon-modifier-spin" :title="`Running git ${repo.syncing}...`" />
          <span class="action codicon codicon-check" :class="{ disabled: !canCommit }" title="Commit" @click="doCommit()" />
          <span class="action codicon codicon-refresh" title="Refresh" @click="refreshScm()" />
          <span v-if="!multi" class="action codicon codicon-repo" title="Rescan Repositories" @click="rescan()" />
          <span class="action codicon codicon-ellipsis" title="More Actions..." @click="moreActions" />
        </div>
      </div>
      <div v-show="!collapsed.has('changes')" class="pane-body">
        <div class="input-row">
          <div class="scm-editor">
            <textarea
              ref="inputEl"
              v-model="repo.commitMessage"
              rows="1"
              wrap="off"
              spellcheck="false"
              @keydown.ctrl.enter.prevent="doCommit()"
            />
            <!-- WHY: textarea 네이티브 placeholder 는 ellipsis 가 안 돼서 (레퍼런스는 "··· 로 잘림) 오버레이로 그린다 -->
            <span v-if="!repo.commitMessage" class="placeholder">{{ placeholder }}</span>
          </div>
        </div>
        <div class="button-row">
          <div class="commit-button" :class="{ disabled: !canCommit }" :title="canCommit ? '' : 'Stage changes to commit'" @click="doCommit()">
            <span class="codicon codicon-check" />
            <span>Commit</span>
          </div>
        </div>
        <template v-if="staged.length">
          <div class="group-row" @click="toggle('s')">
            <span class="twistie codicon" :class="twisty('s')" />
            <span class="group-label">Staged Changes</span>
            <div class="group-actions">
              <span class="action codicon codicon-remove" title="Unstage All Changes" @click.stop="unstage(staged)" />
            </div>
            <span class="count-badge">{{ staged.length }}</span>
          </div>
          <template v-if="!collapsed.has('s')">
            <div
              v-for="c in staged"
              :key="'s:' + c.path"
              class="resource-row"
              :class="{ selected: selected.has(keyOf(c)) }"
              :title="c.path"
              @click="onRowClick(c, $event)"
            >
              <FileIcon :name="c.name" />
              <span class="res-name">{{ c.name }}</span>
              <span v-if="c.dir" class="res-desc">{{ c.dir }}</span>
              <span class="letter" :style="{ color: `var(${CHANGE_COLOR[c.kind]})` }">
                {{ CHANGE_LETTER[c.kind] }}
              </span>
              <div class="row-actions">
                <span v-if="c.kind !== 'deleted'" class="action codicon codicon-go-to-file" title="Open File" @click.stop="openChangeFile(c)" />
                <span class="action codicon codicon-remove" title="Unstage Changes" @click.stop="unstage(targets(c))" />
              </div>
            </div>
          </template>
        </template>
        <div class="group-row" @click="toggle('u')">
          <span class="twistie codicon" :class="twisty('u')" />
          <span class="group-label">Changes</span>
          <div class="group-actions">
            <span class="action codicon codicon-discard" title="Discard All Changes" @click.stop="requestDiscard(bulk(unstaged))" />
            <span class="action codicon codicon-add" title="Stage All Changes" @click.stop="stage(bulk(unstaged))" />
          </div>
          <span class="count-badge">{{ unstaged.length }}</span>
        </div>
        <template v-if="!collapsed.has('u')">
          <div
            v-for="c in unstaged"
            :key="'u:' + c.path"
            class="resource-row"
            :class="{ selected: selected.has(keyOf(c)) }"
            :title="c.path"
            @click="onRowClick(c, $event)"
          >
            <FileIcon :name="c.name" />
            <!-- WHY: VS Code SCM 뷰는 파일명에 데코 색을 쓰지 않는다 (scmViewPane.ts fileDecorations colors:false) -->
            <span class="res-name">{{ c.name }}</span>
            <span v-if="c.dir" class="res-desc">{{ c.dir }}</span>
            <span class="letter" :style="{ color: `var(${CHANGE_COLOR[c.kind]})` }">
              {{ CHANGE_LETTER[c.kind] }}
            </span>
            <div class="row-actions">
              <span v-if="c.kind !== 'deleted'" class="action codicon codicon-go-to-file" title="Open File" @click.stop="openChangeFile(c)" />
              <span class="action codicon codicon-discard" title="Discard Changes" @click.stop="requestDiscard(targets(c))" />
              <span class="action codicon codicon-add" title="Stage Changes" @click.stop="stage(targets(c))" />
            </div>
          </div>
        </template>
      </div>
    </section>
    <section v-if="repo" class="pane graph-pane" :class="{ collapsed: collapsed.has('graph') }">
      <div class="pane-header" @click="toggle('graph')">
        <span class="twisty codicon" :class="twisty('graph')" />
        <span class="pane-title">Graph</span>
        <span v-if="multi" class="pane-desc">{{ repoTitle(repo) }}</span>
        <div class="pane-actions" @click.stop>
          <span class="action ref-picker" title="Checkout Branch..." @click="pickBranch">
            <span class="codicon codicon-git-branch" />
            <span class="ref-picker-label">{{ repo.branch || '(no branch)' }}</span>
          </span>
          <span class="action codicon codicon-refresh" title="Refresh" @click="refreshScm()" />
        </div>
      </div>
      <div v-show="!collapsed.has('graph')" class="pane-body">
        <div
          v-for="(item, i) in repo.log"
          :key="item.hash"
          class="history-row"
          :class="{ current: i === 0 }"
          :title="`${item.hash.slice(0, 7)} · ${item.author} · ${item.date}`"
        >
          <svg class="graph" width="22" height="22" viewBox="0 0 22 22">
            <line v-if="i > 0" x1="11" y1="0" x2="11" y2="7" />
            <circle cx="11" cy="11" r="4" />
            <line v-if="i < repo.log.length - 1" x1="11" y1="15" x2="11" y2="22" />
          </svg>
          <span class="hist-name">{{ item.subject }}</span>
          <span class="hist-desc">{{ item.author }}, {{ item.date }}</span>
          <span v-if="i === 0 && repo.branch" class="ref-pill">
            <span class="codicon codicon-target" />
            <span class="ref-name">{{ repo.branch }}</span>
          </span>
        </div>
      </div>
    </section>
    <ConfirmDialog
      v-if="scm.discardConfirm"
      :message="discardMessage.message"
      :detail="discardMessage.detail"
      :confirm-label="discardMessage.label"
      @confirm="confirmDiscard()"
      @cancel="cancelDiscard()"
    />
    <GitAuthDialog v-if="authOpen" />
  </div>
</template>

<style scoped>
.scm-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
/* spec: CHANGES/GRAPH 두 pane 이 사이드바를 정확히 반반 나눈다 (각 354px) */
.pane {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 리포지토리 pane 은 내용 높이(상한 30%)만 — 변경·Graph 가 나머지를 나눈다. 접힌 pane 은 헤더만 */
.repos-pane {
  flex: 0 0 auto;
  max-height: 30%;
}
.pane.collapsed {
  flex: 0 0 auto;
}
/* 저장소 행 — VS Code scm repositories 뷰: repo 아이콘 · 이름 · 오른쪽 브랜치 (dirty 는 *) */
.repo-row {
  display: flex;
  align-items: center;
  height: 22px;
  padding: 0 8px 0 20px;
  cursor: pointer;
  white-space: nowrap;
}
.repo-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.repo-row.selected {
  background: var(--vscode-list-inactiveSelectionBackground);
}
.scm-view.list-active .repo-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.repo-row > .codicon {
  font-size: 16px;
  margin-right: 6px;
  color: var(--vscode-icon-foreground);
}
.repo-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.repo-branch {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: 8px;
  opacity: 0.8;
}
.repo-branch .codicon {
  font-size: 14px;
}
.scm-view {
  outline: none;
}
/* 선택 — 리스트 포커스 중엔 활성색, 커밋 입력 등 다른 곳에 있으면 비활성색 (VS Code list) */
.resource-row.selected {
  background: var(--vscode-list-inactiveSelectionBackground);
}
.scm-view.list-active .resource-row.selected {
  background: var(--vscode-list-activeSelectionBackground);
  color: var(--vscode-list-activeSelectionForeground);
}
.scm-view:has(.multi-repo) .graph-pane {
  flex: 1 0 auto;
  min-height: 140px;
}

/* ── pane 헤더 (paneview.css: 22px / 11px bold uppercase) ── */
.pane-header {
  flex: none;
  height: 22px;
  display: flex;
  align-items: center;
  padding-left: 2px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  background: var(--vscode-sideBarSectionHeader-background);
  color: var(--vscode-sideBarSectionHeader-foreground);
}
.graph-pane .pane-header {
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border);
}
.pane-header .twisty {
  font-size: 16px;
  margin: 0 2px;
}
.pane-title {
  margin-left: 2px;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 저장소 pane 의 설명 열 (다중 저장소: 브랜치명 / Graph: 저장소명) — VS Code pane 헤더 description */
.pane-desc {
  margin-left: 6px;
  font-weight: 400;
  text-transform: none;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty-note {
  padding: 8px 20px;
  color: var(--vscode-descriptionForeground);
}
.pane-actions {
  margin-left: auto;
  margin-right: 8px;
  display: flex;
  align-items: center;
  flex: none;
}
.action {
  font-size: 16px;
  padding: 2px;
  margin-right: 4px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--vscode-icon-foreground);
}
.action:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.ref-picker {
  display: flex;
  align-items: center;
}
.ref-picker .codicon {
  font-size: 16px;
}
.ref-picker-label {
  font-size: 12px;
  margin: 0 2px;
}

.pane-body {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

/* ── 커밋 입력 (spec: 행 34px, 박스 26px, x 67~336) ── */
.input-row {
  padding: 4px 12px 4px 19px;
}
.scm-editor {
  position: relative;
  display: flex;
  align-items: center;
  height: 26px;
  border: 1px solid var(--vscode-input-border);
  border-radius: 4px;
  background: var(--vscode-input-background);
}
.scm-editor:focus-within {
  border-color: var(--vscode-focusBorder);
}
.scm-editor textarea {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 3px 0 3px 6px;
  border: none;
  outline: none;
  resize: none;
  overflow: hidden;
  background: transparent;
  color: var(--vscode-input-foreground);
  font-size: 13px;
  line-height: 18px;
  user-select: text;
  -webkit-user-select: text;
}
.placeholder {
  position: absolute;
  left: 6px;
  right: 6px;
  top: 3px;
  line-height: 18px;
  pointer-events: none;
  color: var(--vscode-input-placeholderForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ── Commit 버튼 (spec: 행 36px, 버튼 24px, x 68~334) ── */
.button-row {
  padding: 6px 13px 6px 20px;
}
.commit-button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  border-radius: 2px;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
  white-space: nowrap;
}
.commit-button:hover {
  background: var(--vscode-button-hoverBackground);
}
/* VS Code button disabled: opacity .4, 클릭 불가 */
.commit-button.disabled,
.action.disabled {
  opacity: 0.4;
  cursor: default;
  pointer-events: none;
}
.commit-button .codicon {
  font-size: 16px;
}

/* ── Changes 그룹 헤더 (spec: 22px, twistie 글리프 x≈61, 라벨 x=78) ── */
.group-row {
  display: flex;
  align-items: center;
  height: 22px;
  cursor: pointer;
  white-space: nowrap;
}
.group-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.group-row .twistie {
  flex: none;
  width: 30px;
  padding: 0 4px 0 10px;
  font-size: 16px;
}
.group-label {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 그룹 액션은 hover 시에만 (VS Code 동작) — 배지는 왼쪽으로 밀린다 */
.group-actions {
  display: none;
  margin-left: auto;
  align-items: center;
  flex: none;
}
.group-row:hover .group-actions {
  display: flex;
}
.group-row:hover .count-badge {
  margin-left: 0;
}
/* monaco-count-badge: 18px 원형, 11px 텍스트 */
.count-badge {
  flex: none;
  margin-left: auto;
  margin-right: 12px;
  min-width: 18px;
  height: 18px;
  padding: 3px 4px;
  border-radius: 11px;
  font-size: 11px;
  line-height: 12px;
  text-align: center;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

/* ── 변경 파일 행 (spec: 22px, 아이콘 x=64, 이름 x=86) ── */
.resource-row {
  display: flex;
  align-items: center;
  height: 22px;
  padding-left: 16px;
  cursor: pointer;
  white-space: nowrap;
}
.resource-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.resource-row .file-icon {
  margin-right: 6px;
}
.res-name {
  flex: none;
  overflow: hidden;
  text-overflow: ellipsis;
}
.res-desc {
  margin-left: 0.5em;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
/* iconlabel.css ::after 데코 수치 (opacity 0.75 / 90% / 600) */
.letter {
  flex: none;
  margin-left: auto;
  margin-right: 14px;
  padding-left: 5px;
  font-size: 90%;
  font-weight: 600;
  opacity: 0.75;
}
.row-actions {
  display: none;
  margin-left: auto;
  margin-right: 6px;
  align-items: center;
  flex: none;
}
/* VS Code 동작: hover 시 상태 글자 대신 액션 아이콘 노출 */
.resource-row:hover .letter {
  display: none;
}
.resource-row:hover .row-actions {
  display: flex;
}

/* ── Graph 커밋 행 (spec: 노드 중심 x=59 r=5, 라벨 x=70, 우측 main pill) ── */
.history-row {
  display: flex;
  align-items: center;
  height: 22px;
  cursor: pointer;
  white-space: nowrap;
}
.history-row:hover {
  background: var(--vscode-list-hoverBackground);
}
.graph {
  flex: none;
}
.graph circle,
.graph line {
  fill: none;
  stroke: var(--vscode-scmGraph-historyItemRefColor);
  stroke-width: 2;
}
.hist-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.hist-desc {
  margin-left: 0.5em;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
}
/* scm.css history-item-current: 이름 600 / 설명 500 */
.history-row.current .hist-name {
  font-weight: 600;
}
.history-row.current .hist-desc {
  font-weight: 500;
}
.ref-pill {
  flex: none;
  margin-left: auto;
  margin-right: 13px;
  display: flex;
  align-items: center;
  height: 18px;
  border-radius: 10px;
  background: var(--vscode-scmGraph-historyItemRefColor);
  color: var(--vscode-scmGraph-historyItemHoverLabelForeground);
}
.ref-pill .codicon {
  font-size: 16px;
  padding: 1px;
}
.ref-name {
  font-size: 12px;
  padding-right: 4px;
}
</style>
