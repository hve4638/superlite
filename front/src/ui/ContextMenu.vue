<script lang="ts">
import { openContextMenu } from '../model/workbench';

// DEV 전용 검증 훅 — Explorer 등이 openContextMenu 를 붙이기 전에도 브라우저 콘솔에서
// 메뉴를 띄워볼 수 있게 한다. 모듈 로드 시 1회 등록.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__openCtx = openContextMenu;
}
</script>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { closeContextMenu, workbench, type ContextMenuItem } from '../model/workbench';

const menuEl = ref<HTMLElement | null>(null);
const pos = ref({ x: workbench.contextMenu.x, y: workbench.contextMenu.y });
const ready = ref(false);

function runItem(item: ContextMenuItem): void {
  if (item.separator || item.enabled === false) return;
  item.run?.();
  closeContextMenu();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
    return;
  }
  // 니모닉 — 항목의 key 와 일치하면 그 항목 실행 (수식키 없이)
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const hit = workbench.contextMenu.items.find((it) => it.key !== undefined && it.key === e.key.toLowerCase());
  if (hit) {
    e.preventDefault();
    e.stopPropagation();
    runItem(hit);
  }
}

onMounted(async () => {
  window.addEventListener('keydown', onKeydown, true);
  await nextTick();
  // 화면 밖으로 나가면 반대 방향으로 반전 (VS Code contextview 동작)
  const r = menuEl.value?.getBoundingClientRect();
  if (r) {
    let { x, y } = pos.value;
    if (x + r.width > window.innerWidth) x = Math.max(0, x - r.width);
    if (y + r.height > window.innerHeight) y = Math.max(0, y - r.height);
    pos.value = { x, y };
  }
  ready.value = true;
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown, true);
});
</script>

<template>
  <div
    class="ctx-backdrop"
    @mousedown="closeContextMenu()"
    @contextmenu.prevent="closeContextMenu()"
  >
    <div
      ref="menuEl"
      class="ctx-menu"
      :style="{ left: `${pos.x}px`, top: `${pos.y}px`, visibility: ready ? 'visible' : 'hidden' }"
      @mousedown.stop
      @contextmenu.stop.prevent
    >
      <template v-for="(item, i) in workbench.contextMenu.items" :key="i">
        <div v-if="item.separator" class="ctx-sep" />
        <div
          v-else
          class="ctx-item"
          :class="{ disabled: item.enabled === false }"
          @click="runItem(item)"
        >
          <span class="ctx-label">{{ item.label }}</span>
          <span v-if="item.keybinding" class="ctx-kb">{{ item.keybinding }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 2500;
}
.ctx-menu {
  position: fixed;
  min-width: 160px;
  padding: 4px 0;
  box-sizing: border-box;
  background: var(--vscode-menu-background);
  color: var(--vscode-menu-foreground);
  border: 1px solid var(--vscode-menu-border);
  border-radius: 8px;
  box-shadow: var(--vscode-shadow-lg);
  font-size: 13px;
}
.ctx-item {
  display: flex;
  align-items: center;
  height: 24px;
  margin: 0 4px;
  border-radius: 6px;
  cursor: default;
  white-space: nowrap;
}
.ctx-item:not(.disabled):hover {
  background: var(--vscode-menu-selectionBackground);
  color: var(--vscode-menu-selectionForeground);
}
.ctx-item.disabled {
  opacity: 0.4;
}
.ctx-label {
  flex: 1 1 auto;
  padding: 0 26px;
}
.ctx-kb {
  flex: 2 1 auto;
  padding: 0 26px;
  text-align: right;
  opacity: 0.7;
}
.ctx-item:not(.disabled):hover .ctx-kb {
  opacity: 1;
}
.ctx-sep {
  height: 1px;
  margin: 5px 0;
  background: var(--vscode-menu-separatorBackground);
}
</style>
