<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { search, setQuery, toggleCase, toggleFileCollapsed, matchCount } from '../../model/search';
import { openFileAt } from '../../model/editors';
import type { FileSearchResult } from '../../backend/types';
import FileIcon from '../widgets/FileIcon.vue';

const inputEl = ref<HTMLInputElement | null>(null);
const replaceVisible = ref(false);
// 장식 토글 — 검색 동작에는 반영되지 않는다 (backend 계약에 옵션 없음)
const wholeWord = ref(false);
const useRegex = ref(false);

// WHY: VS Code 는 검색 뷰를 열면 즉시 검색 입력에 포커스를 준다
onMounted(() => inputEl.value?.focus());

function onInput(e: Event): void {
  setQuery((e.target as HTMLInputElement).value);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
function dirName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}
function fileMatchCount(f: FileSearchResult): number {
  return f.matches.reduce((n, m) => n + m.ranges.length, 0);
}

/** VS Code strings.lcut — 매치 앞 텍스트를 단어 경계에서 26자 미만으로 잘라 '…' 을 붙인다 */
function lcut(text: string, n: number): string {
  const trimmed = text.trimStart();
  if (trimmed.length < n) return trimmed;
  const re = /\b/g;
  let i = 0;
  while (re.test(trimmed)) {
    if (trimmed.length - re.lastIndex < n) break;
    i = re.lastIndex;
    re.lastIndex += 1;
  }
  if (i === 0) return trimmed;
  return '…' + trimmed.substring(i).trimStart();
}

interface MatchRow {
  line: number;
  before: string;
  inside: string;
  after: string;
}

/** 매치 range 하나당 행 하나 (VS Code 와 동일) */
function rowsOf(f: FileSearchResult): MatchRow[] {
  const rows: MatchRow[] = [];
  for (const m of f.matches) {
    for (const [start, end] of m.ranges) {
      rows.push({
        line: m.line,
        before: lcut(m.lineText.slice(0, start), 26),
        inside: m.lineText.slice(start, end),
        after: m.lineText.slice(end),
      });
    }
  }
  return rows;
}

const resultMessage = computed(() => {
  if (!search.query || !search.done) return '';
  const n = matchCount();
  const m = search.results.length;
  if (n === 0) return '';
  return `${n} result${n === 1 ? '' : 's'} in ${m} file${m === 1 ? '' : 's'}`;
});
const noResults = computed(() => Boolean(search.query) && search.done && search.results.length === 0);
</script>

<template>
  <div class="search-view">
    <div class="widgets">
      <div class="search-widget">
        <div
          class="toggle-replace"
          title="Toggle Replace"
          @click="replaceVisible = !replaceVisible"
        >
          <span class="codicon" :class="replaceVisible ? 'codicon-chevron-down' : 'codicon-chevron-right'" />
        </div>
        <div class="search-container">
          <div class="inputbox">
            <input
              ref="inputEl"
              class="input search-input"
              placeholder="Search"
              spellcheck="false"
              autocomplete="off"
              :value="search.query"
              @input="onInput"
            />
            <div class="controls">
              <div
                class="option-toggle"
                :class="{ active: search.caseSensitive }"
                title="Match Case (Alt+C)"
                @click="toggleCase()"
              >
                <span class="codicon codicon-case-sensitive" />
              </div>
              <div
                class="option-toggle"
                :class="{ active: wholeWord }"
                title="Match Whole Word (Alt+W)"
                @click="wholeWord = !wholeWord"
              >
                <span class="codicon codicon-whole-word" />
              </div>
              <div
                class="option-toggle"
                :class="{ active: useRegex }"
                title="Use Regular Expression (Alt+R)"
                @click="useRegex = !useRegex"
              >
                <span class="codicon codicon-regex" />
              </div>
            </div>
          </div>
        </div>
        <div v-if="replaceVisible" class="replace-container">
          <div class="inputbox">
            <input
              class="input replace-input"
              placeholder="Replace"
              spellcheck="false"
              autocomplete="off"
            />
          </div>
          <div class="replace-actions">
            <div class="option-toggle" title="Replace All">
              <span class="codicon codicon-replace-all" />
            </div>
          </div>
        </div>
      </div>
      <div class="query-details">
        <div class="more" title="Toggle Search Details">
          <span class="codicon codicon-ellipsis" />
        </div>
      </div>
    </div>

    <div v-if="resultMessage || noResults" class="messages">
      <div v-if="resultMessage" class="message">
        {{ resultMessage }} -&nbsp;<a class="message-link">Open in editor</a>
      </div>
      <div v-else class="message">
        No results found. Review your settings for configured exclusions and check your gitignore files.
      </div>
    </div>

    <div class="results">
      <template v-for="f in search.results" :key="f.path">
        <div class="row filematch" @click="toggleFileCollapsed(f.path)">
          <span
            class="twistie codicon"
            :class="search.collapsed.has(f.path) ? 'codicon-chevron-right' : 'codicon-chevron-down'"
          />
          <FileIcon :name="baseName(f.path)" />
          <span class="label">{{ baseName(f.path) }}</span>
          <span v-if="dirName(f.path)" class="description">{{ dirName(f.path) }}</span>
          <span class="badge">{{ fileMatchCount(f) }}</span>
        </div>
        <template v-if="!search.collapsed.has(f.path)">
          <div
            v-for="(r, i) in rowsOf(f)"
            :key="`${f.path}:${i}`"
            class="row match"
            @click="openFileAt(f.path, r.line + 1)"
          >
            <span class="match-text">{{ r.before }}<span class="hl">{{ r.inside }}</span>{{ r.after }}</span>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  line-height: 1.4;
}

