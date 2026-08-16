<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { scm, openChange, commit, CHANGE_LETTER, CHANGE_COLOR } from '../../model/scm';
import FileIcon from '../widgets/FileIcon.vue';

const inputEl = ref<HTMLTextAreaElement>();
const placeholder = computed(() => `Message (Ctrl+Enter to commit on "${scm.branch}")`);

// WHY: VS Code 는 SCM 뷰를 열면 커밋 입력에 포커스를 준다 — 레퍼런스 스크린샷의
//      파란 focusBorder 상태가 기본 모습이므로 동일하게 재현한다.
onMounted(() => inputEl.value?.focus());
</script>

<template>
  <div class="scm-view">
    <section class="pane">
      <div class="pane-header">
        <span class="twisty codicon codicon-chevron-down" />
        <span class="pane-title">Changes</span>
        <div class="pane-actions">
          <span class="action codicon codicon-check" title="Commit" @click="commit()" />
          <span class="action codicon codicon-refresh" title="Refresh" />
          <span class="action codicon codicon-ellipsis" title="More Actions..." />
        </div>
      </div>
      <div class="pane-body">
        <div class="input-row">
          <div class="scm-editor">
            <textarea
              ref="inputEl"
              v-model="scm.commitMessage"
              rows="1"
              wrap="off"
              spellcheck="false"
              @keydown.ctrl.enter.prevent="commit()"
            />
            <!-- WHY: textarea 네이티브 placeholder 는 ellipsis 가 안 돼서 (레퍼런스는 "··· 로 잘림) 오버레이로 그린다 -->
            <span v-if="!scm.commitMessage" class="placeholder">{{ placeholder }}</span>
            <span class="sparkle codicon codicon-sparkle" title="Generate Commit Message with Copilot" />
          </div>
        </div>
        <div class="button-row">
          <div class="commit-button">
            <div class="btn-main" @click="commit()">
              <span class="codicon codicon-check" />
              <span>Commit</span>
            </div>
            <div class="btn-separator" />
            <div class="btn-dropdown" title="More Actions...">
              <span class="codicon codicon-chevron-down" />
            </div>
          </div>
        </div>
        <div class="group-row">
          <span class="twistie codicon codicon-chevron-down" />
          <span class="group-label">Changes</span>
          <span class="count-badge">{{ scm.changes.length }}</span>
        </div>
        <div
          v-for="c in scm.changes"
          :key="c.path"
          class="resource-row"
          :title="c.path"
          @click="openChange(c)"
        >
          <FileIcon :name="c.name" />
          <!-- WHY: VS Code SCM 뷰는 파일명에 데코 색을 쓰지 않는다 (scmViewPane.ts fileDecorations colors:false) -->
          <span class="res-name">{{ c.name }}</span>
          <span v-if="c.dir" class="res-desc">{{ c.dir }}</span>
          <span class="letter" :style="{ color: `var(${CHANGE_COLOR[c.kind]})` }">
            {{ CHANGE_LETTER[c.kind] }}
          </span>
          <div class="row-actions">
            <span class="action codicon codicon-discard" title="Discard Changes" @click.stop />
            <span class="action codicon codicon-add" title="Stage Changes" @click.stop />
          </div>
        </div>
      </div>
    </section>
    <section class="pane graph-pane">
      <div class="pane-header">
        <span class="twisty codicon codicon-chevron-down" />
        <span class="pane-title">Graph</span>
        <div class="pane-actions">
          <span class="action ref-picker" title="History Item Reference">
            <span class="codicon codicon-git-branch" />
            <span class="ref-picker-label">Auto</span>
          </span>
          <span class="action codicon codicon-target" title="Reveal Current History Item" />
          <span class="action codicon codicon-git-fetch" title="Fetch" />
          <span class="action codicon codicon-repo-pull" title="Pull" />
          <span class="action codicon codicon-cloud-upload" title="Publish Branch" />
          <span class="action codicon codicon-refresh" title="Refresh" />
          <span class="action codicon codicon-ellipsis" title="More Actions..." />
        </div>
      </div>
      <div class="pane-body">
        <div class="history-row">
          <svg class="graph" width="22" height="22" viewBox="0 0 22 22">
            <circle cx="11" cy="11" r="4" />
          </svg>
          <span class="hist-name">initial</span>
          <span class="hist-desc">fixture</span>
          <span class="ref-pill">
            <span class="codicon codicon-target" />
            <span class="ref-name">main</span>
          </span>
        </div>
      </div>
    </section>
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
  right: 27px;
  top: 3px;
  line-height: 18px;
  pointer-events: none;
  color: var(--vscode-input-placeholderForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sparkle {
  flex: none;
  font-size: 16px;
  padding: 2px;
  margin: 0 3px 0 2px;
  border-radius: 5px;
  cursor: pointer;
  color: var(--vscode-icon-foreground);
}
.sparkle:hover {
  background: var(--vscode-toolbar-hoverBackground);
}

/* ── Commit 버튼 (spec: 행 36px, 버튼 24px, x 68~334, 우측 chevron 세그먼트) ── */
.button-row {
  padding: 6px 13px 6px 20px;
}
.commit-button {
  display: flex;
  height: 24px;
  border-radius: 2px;
  overflow: hidden;
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  cursor: pointer;
}
.btn-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  white-space: nowrap;
}
.btn-main:hover {
  background: var(--vscode-button-hoverBackground);
}
.btn-main .codicon {
  font-size: 16px;
}
.btn-separator {
  flex: none;
  width: 1px;
  margin: 4px 0;
  background: var(--vscode-button-separator);
}
.btn-dropdown {
  flex: none;
  width: 23px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.btn-dropdown:hover {
  background: var(--vscode-button-hoverBackground);
}
.btn-dropdown .codicon {
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
.graph circle {
  fill: none;
  stroke: var(--vscode-scmGraph-historyItemRefColor);
  stroke-width: 2;
}
/* scm.css history-item-current: 이름 600 / 설명 500 */
.hist-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hist-desc {
  margin-left: 0.5em;
  font-size: 0.9em;
  font-weight: 500;
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
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
