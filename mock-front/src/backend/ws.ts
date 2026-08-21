/**
 * WsBackend — 백엔드(backend/)의 /ws 에 붙는 ThinBackend 구현. 백엔드가 데몬으로 중계한다.
 *
 * 프로토콜(임시 v0): {id,method,params} 요청/응답 + termData/termExit 이벤트.
 * 와이어 계약 확정은 보류 중 (_docs/decisions.md) — 확정되면 이 파일과 backend/daemon 만 바뀐다.
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

export class WsBackend implements ThinBackend {
  private ws: WebSocket;
  private opened = false;
  /** 연결 전에 만들어진 요청 (첫 화면 로드가 곧바로 workspace/readDir 를 부른다) */
  private queue: string[] = [];
  private nextId = 1;
  private nextTerm = 1;
  private pending = new Map<number, Pending>();
  private termHandlers = new Map<number, (data: string) => void>();
  private fsHandler: ((changes: FsChange[], overflow: boolean) => void) | null = null;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.onopen = () => {
      this.opened = true;
      for (const m of this.queue) this.ws.send(m);
      this.queue.length = 0;
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
        return;
      }
      if (msg.event === 'fsChanges') {
        this.fsHandler?.(msg.changes ?? [], msg.overflow === true);
        return;
      }
      if (msg.event === 'termExit') {
        // 셸이 스스로 종료한 경우 핸들러 클로저 누수 방지 (탭 표시는 ponytail: 미구현)
        this.termHandlers.delete(msg.term);
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
      // ponytail: 재연결 없음(와이어 계약 보류) — 진행 중 요청만 실패 처리
      for (const p of this.pending.values()) p.reject(new Error('백엔드 연결이 끊겼다'));
      this.pending.clear();
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
  readFile(path: string): Promise<FileContent> {
    return this.call('readFile', { path });
  }
  writeFile(path: string, content: string, etag?: string): Promise<WriteResult> {
    // etag 가 undefined 면 JSON.stringify 가 키를 떨군다 — 데몬은 부재로 본다
    return this.call('writeFile', { path, content, etag });
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
      },
    };
  }
}
