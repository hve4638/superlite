/**
 * 임베드 Neovim 클라이언트 — 편집기 vim 모드의 실체 (ticket editor-vim-mode).
 *
 * relay 의 /nvim WebSocket 은 고정 버전 nvim(--embed --headless --clean) 의 stdio 를 바이트
 * 그대로 잇는다. 여기서 msgpack-RPC 를 말하고(요청·응답·알림·nvim 발 요청), UI 를 붙여
 * (nvim_ui_attach, ext_cmdline·ext_messages) 모드·명령줄·메시지를 반응형 상태로 든다.
 * 버퍼 ↔ Monaco 모델 동기화와 키 전달은 ui/editor/vim.ts 몫 — 이 모듈은 편집기를 모른다.
 *
 * 페이지(창)당 nvim 프로세스 하나. 켜기는 사용자 설정(localStorage, 기본 꺼짐) — 켜면 접속·
 * 초기화까지 status 가 starting→ready, 실패(바이너리 없음 close 4503·프로세스 종료)는 알림을
 * 띄우고 설정을 끈 상태로 되돌린다 — 편집기는 평소대로 남는다.
 */
import { reactive } from '@vue/reactivity';
import { Encoder, ExtensionCodec, decode, decodeMultiStream } from '@msgpack/msgpack';
import { notify } from './notifications';
import { activeGroup, activeTab, closeTab, saveActive } from './editors';
import { refreshScm } from './scm';

export interface CmdlineState {
  /** ':' '/' '?' '=' 등 — 명령줄 종류 */
  firstc: string;
  prompt: string;
  content: string;
  /** 커서 위치 (content 안 바이트 오프셋) */
  pos: number;
}

// WHY: vimMode 초기화가 이 상수를 읽는다 — 아래에 두면 번들에서 TDZ 대신 undefined 로 읽혀 설정이 늘 꺼진다
const PREF_KEY = 'superlite.vimMode';
function loadEnabled(): boolean {
  return localStorage.getItem(PREF_KEY) === '1';
}

export const vimMode = reactive({
  /** 사용자 설정 — 켜짐 여부 (localStorage) */
  enabled: loadEnabled(),
  /** 연결·초기화 상태 — ready 일 때만 편집기가 붙는다 */
  status: 'off' as 'off' | 'starting' | 'ready',
  /** nvim mode() 문자열 (n·i·v·V·\x16·R·c·no …) — ui/editor/vim.ts 가 flush 마다 갱신 */
  mode: 'n',
  cmdline: null as CmdlineState | null,
  /** 마지막 메시지 (msg_show — 검색 실패·에러 등), msg_clear 로 비운다 */
  message: '',
  /** 입력 중인 키 (showcmd — "d2" 등) */
  showcmd: '',
});


/** 상태바 라벨 — 모드 문자열 → vim 표기 */
export function vimModeLabel(mode: string): string {
  if (mode.startsWith('i')) return 'INSERT';
  if (mode.startsWith('R')) return 'REPLACE';
  if (mode === 'v' || mode === 'vs') return 'VISUAL';
  if (mode === 'V' || mode === 'Vs') return 'V-LINE';
  if (mode.startsWith('\x16')) return 'V-BLOCK';
  if (mode.startsWith('c')) return 'COMMAND';
  if (mode.startsWith('no')) return 'O-PENDING';
  return 'NORMAL';
}

let url: string | null = null;
let client: NvimClient | null = null;

/** 조립 지점(host.ts)이 /nvim 주소를 준다 — null 이면 이 환경(mock)엔 vim 모드가 없다.
 *  설정이 켜져 있으면 바로 접속한다 */
export function configureNvim(u: string | null): void {
  url = u;
  if (vimMode.enabled) start();
}

export function vimAvailable(): boolean {
  return url !== null;
}

/** 현재 클라이언트 — ready 일 때만 */
export function nvim(): NvimClient | null {
  return vimMode.status === 'ready' ? client : null;
}

export function toggleVimMode(): void {
  setVimMode(!vimMode.enabled);
}