/* ── 검색 위젯 ── */
.widgets {
  margin: 0 12px 0 2px;
  padding: 6px 0;
  flex-shrink: 0;
}
.search-widget {
  position: relative;
}
.toggle-replace {
  position: absolute;
  top: 0;
  left: 0;
  width: 16px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  cursor: pointer;
}
.toggle-replace:hover {
  background: var(--vscode-toolbar-hoverBackground);
}
.search-container,
.replace-container {
  margin-left: 18px;
}
.replace-container {
  margin-top: 6px;
  display: flex;
}
.replace-container .inputbox {
  flex: 1;
}
.inputbox {
  position: relative;
  height: 26px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 4px;
  overflow: hidden;
}
.inputbox:focus-within {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.input {
  display: block;
  height: 24px;
  border: none;
  outline: none;
  background: transparent;
  color: inherit;
  font-size: 13px;
  padding: 3px 0 3px 6px;
}
.input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}
/* WHY: 우측 토글 3개(22px×3) 영역만큼 입력 폭을 줄인다 — spec 의 input w=200 (268 기준) */
.search-input {
  width: calc(100% - 66px);
}
.replace-input {
  width: 100%;
}
.controls {
  position: absolute;
  top: 3px;
  right: 2px;
  display: flex;
  align-items: center;
}
.option-toggle {
  width: 20px;
  height: 20px;
  padding: 1px;
  margin-left: 2px;
  border: 1px solid transparent;
  border-radius: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.option-toggle .codicon {
  font-size: 16px;
}
.option-toggle:hover {
  background: var(--vscode-inputOption-hoverBackground);
}
.option-toggle.active {
  background: var(--vscode-inputOption-activeBackground);
  border-color: var(--vscode-inputOption-activeBorder);
  color: var(--vscode-inputOption-activeForeground);
}
.replace-actions {
  margin-left: 4px;
  display: flex;
  align-items: center;
}
.query-details {
  position: relative;
  height: 1em;
  margin-left: 18px;
}
.more {
  position: absolute;
  top: 0;
  right: -2px;
  width: 25px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.more .codicon {
  font-size: 16px;
}

/* ── 결과 메시지 ── */
.messages {
  margin-top: -5px;
  color: var(--vscode-search-resultsInfoForeground);
  flex-shrink: 0;
}
.message {
  padding: 0 22px 8px;
  overflow-wrap: break-word;
}
.message-link {
  color: var(--vscode-textLink-foreground);
  cursor: pointer;
}
.message-link:hover {
  color: var(--vscode-textLink-activeForeground);
}

/* ── 결과 트리 ── */
.results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.row {
  height: 22px;
  line-height: 22px;
  cursor: pointer;
}
.row:hover {
  background: var(--vscode-list-hoverBackground);
}
.filematch {
  display: flex;
  align-items: center;
  padding: 0 12px 0 11px;
}
.twistie {
  width: 16px;
  font-size: 16px;
  margin-right: 4px;
  flex-shrink: 0;
  text-align: center;
}
.label {
  margin-left: 6px;
  white-space: nowrap;
}
.description {
  margin-left: 6px;
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  margin-left: auto;
  flex-shrink: 0;
  min-width: 18px;
  min-height: 18px;
  padding: 3px 6px;
  border-radius: 11px;
  font-size: 11px;
  line-height: 11px;
  text-align: center;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}
.match {
  padding-left: 38px;
  overflow: hidden;
}
.match-text {
  display: block;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hl {
  background: var(--vscode-editor-findMatchHighlightBackground);
}
</style>
