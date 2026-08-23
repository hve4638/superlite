/**
 * WsBackend — 백엔드(backend/)의 /ws 에 붙는 ThinBackend 구현. 백엔드가 데몬으로 중계한다.
 *
 * 프로토콜(임시 v0): {id,method,params} 요청/응답 + termData/termExit 이벤트.
 * 와이어 계약 확정은 보류 중 (_docs/decisions.md) — 확정되면 이 파일과 backend/daemon 만 바뀐다.
 *
 * 재연결: 끊기면 1초 간격으로 무한 재시도. WS URL 의 session id 로 데몬이 같은 세션
 * (터미널·끊김 중 출력 버퍼)을 이어 붙인다. 끊김 중 요청은 큐에 남아 재연결 후 전송되고,
 * 끊기는 순간 진행 중이던 요청만 실패한다 (실행 여부 불명 — 네트워크 실패의 본질).
 */
import type {
  DirEntry,
  FileContent,
  FileSearchResult,
  FsChange,
  GitStatus,
  TerminalSession,
  ThinBackend,
  WorkspaceInfo,
  WriteResult,
} from './types';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** VS Code 터미널 flow control — 수신 5k 자마다 ack, 데몬은 미ack 100k 에서 읽기를 멈춘다 */
const CHAR_COUNT_ACK_SIZE = 5000;

export class WsBackend implements ThinBackend {
  private ws!: WebSocket;
  private readonly url: string;
  private opened = false;
  /** 한 번이라도 연결됐는가 — 첫 연결은 부팅 로드가 담당하므로 onConnection 을 쏘지 않는다 */
  private everOpened = false;
  /** 연결 전·끊김 중에 만들어진 요청 — 연결되면 순서대로 전송 */
  private queue: string[] = [];
  private nextId = 1;
  private nextTerm = 1;
  private pending = new Map<number, Pending>();
  private termHandlers = new Map<number, (data: string) => void>();
  /** 터미널별 미ack 수신량 — CHAR_COUNT_ACK_SIZE 를 넘으면 termAck 로 비운다 */
  private termRecv = new Map<number, number>();
  private fsHandler: ((changes: FsChange[], overflow: boolean) => void) | null = null;
  private connHandler: ((connected: boolean) => void) | null = null;

  constructor(url: string) {
    // 세션 id — 재접속 시 데몬이 같은 세션(터미널)을 이어 붙이는 키. 페이지 수명 단위 —
    // 새로고침은 새 세션이다 (이전 세션의 터미널은 데몬이 grace 뒤 회수)
    this.url = `${url}${url.includes('?') ? '&' : '?'}session=${crypto.randomUUID()}`;
    this.connect();
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.opened = true;
      // 데몬이 attach 에서 배압 카운터를 리셋한다 — 수신 카운터도 0 에서 다시.
      // (끊김 중 큐에 남은 stale ack 는 데몬 쪽에서 0 으로 포화될 뿐 — 무해)
      this.termRecv.clear();
      for (const m of this.queue) this.ws.send(m);
      this.queue.length = 0;
      // WHY: 재연결 알림은 큐 flush 뒤 — 구독자의 재동기화 요청이 밀린 요청을 앞지르지 않게
      if (this.everOpened) this.connHandler?.(true);
      this.everOpened = true;
    };
    this.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // 깨진 프레임 하나가 onmessage 를 터뜨리지 않게
      }
      if (msg.event === 'termData') {
        this.termHandlers.get(msg.term)?.(msg.data);
        // 핸들러 유무와 무관하게 ack — 받은 건 받은 것이다 (안 하면 데몬이 고수위에서 멈춘다)
        const n = (this.termRecv.get(msg.term) ?? 0) + msg.data.length;
        if (n >= CHAR_COUNT_ACK_SIZE) {
          this.send({ method: 'termAck', params: { term: msg.term, chars: n } });
          this.termRecv.set(msg.term, 0);
        } else {
          this.termRecv.set(msg.term, n);
        }
        return;
      }
      if (msg.event === 'fsChanges') {
        this.fsHandler?.(msg.changes ?? [], msg.overflow === true);
        return;
      }
      if (msg.event === 'termExit') {
        // 셸이 스스로 종료한 경우 핸들러 클로저 누수 방지 (탭 표시는 ponytail: 미구현)
        this.termHandlers.delete(msg.term);
        this.termRecv.delete(msg.term);
        return;
      }
      if (msg.event) return;
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
    this.ws.onclose = () => {
      this.opened = false;
      // 진행 중이던 요청만 실패 처리 — 큐(미전송)는 남아 재연결 후 나간다
      for (const p of this.pending.values()) p.reject(new Error('백엔드 연결이 끊겼다'));
      this.pending.clear();
      this.connHandler?.(false);
      // ponytail: 고정 1초 재시도, 무한 — 백오프·포기는 필요해지면
      setTimeout(() => this.connect(), 1000);
    };
  }

  private send(obj: unknown): void {
    const s = JSON.stringify(obj);
    if (this.opened) this.ws.send(s);
    else this.queue.push(s);
  }

  private call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ id, method, params });
    });
  }

  workspace(): Promise<WorkspaceInfo> {
    return this.call('workspace');
  }
  readDir(path: string): Promise<DirEntry[]> {
    return this.call('readDir', { path });
  }
  readFile(path: string, opts?: { maxBytes?: number }): Promise<FileContent> {
    return this.call('readFile', { path, maxBytes: opts?.maxBytes });
  }
  writeFile(path: string, content: string, etag?: string): Promise<WriteResult> {
    // etag 가 undefined 면 JSON.stringify 가 키를 떨군다 — 데몬은 부재로 본다
    return this.call('writeFile', { path, content, etag });
  }
  createFile(path: string): Promise<void> {
    return this.call('createFile', { path });
  }
  createDir(path: string): Promise<void> {
    return this.call('createDir', { path });
  }
  rename(from: string, to: string): Promise<void> {
    return this.call('rename', { from, to });
  }
  delete(path: string): Promise<void> {
    return this.call('delete', { path });
  }
  listFiles(): Promise<string[]> {
    return this.call('listFiles');
  }
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<FileSearchResult[]> {
    return this.call('search', { query, opts: opts ?? {} });
  }
  gitStatus(): Promise<GitStatus> {
    return this.call('gitStatus');
  }
  gitOriginalContent(path: string): Promise<string> {
    return this.call('gitOriginalContent', { path });
  }
  gitCommit(message: string): Promise<void> {
    return this.call('gitCommit', { message });
  }

  onFsChanges(cb: (changes: FsChange[], overflow: boolean) => void): void {
    this.fsHandler = cb;
  }

  onConnection(cb: (connected: boolean) => void): void {
    this.connHandler = cb;
  }

  createTerminal(cols: number, rows: number): TerminalSession {
    // WHY: 계약이 동기 반환이라 term id 는 클라이언트가 발급하고 생성은 fire-and-forget
    const term = this.nextTerm++;
    this.send({ method: 'createTerminal', params: { term, cols, rows } });
    return {
      write: (data) => this.send({ method: 'termWrite', params: { term, data } }),
      onData: (cb) => this.termHandlers.set(term, cb),
      resize: (c, r) => this.send({ method: 'termResize', params: { term, cols: c, rows: r } }),
      dispose: () => {
        this.send({ method: 'disposeTerminal', params: { term } });
        this.termHandlers.delete(term);
        this.termRecv.delete(term);
      },
    };
  }
}
