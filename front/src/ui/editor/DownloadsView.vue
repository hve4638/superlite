<script setup lang="ts">
// 다운로드 기록 탭 (ticket cli-control-discussion) — 셸 심 `superlite download` 요청 전체 목록. 크롬의
// "모든 다운로드 보기" 대응. 대기 항목은 여기서도 확인·취소, 끝난 항목은 × 로 제거. 정렬은 model 의
// orderedDownloads (대기 먼저, 나머지 최신순)
import { cancelDownload, clearDownload, confirmAllDownloads, confirmDownload, orderedDownloads, pendingDownloads, type DownloadState } from '../../model/downloads';

const LABEL: Record<DownloadState, string> = { pending: '대기', running: '받는 중', done: '완료', cancelled: '취소됨', failed: '실패' };
function when(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
</script>

<template>
  <div class="downloads-view">
    <div class="head">
      <h1>Downloads</h1>
      <button v-if="pendingDownloads > 0" class="btn primary" @click="confirmAllDownloads()">일괄 다운로드 허용 ({{ pendingDownloads }})</button>
    </div>
    <p v-if="orderedDownloads.length === 0" class="desc">다운로드 요청이 없습니다. 터미널에서 <code>superlite download &lt;경로&gt;</code> 로 요청합니다.</p>
    <table v-else>
      <thead>
        <tr><th>이름</th><th>경로</th><th>세션</th><th>요청 시각</th><th>상태</th><th></th></tr>
      </thead>
      <tbody>
        <tr v-for="d in orderedDownloads" :key="d.id" :class="d.state">
          <td><span class="codicon" :class="d.kind === 'directory' ? 'codicon-folder' : 'codicon-file'" /> {{ d.name }}</td>
          <td class="path">{{ d.path }}</td>
          <td>{{ d.session }}</td>
          <td>{{ when(d.at) }}</td>
          <td :title="d.error ?? ''">{{ LABEL[d.state] }}<span v-if="d.error" class="err"> — {{ d.error }}</span></td>
          <td class="actions">
            <template v-if="d.state === 'pending'">
              <button class="btn primary" @click="confirmDownload(d.id)">확인</button>
              <button class="btn" @click="cancelDownload(d.id)">취소</button>
            </template>
            <span v-else-if="d.state !== 'running'" class="codicon codicon-close close" title="기록에서 제거" @click="clearDownload(d.id)" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.downloads-view {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 16px 32px 48px;
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
  user-select: text;
}
.head {
  display: flex;
  align-items: center;
  gap: 16px;
}
h1 {
  font-size: 20px;
  font-weight: 600;
  margin: 8px 0 12px;
}
.desc {
  color: var(--vscode-descriptionForeground);
}
table {
  border-collapse: collapse;
  width: 100%;
  font-size: 13px;
}
th,
td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
  white-space: nowrap;
}
th {
  color: var(--vscode-descriptionForeground);
  font-weight: 600;
}
td.path {
  color: var(--vscode-descriptionForeground);
  max-width: 40vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
tr.pending td {
  background: var(--vscode-list-hoverBackground);
}
.err {
  color: var(--vscode-errorForeground);
}
.actions {
  display: flex;
  gap: 4px;
}
.btn {
  height: 20px;
  padding: 0 8px;
  border: 1px solid var(--vscode-button-border, transparent);
  border-radius: 2px;
  font-size: 12px;
  cursor: pointer;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.btn.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.close {
  cursor: pointer;
}
</style>
