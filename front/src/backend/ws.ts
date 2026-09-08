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
  ConnectStage, DirEntry, FileContent, FileSearchResult, FileStat, FsChange, GitLogItem, GitStatus, QuickOpenResult, TerminalInfo, TerminalMode, TerminalSession, ThinBackend, WorkspaceInfo, WriteResult,
} from './types';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** deflate-raw 해제 — 데몬이 압축한 대형 텍스트 payload 용 (브라우저 내장, 워커 불필요) */
async function inflateRaw(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** bytes → base64 — 이미지 payload 의 종전 계약(content=base64 문자열) 복원.
 *  btoa 는 문자열 인자라 청크로 나눈다 (fromCharCode 의 인자 개수 한계 회피) */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** VS Code 터미널 flow control — 수신 5k 자마다 ack, 데몬은 미ack 100k 에서 읽기를 멈춘다 */
const CHAR_COUNT_ACK_SIZE = 5000;

/** 입력 배압 창 — 미소화(termInputAck 미수신) 전송량이 이 값을 넘으면 termWrite 를
 *  로컬 큐에 대기시킨다. 셸이 입력을 읽지 않는 채 대량 붙여넣기가 반복될 때 데몬 입력
 *  큐가 무한히 크는 것을 막는다 (일반 붙여넣기 규모는 걸리지 않는 크기) */
const INPUT_WINDOW_CHARS = 1_000_000;

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
  private termHandlers = new Map<number, (data: string, done?: () => void) => void>();
  private termExitHandlers = new Map<number, (code: number | null) => void>();
  private termTmuxHandlers = new Map<number, (info: { id: string; name: string } | null, error?: string) => void>();
  private terminalModeHandler: ((mode: TerminalMode, error: string | null) => void) | null = null;
  /** 터미널별 미ack 수신량 — CHAR_COUNT_ACK_SIZE 를 넘으면 termAck 로 비운다 */
  private termRecv = new Map<number, number>();
  /** 연결 세대 — 성공한 연결(onopen)마다 1 증가. 터미널의 생사 판별 기준 */
  private connEpoch = 0;
  /** 터미널별 생성 세대 — createTerminal 이 어느 연결에서 데몬에 전달되(었/는)지.
   *  끊김 중 생성분은 다음 연결의 큐 flush 로 전달되므로 현재 세대 + 1 로 기록한다 */
  private termEpoch = new Map<number, number>();
  /** 터미널별 미소화 전송량 — INPUT_WINDOW_CHARS 초과 시 전송을 멈춘다 */
  private termSent = new Map<number, number>();
  /** 창 초과로 대기 중인 입력 — termInputAck 로 창이 열리면 순서대로 전송 */
  private termInputQueue = new Map<number, string[]>();
  private inputBlockedHandler: ((term: number, blocked: boolean) => void) | null = null;
  private fsHandler: ((changes: FsChange[], overflow: boolean) => void) | null = null;
  private connHandler: ((connected: boolean, error?: string) => void) | null = null;
  private stageHandler: ((stage: ConnectStage | null, bytes?: number) => void) | null = null;
  /** reconnect() 로 다시 여는 중 — 첫 연결이 실패했던 경우에도 onopen 이 연결 회복을 알리게 */
  private retrying = false;
  private sessionLostHandler: ((deadTerms: number[]) => void) | null = null;
  private requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  /** 이번 연결이 재연결인가 — attach 응답(id 0)의 resumed 해석에 쓴다 */
  private isReconnect = false;
  /** dispose 됨 — 의도적 종료(세션 탭 닫기). 되돌리지 않는다 */
  private disposed = false;
  /** 영구 실패(close 4403·4502)로 재연결을 포기함 — reconnect() 만이 되돌린다 */
  private gaveUp = false;

  /** session: 재접속 시 데몬이 같은 세션(터미널)을 이어 붙이는 키 — 앱은 native 레지스트리가,
   *  웹은 sessions.genSessionId 가 발급한다 (페이지 수명 단위 — 새로고침은 새 세션) */
  constructor(url: string, session: string) {
    this.url = `${url}${url.includes('?') ? '&' : '?'}session=${session}`;
    this.connect();
  }

  private connect(): void {
    if (this.disposed || this.gaveUp) return; // dispose·포기 후 도착한 재시도 타이머
    this.ws = new WebSocket(this.url);
    // 대형 payload 바이너리 프레임 (와이어 v6) — 기본 Blob 은 비동기 읽기가 한 겹 더 든다
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this.opened = true;
      this.isReconnect = this.everOpened;
      this.connEpoch += 1;
      // 데몬이 attach 에서 배압 카운터를 리셋한다 — 수신 카운터도 0 에서 다시.
      // (끊김 중 큐에 남은 stale ack 는 데몬 쪽에서 0 으로 포화될 뿐 — 무해)
      this.termRecv.clear();
      // 입력 창도 0 에서 — 소화 통지(termInputAck)는 끊김 중 유실될 수 있다
      // (stale 통지가 늦게 오면 0 으로 포화 — 무해)
      this.termSent.clear();
      for (const m of this.queue) this.ws.send(m);
      this.queue.length = 0;
      // 창 초과로 대기하던 입력 재전송 — 리셋된 카운터로 다시 창 검사를 거친다
      // (재차 막히면 writeTerm 이 다시 대기시키고 blocked 를 알린다)
      for (const [term, q] of [...this.termInputQueue]) {
        this.termInputQueue.delete(term);
        for (const data of q) this.writeTerm(term, data);
      }
      // WHY: 재연결 알림은 큐 flush 뒤 — 구독자의 재동기화 요청이 밀린 요청을 앞지르지 않게
      if (this.everOpened || this.retrying) this.connHandler?.(true);
      this.retrying = false;
      this.everOpened = true;
    };
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        void this.handleBinary(ev.data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // 깨진 프레임 하나가 onmessage 를 터뜨리지 않게
      }
      if (msg.event === 'connectStage') {
        this.stageHandler?.(msg.stage, typeof msg.bytes === 'number' ? msg.bytes : undefined);
        return;
      }
      if (msg.event === 'termData') {
        // ack 는 렌더러가 이 청크를 실제로 처리한 뒤(done) — 도착 즉시 ack 하면 xterm
        // 처리 속도와 무관하게 데몬이 계속 보내, 못 그린 데이터가 xterm 내부 버퍼에
        // 무한정 쌓인다 (데몬 flow control 이 네트워크 구간만 제한하게 된다)
        let acked = false;
        const done = () => {
          if (acked) return;
          acked = true;
          // 정리(dispose·termExit)된 터미널의 늦은 done — 카운터 항목을 되살리지 않는다
          if (!this.termEpoch.has(msg.term)) return;
          const n = (this.termRecv.get(msg.term) ?? 0) + msg.data.length;
          if (n >= CHAR_COUNT_ACK_SIZE) {
            this.send({ method: 'termAck', params: { term: msg.term, chars: n } });
            this.termRecv.set(msg.term, 0);
          } else {
            this.termRecv.set(msg.term, n);
          }
        };
        const handler = this.termHandlers.get(msg.term);
        // 구독자 없음(정리 직후 도착한 잔류 청크) — 받은 것으로 친다
        if (!handler) {
          done();
          return;
        }
        try {
          handler(msg.data, done);
        } catch (e) {
          // 핸들러가 던져도 이 청크 몫이 미ack 로 새서 고수위에 영구히 걸리지 않게
          done();
          throw e;
        }
        return;
      }
      if (msg.event === 'termInputAck') {
        // 정리된 터미널의 늦은 통지 — 카운터 항목을 되살리지 않는다
        if (!this.termEpoch.has(msg.term)) return;
        // 데몬 쓰기 스레드가 셸에 실제로 쓴 몫 — 창이 열린 만큼 대기 입력을 이어 보낸다
        let sent = Math.max(0, (this.termSent.get(msg.term) ?? 0) - msg.chars);
        const q = this.termInputQueue.get(msg.term);
        if (q) {
          while (q.length > 0 && sent < INPUT_WINDOW_CHARS) {
            const data = q.shift()!;
            sent += data.length;
            this.send({ method: 'termWrite', params: { term: msg.term, data } });
          }
          if (q.length === 0) {
            this.termInputQueue.delete(msg.term);
            this.inputBlockedHandler?.(msg.term, false);
          }
        }
        this.termSent.set(msg.term, sent);
        return;
      }
      if (msg.event === 'fsChanges') {
        this.fsHandler?.(msg.changes ?? [], msg.overflow === true);
        return;
      }
      if (msg.event === 'request') {
        void this.handleRequest(msg.rid, String(msg.method ?? ''), msg.params);
        return;
      }
      if (msg.event === 'termTmux') {
        // 와이어 v17: 붙은 tmux 세션 (id·name) 또는 plain 대체 사유(error). 첫 출력보다 먼저 온다
        const cb = this.termTmuxHandlers.get(msg.term);
        if (typeof msg.id === 'string') cb?.({ id: msg.id, name: String(msg.name ?? msg.id) });
        else cb?.(null, String(msg.error ?? 'tmux 실패'));
        return;
      }
      if (msg.event === 'termExit') {
        // WHY: 콜백을 정리보다 먼저 — dispose(사용자 kill)가 지운 뒤 도착한 termExit 는
        //      맵에 없어 조용히 끝난다 (자연 종료에만 발화하는 계약)
        const onExit = this.termExitHandlers.get(msg.term);
        this.termHandlers.delete(msg.term);
        this.termExitHandlers.delete(msg.term);
        this.termTmuxHandlers.delete(msg.term);
        this.termRecv.delete(msg.term);
        this.termEpoch.delete(msg.term);
        this.termSent.delete(msg.term);
        this.termInputQueue.delete(msg.term);
        // code 부재 = 비정상 종료(spawn 실패 등) — null 로 구분해 전달
        onExit?.(typeof msg.code === 'number' ? msg.code : null);
        return;
      }
      if (msg.event) return;
      // id 0 = 백엔드가 대신 보낸 attach 의 응답. 재연결인데 resumed 가 아니면
      // 데몬이 세션을 회수한 것 — 끊김 이전 세대의 터미널만 죽었다.
      // 끊김 중 만든 터미널(현재 세대)은 큐 flush 로 새 세션에 살아 있으므로 제외
      if (msg.id === 0) {
        this.stageHandler?.(null); // attach 응답 = 접속 단계 완료
        // terminal (와이어 v17) — 데몬의 터미널 방식. 구버전 데몬은 필드가 없다 (unsupported 취급 않음)
        const t = msg.result?.terminal;
        if (t && typeof t.mode === 'string') this.terminalModeHandler?.(t.mode, typeof t.error === 'string' ? t.error : null);
        if (this.isReconnect && msg.result?.resumed !== true) {
          const dead = [...this.termEpoch]
            .filter(([, epoch]) => epoch < this.connEpoch)
            .map(([term]) => term);
          for (const term of dead) this.termEpoch.delete(term);
          if (dead.length > 0) this.sessionLostHandler?.(dead);
        }
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
    this.ws.onclose = (ev) => {
      if (this.disposed) return; // 의도적 종료 — 실패 통보·재연결 모두 없음 (dispose 가 정리했다)
      // relay 의 close 4403 = 미등록 세션. 레지스트리에서 빠진 세션은 재연결해도 다시
      // 거부되므로 재시도를 영구히 멈춘다 (종전에는 1초 간격 무한 재연결에 빠졌다).
      // 연결 표시는 끊김으로 남긴다 — 앱이라면 곧 reconcile 이 이 백엔드째로 dispose 한다
      // 4502 = relay 의 접속 실패(ssh 접속·원격 데몬 기동·attach 실패), 사유 동봉 — 재연결해도
      // 같은 결과(원격은 매번 ssh 를 다시 띄운다)라 자동 재시도하지 않고 사유를 UI 에 넘긴다
      // (재접속은 사용자 몫)
      if (ev.code === 4403 || ev.code === 4502) {
        this.gaveUp = true;
        const reason = ev.code === 4403 ? '세션이 등록되어 있지 않다' : ev.reason || '접속 실패';
        for (const p of this.pending.values()) p.reject(new Error(reason));
        this.pending.clear();
        this.queue.length = 0;
        this.connHandler?.(false, ev.code === 4502 ? reason : undefined);
        return;
      }
      // WHY: 재시도 실패도 close 를 쏜다(브라우저 1006) — 열렸던 연결의 close 일 때만
      //      reject 해야 한다. 안 그러면 끊김 중 만들어져 큐(미전송)에 있는 요청이
      //      "실패" 통보 후 재연결 때 조용히 전송돼 유령 쓰기가 된다 (응답은 버려져
      //      etag 미갱신 → 다음 저장이 스퓨리어스 충돌).
      const wasOpen = this.opened;
      this.opened = false;
      if (wasOpen) {
        // 전송돼 진행 중이던 요청만 실패 처리 — 큐는 남아 재연결 후 나간다
        for (const p of this.pending.values()) p.reject(new Error('백엔드 연결이 끊겼다'));
        this.pending.clear();
      }
      this.connHandler?.(false);
      // ponytail: 고정 1초 재시도, 무한 (영구 포기는 위의 4403·4502 만) — 백오프는 필요해지면
      setTimeout(() => this.connect(), 1000);
    };
  }

  /**
   * 바이너리 payload 프레임 (와이어 v6): 4B BE 헤더 길이 + 헤더 JSON + 본문 바이트.
   * 헤더는 content 없는 응답 봉투(id·result 메타·payload 명세)이고, 본문을 명세대로
   * 복원해 content 로 합친 뒤 일반 응답과 동일하게 resolve 한다 — 호출측(ThinBackend
   * 표면)은 전송 표현을 모른다. 대형 응답만 이 통로를 타므로 배압 계약과 무관하다.
   */
  private async handleBinary(buf: ArrayBuffer): Promise<void> {
    let id: number | undefined;
    try {
      const hlen = new DataView(buf).getUint32(0);
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen)));
      id = header.id;
      const body = new Uint8Array(buf, 4 + hlen);
      const spec = header.result?.payload ?? {};
      const bytes = spec.enc === 'deflate-raw' ? await inflateRaw(body) : body;
      const result = header.result ?? {};
      delete result.payload;
      result.content = spec.type === 'base64' ? bytesToBase64(bytes) : new TextDecoder().decode(bytes);
      const p = typeof id === 'number' ? this.pending.get(id) : undefined;
      if (!p || typeof id !== 'number') return;
      this.pending.delete(id);
      p.resolve(result);
    } catch (e) {
      // 해석 실패 — 해당 요청만 실패시킨다 (id 를 못 읽었으면 타임아웃 없이 pending 에
      // 남지만, 연결 종료 시 일괄 reject 되는 기존 안전망을 따른다)
      const p = typeof id === 'number' ? this.pending.get(id) : undefined;
      if (p && typeof id === 'number') {
        this.pending.delete(id);
        p.reject(new Error(`payload 프레임 해석 실패: ${e instanceof Error ? e.message : e}`));
      }
    }
  }

  /**
   * 데몬→프론트 요청 (와이어 v9) — 구독자 결과를 requestReply 로 되돌린다. 구독자 부재·throw
   * 는 error 로. 끊김 중 답은 큐로 가는데, 데몬은 끊김 시점에 요청자에게 이미 에러를 돌려
   * 늦은 답은 무시된다 (rid 미대응)
   */
  private async handleRequest(rid: unknown, method: string, params: unknown): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      if (!this.requestHandler) throw new Error('요청 처리기 없음');
      reply = { rid, result: (await this.requestHandler(method, params)) ?? null };
    } catch (e) {
      reply = { rid, error: e instanceof Error ? e.message : String(e) };
    }
    this.send({ method: 'requestReply', params: reply });
  }

  /** 영구 실패(4403·4502) 뒤 사용자 주도 재접속 — 포기를 풀고 다시 연다. 포기 상태가
   *  아니거나 이미 dispose 된 뒤(세션 탭이 없다)면 무동작 */
  reconnect(): void {
    if (this.disposed || !this.gaveUp) return;
    this.gaveUp = false;
    this.retrying = true;
    this.connect();
  }

  /** 세션 탭 닫기 등 의도적 종료 — 재연결을 멈추고 연결·대기 요청을 정리한다 */
  dispose(): void {
    this.disposed = true;
    for (const p of this.pending.values()) p.reject(new Error('세션이 닫혔다'));
    this.pending.clear();
    this.queue.length = 0;
    this.ws.close();
  }

  private send(obj: unknown): void {
    const s = JSON.stringify(obj);
    if (this.opened) this.ws.send(s);
    else this.queue.push(s);
  }

  /** 터미널 입력 전송 — 미소화량이 창을 넘으면 로컬 큐에 대기 (입력 배압의 프론트 반쪽) */
  private writeTerm(term: number, data: string): void {
    const q = this.termInputQueue.get(term);
    // 이미 대기 중이면 뒤에 붙인다 — 순서 보장 (창이 열려도 큐부터 나간다)
    if (q) {
      q.push(data);
      return;
    }
    const sent = this.termSent.get(term) ?? 0;
    if (sent >= INPUT_WINDOW_CHARS) {
      this.termInputQueue.set(term, [data]);
      this.inputBlockedHandler?.(term, true);
      return;
    }
    this.termSent.set(term, sent + data.length);
    this.send({ method: 'termWrite', params: { term, data } });
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
  readFile(path: string, opts?: { maxBytes?: number; encoding?: 'base64'; offset?: number }): Promise<FileContent> {
    return this.call('readFile', { path, maxBytes: opts?.maxBytes, encoding: opts?.encoding, offset: opts?.offset });
  }
  stat(path: string): Promise<FileStat> {
    return this.call('stat', { path });
  }
  writeFile(path: string, content: string, etag?: string, encoding?: 'base64', append?: boolean): Promise<WriteResult> {
    // etag/encoding 이 undefined 면 JSON.stringify 가 키를 떨군다 — 데몬은 부재로 본다
    return this.call('writeFile', { path, content, etag, encoding, append });
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
  copy(from: string, to: string): Promise<void> {
    return this.call('copy', { from, to });
  }
  delete(path: string): Promise<void> {
    return this.call('delete', { path });
  }
  quickOpen(pattern: string, fresh?: boolean): Promise<QuickOpenResult> {
    return this.call('quickOpen', { pattern, fresh });
  }
  browseDir(path: string): Promise<string[]> {
    return this.call('browseDir', { path });
  }
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<FileSearchResult[]> {
    return this.call('search', { query, opts: opts ?? {} });
  }
  gitRepos(): Promise<string[]> {
    return this.call('gitRepos');
  }
  gitStatus(repo: string): Promise<GitStatus> {
    return this.call('gitStatus', { repo });
  }
  gitOriginalContent(repo: string, path: string): Promise<string> {
    return this.call('gitOriginalContent', { repo, path });
  }
  gitCommit(repo: string, message: string): Promise<void> {
    return this.call('gitCommit', { repo, message });
  }
  gitStage(repo: string, paths: string[]): Promise<void> {
    return this.call('gitStage', { repo, paths });
  }
  gitUnstage(repo: string, paths: string[]): Promise<void> {
    return this.call('gitUnstage', { repo, paths });
  }
  gitDiscard(repo: string, paths: string[], untracked: string[]): Promise<void> {
    return this.call('gitDiscard', { repo, paths, untracked });
  }
  gitLog(repo: string, limit: number): Promise<GitLogItem[]> {
    return this.call('gitLog', { repo, limit });
  }
  gitBranches(repo: string): Promise<string[]> {
    return this.call('gitBranches', { repo });
  }
  gitCheckout(repo: string, branch: string): Promise<void> {
    return this.call('gitCheckout', { repo, branch });
  }
  gitFetch(repo: string): Promise<void> {
    return this.call('gitFetch', { repo });
  }
  gitPull(repo: string): Promise<void> {
    return this.call('gitPull', { repo });
  }
  gitPush(repo: string): Promise<void> {
    return this.call('gitPush', { repo });
  }

  onFsChanges(cb: (changes: FsChange[], overflow: boolean) => void): void {
    this.fsHandler = cb;
  }

  onConnectStage(cb: (stage: ConnectStage | null, bytes?: number) => void): void {
    this.stageHandler = cb;
  }

  onConnection(cb: (connected: boolean, error?: string) => void): void {
    this.connHandler = cb;
  }

  onInputBlocked(cb: (term: number, blocked: boolean) => void): void {
    this.inputBlockedHandler = cb;
  }

  onSessionLost(cb: (deadTerms: number[]) => void): void {
    this.sessionLostHandler = cb;
  }

  onRequest(cb: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = cb;
  }

  createTerminal(cols: number, rows: number, attach?: string): TerminalSession {
    // WHY: 계약이 동기 반환이라 term id 는 클라이언트가 발급하고 생성은 fire-and-forget
    const term = this.nextTerm++;
    // 끊김 중 생성분은 다음 연결에서 데몬에 전달된다 — 그 세대로 기록해야
    // 세션 회수 재연결에서 산 터미널로 분류된다
    this.termEpoch.set(term, this.opened ? this.connEpoch : this.connEpoch + 1);
    // attach 가 undefined 면 JSON.stringify 가 키를 떨군다 — 데몬은 새 세션으로 본다
    this.send({ method: 'createTerminal', params: { term, cols, rows, attach } });
    return this.termHandle(term);
  }

  listTerminals(all?: boolean): Promise<TerminalInfo[]> {
    return this.call('listTerminals', { all });
  }
  killTerminal(id: string): Promise<void> {
    return this.call('killTerminal', { id });
  }
  renameTerminal(id: string, name: string): Promise<void> {
    return this.call('renameTerminal', { id, name });
  }
  async applyTmuxConf(content: string): Promise<string> {
    const r = await this.call<{ message?: string }>('tmuxConf', { content });
    return r?.message ?? '';
  }
  onTerminalMode(cb: (mode: TerminalMode, error: string | null) => void): void {
    this.terminalModeHandler = cb;
  }

  /** 로컬 핸들 — createTerminal·adoptTerminal 이 공유한다 (id 만 다르다) */
  private termHandle(term: number): TerminalSession {
    const forget = () => {
      this.termHandlers.delete(term);
      this.termExitHandlers.delete(term);
      this.termTmuxHandlers.delete(term);
      this.termRecv.delete(term);
      this.termEpoch.delete(term);
      this.termSent.delete(term);
      this.termInputQueue.delete(term);
    };
    return {
      id: term,
      write: (data) => this.writeTerm(term, data),
      onData: (cb) => this.termHandlers.set(term, cb),
      onExit: (cb) => this.termExitHandlers.set(term, cb),
      onTmux: (cb) => this.termTmuxHandlers.set(term, cb),
      resize: (c, r) => this.send({ method: 'termResize', params: { term, cols: c, rows: r } }),
      dispose: () => {
        this.send({ method: 'disposeTerminal', params: { term } });
        forget();
      },
      release: forget,
    };
  }

  adoptTerminal(opts: { term?: number; from?: { session: string; term: number } }): TerminalSession {
    // 같은 세션의 기존 터미널 (세션 탭이 창을 옮겨 같은 id 로 재-attach) — 데몬에 보낼 것이
    // 없다. 로컬 id 카운터를 그 위로 올려 새 터미널과 충돌하지 않게 한다
    if (opts.from === undefined) {
      const term = opts.term ?? this.nextTerm;
      this.nextTerm = Math.max(this.nextTerm, term + 1);
      this.termEpoch.set(term, this.opened ? this.connEpoch : this.connEpoch + 1);
      return this.termHandle(term);
    }
    // 다른 세션(같은 root)의 터미널 — 데몬이 소유를 옮긴다 (와이어 v10). 새 로컬 id 를 발급해
    // 이 세션의 기존 id 와 충돌하지 않게 한다. 실패(출처 세션 회수·root 불일치)는 onExit(null)
    // 로 드러내 탭이 에러 상태로 남게 한다 (spawn 실패와 같은 표현)
    const term = this.nextTerm++;
    this.termEpoch.set(term, this.opened ? this.connEpoch : this.connEpoch + 1);
    const handle = this.termHandle(term);
    void this.call('adoptTerminal', { from: opts.from.session, fromTerm: opts.from.term, term }).catch((e) => {
      this.termHandlers.get(term)?.(`\r\n[superlite: 터미널 이동 실패 — ${String((e as Error).message ?? e)}]\r\n`);
      this.termExitHandlers.get(term)?.(null);
    });
    return handle;
  }
}
