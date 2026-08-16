import { createApp } from 'vue';
import '@vscode/codicons/dist/codicon.css';
import './theme/tokens.css';
import './theme/base.css';
import Workbench from './ui/Workbench.vue';
import { initWorkbench } from './model/workbench';
import { initFiles } from './model/files';
import { refreshScm } from './model/scm';
import { installKeybindings, setupCommands } from './model/commands';

setupCommands();
installKeybindings(window);

// 초기 데이터 로드 후 마운트 — 부팅 시 빈 셸이 깜빡이는 것을 피한다
await Promise.all([initWorkbench(), initFiles(), refreshScm()]);

createApp(Workbench).mount('#app');