export function setVimMode(on: boolean): void {
  if (on && url === null) {
    notify('warning', 'Vim mode is not available in this environment');
    return;
  }
  vimMode.enabled = on;
  localStorage.setItem(PREF_KEY, on ? '1' : '0');
  if (on) start();
  else stop();
}

function start(): void {
  if (client || url === null) return;
  vimMode.status = 'starting';
  client = new NvimClient(url, {
    onReady: () => {
      vimMode.status = 'ready';
    },
    onClose: (reason) => {
      const wasOn = vimMode.enabled;
      stop();
      if (wasOn) {
        vimMode.enabled = false;
        localStorage.setItem(PREF_KEY, '0');
        notify('error', `Vim mode turned off: ${reason}`);
      }
    },
  });
}

function stop(): void {
  client?.dispose();
  client = null;
  vimMode.status = 'off';
  vimMode.mode = 'n';
  vimMode.cmdline = null;
  vimMode.message = '';
  vimMode.showcmd = '';
}

/** nvim 쪽 초기화 — 옵션과 헬퍼 함수 (ui/editor/vim.ts 가 부른다). 첫 인자는 이 채널 id.
 *  버퍼는 acwrite: nvim 이 디스크를 직접 쓰지 않는다 (:w 는 프론트가 명령줄에서 가로채 우리
 *  저장 경로로). ZZ·ZQ 는 마지막 창을 닫아 nvim 자체를 끝내므로 알림으로 돌린다.
 *  '+'·'*' 레지스터는 프론트 클립보드 (rpcrequest sl_clip_get / rpcnotify sl_clip_set) */
const INIT_LUA = `
local ch = ...
vim.o.hidden = true
vim.o.swapfile = false
vim.o.undofile = false
vim.o.wrap = false
vim.o.scrolloff = 0
vim.o.startofline = false
vim.o.shortmess = vim.o.shortmess .. 'I'
vim.o.showmode = false
vim.g.clipboard = {
  name = 'superlite',
  copy = {
    ['+'] = function(lines, regtype) vim.rpcnotify(ch, 'sl_clip_set', lines, regtype) end,
    ['*'] = function(lines, regtype) vim.rpcnotify(ch, 'sl_clip_set', lines, regtype) end,
  },
  paste = {
    ['+'] = function() return vim.rpcrequest(ch, 'sl_clip_get') end,
    ['*'] = function() return vim.rpcrequest(ch, 'sl_clip_get') end,
  },
  cache_enabled = false,
}
vim.keymap.set('n', 'ZZ', function() vim.rpcnotify(ch, 'sl_ex', 'x') end)
vim.keymap.set('n', 'ZQ', function() vim.rpcnotify(ch, 'sl_ex', 'q!') end)
-- 버퍼 열기: 이름·내용·acwrite. 반환 bufnr (줄 이벤트 구독은 프론트가 RPC 로 — Lua 에서 부른
-- nvim_buf_attach 는 콜백 방식이라 채널로 알림이 오지 않는다)
function _G.sl_open(name, lines)
  local buf = vim.api.nvim_create_buf(true, false)
  -- 초기 로드는 undo 이력 밖에 — 남기면 u 를 한 번 더 눌렀을 때 버퍼가 빈다
  local ul = vim.bo[buf].undolevels
  vim.bo[buf].undolevels = -1
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].undolevels = ul
  pcall(vim.api.nvim_buf_set_name, buf, name)
  vim.bo[buf].buftype = 'acwrite'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].modified = false
  return buf
end
-- Monaco 발 변경 반영 — join 이면 직전 undo 블록에 합친다 (insert 한 번 = undo 한 단위)
function _G.sl_set_lines(buf, s, e, lines, join)
  if join then pcall(vim.cmd.undojoin) end
  vim.api.nvim_buf_set_lines(buf, s, e, false, lines)
end
-- 현재 버퍼로 전환 (Monaco 포커스가 부른다). 버퍼가 바뀔 때만 Monaco 커서를 넘긴다 — 같은
-- 버퍼면 nvim 커서가 진실이다 (검색·이동 직후 포커스 복귀가 옛 커서로 되밀지 않게). col 은 0 기반 바이트
function _G.sl_focus(buf, line, col)
  if vim.api.nvim_get_current_buf() ~= buf then
    vim.api.nvim_set_current_buf(buf)
    pcall(vim.api.nvim_win_set_cursor, 0, { line, col })
  end
end
-- Monaco 선택(마우스 드래그·검색 위젯) → visual. 끝은 포함(inclusive) 좌표
function _G.sl_select(sl, sc, el, ec)
  if vim.api.nvim_get_mode().mode ~= 'n' then vim.cmd('normal! ' .. vim.api.nvim_replace_termcodes('<Esc>', true, false, true)) end
  vim.api.nvim_win_set_cursor(0, { sl, sc })
  vim.cmd('normal! v')
  vim.api.nvim_win_set_cursor(0, { el, ec })
end
-- flush 뒤 상태 조회: mode, 커서(line 1기반, col 0기반 바이트), visual 시작(getpos 'v'), 현재 버퍼
function _G.sl_state()
  local c = vim.api.nvim_win_get_cursor(0)
  local v = vim.fn.getpos('v')
  return { vim.api.nvim_get_mode().mode, c[1], c[2], v[2], v[3] - 1, vim.api.nvim_get_current_buf() }
end
`;

// ---- 키 변환 (편집기 keydown 과 상태바 명령줄 입력창이 공유) ----
const SPECIAL: Record<string, string> = {
  Escape: 'Esc', Enter: 'CR', Backspace: 'BS', Tab: 'Tab', Delete: 'Del', Insert: 'Insert',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ' ': 'Space',
};

/** DOM 키 → nvim 표기. 순수 modifier·IME 조합 중(Process)·미확정 키는 null */
export function toNvimKey(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta' || k === 'Process' || k === 'Dead' || k === 'Unidentified') return null;
  let name = SPECIAL[k] ?? (/^F\d{1,2}$/.test(k) ? k : null);
  const mods = `${e.ctrlKey ? 'C-' : ''}${e.altKey ? 'M-' : ''}`;
  if (name) {
    if (e.shiftKey) name = `S-${name}`;
    return `<${mods}${name}>`;
  }
  if (k.length !== 1 && !(k.length === 2 && k.codePointAt(0)! > 0xffff)) return null;
  // Ctrl+Shift+z: e.key 가 환경에 따라 'z' 로 오기도 한다 — Shift 는 대문자로 표기 (<C-Z>)
  if (mods) return `<${mods}${e.shiftKey ? k.toUpperCase() : k}>`;
  return k === '<' ? '<lt>' : k;
}

/** 조합 완료 텍스트(IME) → nvim 입력. nvim_input 은 <…> 만 특별 취급한다 */
export function inputText(text: string): void {
  nvim()?.input(text.replace(/</g, '<lt>'));
}

// ---- :명령 가로채기 — nvim 은 acwrite 버퍼라 디스크를 안 쓰고, :q 는 마지막 창이라 nvim 자체가 끝난다 ----
const EX_INTERCEPT = /^\s*(w|write|q|quit|wq|x|xit|exit|qa|qall|wqa|xa|wa|wall)(!?)\s*$/;

export async function runEx(cmd: string): Promise<void> {
  const m = EX_INTERCEPT.exec(cmd);
  if (!m) return;
  const name = m[1];
  const force = m[2] === '!';
  // WHY: :wa·:qa·:wqa·:xa 도 활성 탭 하나만 — vim 은 오로지 그 편집기에만 작용하고 다른 탭을
  //      저장하거나 닫지 않는다 (사용자 결정 2026-09-09, editor-close-vim). nvim 에 넘기면
  //      acwrite 버퍼라 아무 일도 없거나 에러라 가로채기 목록에는 남긴다
  const write = /^(w|write|wq|x|xit|exit|wqa|xa|wa|wall)$/.test(name);
  const quit = /^(q|quit|wq|x|xit|exit|qa|qall|wqa|xa)$/.test(name);
  if (write) await saveActive().then(refreshScm);
  if (quit) {
    const g = activeGroup();
    const t = activeTab();
    if (t) closeTab(g.id, t.id, force);
  }
}

/** 명령줄이 열린 동안의 키 — 편집기·상태바 입력창 공용. :w :q 류의 Enter 는 nvim 에 넘기지 않고
 *  우리 경로로 (명령줄은 Esc 로 닫는다). 처리했으면 true (호출측이 preventDefault) */
export function cmdlineKey(e: KeyboardEvent): boolean {
  const c = nvim();
  const key = toNvimKey(e);
  if (!c || !key) return false;
  const cl = vimMode.cmdline;
  if (key === '<CR>' && cl?.firstc === ':' && EX_INTERCEPT.test(cl.content)) {
    c.input('<Esc>');
    void runEx(cl.content);
    return true;
  }
  c.input(key);
  return true;
}

/** UI 옵션 — 격자는 받되 그리지 않는다 (ext_* 로 명령줄·메시지·팝업만 따로 받는다) */
const UI_OPTIONS = { ext_linegrid: true, ext_cmdline: true, ext_messages: true, ext_popupmenu: true, ext_tabline: true, rgb: true };

type Handler = (args: unknown[]) => void;
type RequestHandler = (args: unknown[]) => unknown | Promise<unknown>;

interface ClientEvents {
  onReady: () => void;
  onClose: (reason: string) => void;
}

/** nvim 의 Buffer/Window/Tabpage 는 ext 0/1/2 (msgpack 정수 payload) — 숫자로 푼다 */
const extensionCodec = new ExtensionCodec();
for (const type of [0, 1, 2]) {
  extensionCodec.register({
    type,
    encode: () => null,
    decode: (data) => decode(data) as number,
  });
}

export class NvimClient {
  private ws: WebSocket;
  private readonly encoder = new Encoder({ extensionCodec });
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private notifHandlers = new Map<string, Set<Handler>>();
  private requestHandlers = new Map<string, RequestHandler>();
  private redrawHandlers = new Set<(name: string, args: unknown[][]) => void>();
  private chunks: Uint8Array[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  /** 이 클라이언트의 nvim 채널 id (rpcnotify 대상) */
  channel = 0;

  constructor(url: string, private readonly events: ClientEvents) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => void this.init();
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        this.chunks.push(new Uint8Array(ev.data));
        this.wake?.();
      }
    };
    this.ws.onclose = (ev) => {
      if (this.closed) return;
      this.closed = true;
      const reason = ev.code === 4503 ? ev.reason || 'Neovim unavailable' : ev.reason || 'Neovim exited';
      for (const p of this.pending.values()) p.reject(new Error(reason));
      this.pending.clear();
      this.wake?.();
      this.events.onClose(reason);
    };
    void this.readLoop();
  }

  /** WS 바이너리 조각을 msgpack 스트림으로 이어 붙여 메시지 단위로 디스패치 —
   *  relay 는 nvim stdout 을 읽히는 대로 보내므로 프레임이 메시지 중간에서 끊길 수 있다 */
  private async readLoop(): Promise<void> {
    const self = this;
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: async function* () {
        while (!self.closed) {
          if (self.chunks.length === 0) {
            await new Promise<void>((r) => (self.wake = r));
            self.wake = null;
            continue;
          }
          yield self.chunks.shift()!;
        }
      },
    };
    try {
      for await (const msg of decodeMultiStream(source, { extensionCodec })) {
        this.dispatch(msg as unknown[]);
      }
    } catch (e) {
      if (!this.closed) {
        console.error('nvim: decode failed', e);
        this.ws.close();
      }
    }
  }

  private dispatch(msg: unknown[]): void {
    const kind = msg[0];
    if (kind === 1) {
      const [, id, err, result] = msg as [number, number, unknown, unknown];
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (err !== null && err !== undefined) p.reject(new Error(String((err as unknown[])[1] ?? err)));
      else p.resolve(result);
    } else if (kind === 2) {
      const [, method, params] = msg as [number, string, unknown[]];
      if (method === 'redraw') {
        for (const ev of params as unknown[][]) {
          const [name, ...args] = ev as [string, ...unknown[][]];
          this.onRedrawEvent(name, args);
          for (const h of this.redrawHandlers) h(name, args);
        }
        return;
      }
      for (const h of this.notifHandlers.get(method) ?? []) h(params);
    } else if (kind === 0) {
      const [, id, method, params] = msg as [number, number, string, unknown[]];
      const h = this.requestHandlers.get(method);
      void (async () => {
        try {
          const r = h ? await h(params) : null;
          this.send([1, id, h ? null : `no handler: ${method}`, r ?? null]);
        } catch (e) {
          this.send([1, id, String(e), null]);
        }
      })();
    }
  }

  /** 모드·명령줄·메시지 — 반응형 상태로. 나머지(격자·색상)는 버린다 */
  private onRedrawEvent(name: string, args: unknown[][]): void {
    switch (name) {
      case 'cmdline_show': {
        const [content, pos, firstc, prompt] = args[args.length - 1] as [[number, string][], number, string, string];
        vimMode.cmdline = { firstc, prompt, content: content.map((c) => c[1]).join(''), pos };
        break;
      }
      case 'cmdline_pos': {
        const [pos] = args[args.length - 1] as [number];
        if (vimMode.cmdline) vimMode.cmdline.pos = pos;
        break;
      }
      case 'cmdline_hide':
        vimMode.cmdline = null;
        break;
      case 'msg_show': {
        for (const a of args) {
          const [kind, content, replace] = a as [string, [number, string][], boolean];
          const text = content.map((c) => c[1]).join('');
          // 히트-엔터 프롬프트는 화면이 없으니 바로 넘긴다 (메시지는 상태바에 남아 있다)
          if (kind === 'return_prompt') {
            this.input('<CR>');
            continue;
          }
          vimMode.message = replace ? text : text.trim();
        }
        break;
      }
      case 'msg_clear':
        vimMode.message = '';
        break;
      case 'msg_showcmd': {
        const [content] = args[args.length - 1] as [[number, string][]];
        vimMode.showcmd = content.map((c) => c[1]).join('');
        break;
      }
      default:
        break;
    }
  }

  private async init(): Promise<void> {
    try {
      const [channel] = (await this.request('nvim_get_api_info')) as [number, unknown];
      this.channel = channel;
      await this.request('nvim_exec_lua', INIT_LUA, [channel]);
      await this.request('nvim_ui_attach', 80, 24, UI_OPTIONS);
      this.events.onReady();
    } catch (e) {
      console.error('nvim: init failed', e);
      this.ws.close();
    }
  }

  private send(msg: unknown[]): void {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(this.encoder.encode(msg));
  }

  request(method: string, ...params: unknown[]): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('nvim closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send([0, id, method, params]);
    });
  }

  notify(method: string, ...params: unknown[]): void {
    this.send([2, method, params]);
  }

  /** 키 입력 — nvim 표기(<Esc>·<C-x>·문자) */
  input(keys: string): void {
    this.notify('nvim_input', keys);
  }

  /** nvim 발 알림 (nvim_buf_lines_event·rpcnotify) 구독 */
  onNotification(method: string, h: Handler): () => void {
    let set = this.notifHandlers.get(method);
    if (!set) this.notifHandlers.set(method, (set = new Set()));
    set.add(h);
    return () => set.delete(h);
  }

  /** nvim 발 요청 (rpcrequest — 클립보드 읽기) 처리기 — 메서드당 하나 */
  onRequest(method: string, h: RequestHandler): void {
    this.requestHandlers.set(method, h);
  }

  /** redraw 이벤트 구독 (flush 등) — 모드·명령줄은 이미 vimMode 에 반영된 뒤 불린다 */
  onRedraw(h: (name: string, args: unknown[][]) => void): () => void {
    this.redrawHandlers.add(h);
    return () => this.redrawHandlers.delete(h);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake?.();
    this.ws.onclose = null;
    this.ws.close();
  }
}
