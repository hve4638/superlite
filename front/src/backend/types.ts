/**
 * ThinBackend — 프론트가 원격(또는 mock)에 요구하는 전체 계약.
 *
 * WHY: 이 인터페이스가 프론트와 백엔드 사이의 유일한 seam 이다. 구현체는 셋 — WsBackend(백엔드 /ws
 *      JSON-RPC 로 rust 데몬에 중계, 주 경로)·MockBackend(브라우저 단독 데모)·EmptyBackend(빈 세션).
 *      여기에 UI 개념(탭, 뷰 상태 등)을 넣지 않는다 — 순수하게 워크스페이스 자원만 다룬다.
 *      와이어 버전 표기(v11 등)는 종전 backend/common WIRE_VERSION(2026-09-10 폐지 — IPC 주소가
 *      데몬 빌드 해시로 갈린다, ticket update-compat)의 bump 시점 — 이력 표식으로만 남는다.
 */

export interface WorkspaceInfo {
  /** 워크스페이스 루트의 표시 이름 (폴더명) */
  name: string;
  /** 루트 절대 경로. 모든 FileStat.path 는 이 경로 기준의 상대 경로다. */
  rootPath: string;
}

export interface DirEntry {
  name: string;
  /** 루트 기준 상대 경로 (구분자 '/') */
  path: string;
  kind: 'file' | 'directory';
  /** 디렉토리가 git 저장소 루트(.git 보유)면 true (와이어 v13) — 트리 펼침이 곧 하위 저장소 인식 */
  repo?: boolean;
  /** 수정 시각(ms epoch, 와이어 v16) — 폴더 탭 자세히 보기. metadata 실패면 없다 */
  mtime?: number;
  /** 바이트 크기(파일만, 와이어 v16) */
  size?: number;
}

export interface SearchMatch {
  /** 0-based 라인 번호 */
  line: number;
  /** 매치가 포함된 라인 전체 텍스트 */
  lineText: string;
  /** 라인 내 매치 시작/끝 컬럼 (0-based, [start, end)) */
  ranges: [number, number][];
}

export interface FileSearchResult {
  path: string;
  matches: SearchMatch[];
}

export type GitChangeKind = 'modified' | 'untracked' | 'deleted' | 'added';

export interface GitChange {
  path: string;
  kind: GitChangeKind;
  /** true 면 인덱스(staged) 쪽 변경. 한 파일이 staged·unstaged 양쪽에 있으면 항목이 둘이다 */
  staged: boolean;
}

export interface GitLogItem {
  hash: string;
  subject: string;
  author: string;
  /** 상대 시각 문자열 (git %ar — "3 hours ago") */
  date: string;
}

export interface GitStatus {
  branch: string;
  /** HEAD 커밋 해시 — diff original 캐시 무효화 키 (앱 밖 커밋도 잡는다). unborn/비 git 은 '' */
  head: string;
  /** 워킹트리에 변경이 있으면 true (브랜치명 옆 '*' 표시용) */
  dirty: boolean;
  changes: GitChange[];
}

export interface FsChange {
  /** 루트 기준 상대 경로 */
  path: string;
  kind: 'create' | 'change' | 'delete';
}

/** 텍스트 편집기에 표시할 수 없는 사유 — 파일은 실존하므로 탭은 열리고 안내 화면이 뜬다.
 *  large 는 크기 상한 초과(size 는 실측 바이트 — 안내 문구에 표시), binary 는 이진이거나
 *  UTF-8 이 아닌 인코딩. */
export type Unopenable = { kind: 'large'; size: number } | { kind: 'binary' };

/** unopenable 이면 content 는 없다 — etag 는 양쪽 다 온다 (orphan 재검증·재로드용). */
export type FileContent =
  | { content: string; etag: string; unopenable?: undefined }
  | { content?: undefined; etag: string; unopenable: Unopenable };

export interface FileStat {
  /** readFile 의 etag 와 같은 (mtime,size) 기반 불투명 토큰 */
  etag: string;
  /** 바이트 크기 (와이어 v11) — hex 뷰어가 범위 읽기 전에 전체 길이를 안다 */
  size: number;
}

/** conflict 면 쓰지 않았다 — etag 시점 이후 디스크가 바뀌었고 내용도 다르다. */
export type WriteResult =
  | { etag: string; conflict?: undefined }
  | { etag?: undefined; conflict: true };

/** PTY 세션 핸들 — 세 구현체 공용 계약 (WsBackend 는 데몬 PTY, mock 은 가짜 셸, empty 는 만들지 않는다). */
export interface TerminalSession {
  /** 백엔드 구현이 발급하는 식별자 — onSessionLost 의 죽은 터미널 명단과 대조하는 용도 */
  readonly id: number;
  write(data: string): void;
  /** done 이 오면 구독자는 청크 처리(xterm 그리기)를 마친 뒤 호출해야 한다 —
   *  WsBackend 가 이를 ack 시점으로 삼아 렌더러 속도를 배압에 반영한다 (mock 은 생략). */
  onData(cb: (data: string, done?: () => void) => void): void;
  /** 셸이 스스로 종료(exit·crash)하면 exit code 와 함께 발화 (spawn 실패는 null).
   *  dispose 로 인한 정리에는 발화하지 않는다. */
  onExit(cb: (code: number | null) => void): void;
  resize(cols: number, rows: number): void;
  dispose(): void;
  /** 로컬 핸들만 놓는다 — 데몬 터미널은 죽이지 않는다 (다른 창의 세션이 adoptTerminal 로
   *  이어받는 탭 이동 전용). 옵셔널 — mock·empty 는 이동 대상이 아니다 */
  release?(): void;
  /** 내장 tmux (와이어 v17): 이 PTY 가 붙은 tmux 세션 — 생성·attach 직후 한 번. info 가 null 이면
   *  tmux 를 못 써 일반 터미널로 대체된 것이고 error 가 사유 (사이드바 경고 배지) */
  onTmux?(cb: (info: { id: string; name: string } | null, error?: string) => void): void;
}

/** 데몬의 터미널 방식 (attach 응답, 와이어 v17) — tmux: 내장 tmux 서버(세션 생존·목록·다중 attach),
 *  plain: unix 인데 tmux 를 못 써 PTY 직접(경고 배지), unsupported: Windows (아이콘 자체가 없다) */
export type TerminalMode = 'tmux' | 'plain' | 'unsupported';

/** 살아 있는 tmux 세션 하나 (listTerminals 항목) — id 는 tmux session id(`$3`, 이름을 바꿔도 불변),
 *  root 는 세션 환경변수 SUPERLITE_TMUX_WORKSPACE_PATH, attached 는 붙은 클라이언트 수, activity·
 *  created 는 unix ms, command 는 활성 패널의 현재 명령 */
export interface TerminalInfo {
  id: string;
  name: string;
  root: string;
  attached: number;
  activity: number;
  created: number;
  command: string;
}

/** 원격 접속 단계 (relay 의 connectStage 이벤트) — ssh: 원격 정보 조회(인증 포함) → helper: 헬퍼
 *  존재 확인 → upload: 헬퍼 업로드(없을 때만, bytes 동봉) → daemon: 원격 데몬 기동·attach 대기.
 *  완료 신호는 따로 없다 — attach 응답 도달이 곧 완료. 로컬 세션은 이 이벤트가 오지 않는다 */
export type ConnectStage = 'ssh' | 'helper' | 'upload' | 'daemon';

export interface QuickOpenItem {
  path: string;
  /** 파일명 안 매치 문자 인덱스 (UTF-16) — 비어 있으면 경로로만 매치된 항목 */
  highlights: number[];
}
export interface QuickOpenResult {
  items: QuickOpenItem[];
  /** 상한(512)에 걸려 잘렸다 */
  limitHit: boolean;
}

export interface ThinBackend {
  workspace(): Promise<WorkspaceInfo>;
  /** path 디렉토리의 직계 엔트리. 정렬은 호출자 책임. 절대 경로(와이어 v16)면 워크스페이스 밖도
   *  나열한다 — 항목 path 는 절대('/' 구분), repo 표식 없음 (폴더 탭의 밖 탐색) */
  readDir(path: string): Promise<DirEntry[]>;
  /** 크기 초과(maxBytes 또는 백엔드 기본 상한)·이진/미지원 인코딩은 reject 가 아니라
   *  unopenable 로 온다 — 실존하지 않는 경로 등 실제 실패만 reject 다. maxBytes 는
   *  undo 캡처 등 호출측 상한 (초과 파일을 읽어 나르지 않는다).
   *  encoding: 'base64' 면 UTF-8 검증 없이 바이트를 base64 content 로 나른다 (이미지 뷰어 등 —
   *  writeFile 이진 통로와 대칭). binary unopenable 은 안 생기고 크기 상한(large)만 남는다.
   *  offset 이 있으면(base64 전용, 와이어 v11) 범위 읽기 — 크기 상한 없이 offset 부터 maxBytes
   *  만큼, EOF 를 넘으면 짧게 온다 (hex 뷰어 청크). path 는 루트 상대 외에 절대 경로도 받는다
   *  (폴더 탭의 밖 탐색 — 데몬은 '..' 만 거부). */
  readFile(path: string, opts?: { maxBytes?: number; encoding?: 'base64'; offset?: number }): Promise<FileContent>;
  /** 내용 없이 실존·변경만 확인하는 경량 검사 — 정규 파일 전용(디렉토리는 reject). orphan 재검증용. 절대 경로 허용 */
  stat(path: string): Promise<FileStat>;
  /**
   * etag 를 주면 낙관적 충돌 검사 — 불일치(+내용 상이) 시 쓰지 않고 conflict. 생략 시 무조건 쓴다.
   * encoding: 'base64' 면 content 를 이진으로 디코드해 쓴다 (클립보드 이미지 저장 등) —
   * JSON 텍스트 와이어의 이진 통로. 생략 시 UTF-8 텍스트 그대로.
   * append (와이어 v14): true 면 etag 검사 없이 기존 파일 끝에 덧붙인다 — 청크 업로드의 후속
   * 조각 (첫 조각은 append 없이 써 파일을 새로 만든다). path 는 절대 경로도 받는다.
   */
  writeFile(path: string, content: string, etag?: string, encoding?: 'base64', append?: boolean): Promise<WriteResult>;
  /** 빈 파일 배타적 생성 — 중간 디렉토리 자동 생성, 이미 존재하면 reject (기존 내용 보호) */
  createFile(path: string): Promise<void>;
  /** 디렉토리 배타적 생성 — 중간 디렉토리 자동, 이미 존재하면 reject (undo 의 "내가 만든 것" 전제 보호) */
  createDir(path: string): Promise<void>;
  /** 이름 변경/이동 — 대상이 이미 존재하면 reject */
  rename(from: string, to: string): Promise<void>;
  /** 파일·디렉토리 복사 (와이어 v19, 디렉토리는 재귀) — 대상이 이미 존재하거나 자기 하위면 reject */
  copy(from: string, to: string): Promise<void>;
  /** 파일·디렉토리 겸용 삭제 (디렉토리는 재귀, 휴지통 없음) */
  delete(path: string): Promise<void>;
  /** Quick Open 후보 검색 (와이어 v12) — 목록은 백엔드가 들고, 패턴별 상위 결과만 온다.
   *  파일명 subsequence 매치(highlights = 파일명 안 인덱스)가 앞, 전체 경로 매치(highlights
   *  없음)가 뒤. fresh 면 백엔드가 목록을 다시 걷는다 — 무효화 판단은 호출측(files 모듈) */
  quickOpen(pattern: string, fresh?: boolean): Promise<QuickOpenResult>;
  /**
   * '폴더 열기' 경로 탐색용 — 임의 절대 경로의 하위 디렉토리 이름 나열 (정렬됨).
   * 실 백엔드 전용 (mock 은 가짜 트리 밖 경로가 없어 미구현 — 커맨드 등록의 지원 신호로도 쓴다).
   */
  browseDir?(path: string): Promise<string[]>;
  /** 단순 부분 문자열 검색. 대소문자 무시 여부는 옵션. */
  search(query: string, opts?: { caseSensitive?: boolean }): Promise<FileSearchResult[]>;
  /**
   * 워크스페이스 안의 git 저장소 자동 탐색 (와이어 v13) — 루트 포함, 루트 상대 디렉토리 목록
   * (루트는 ''). 깊이·개수 상한은 데몬 몫 — 더 깊은 저장소는 readDir 의 repo 표식으로 닿는다.
   * 이하 git* 의 repo 는 이 목록의 원소이고, path 계열 인자·결과는 그 저장소 기준 상대 경로다.
   */
  gitRepos(): Promise<string[]>;
  /** 저장소가 아니면 branch·head 둘 다 '' (unborn 은 branch 가 있다) */
  gitStatus(repo: string): Promise<GitStatus>;
  /** HEAD 시점 파일 내용 (diff 뷰의 original 쪽). untracked 면 빈 문자열. */
  gitOriginalContent(repo: string, path: string): Promise<string>;
  /** 인덱스(staged)만 커밋. 전체 커밋은 호출측이 gitStage 로 먼저 올린다 (VS Code smart commit). */
  gitCommit(repo: string, message: string): Promise<void>;
  /** 파일들을 인덱스에 올린다 (삭제도 스테이징). 빈 배열은 no-op */
  gitStage(repo: string, paths: string[]): Promise<void>;
  /** 파일들을 인덱스에서 내린다 (워킹트리는 그대로) */
  gitUnstage(repo: string, paths: string[]): Promise<void>;
  /** 워킹트리 변경 되돌리기 — paths 는 인덱스 내용으로 복원, untracked 는 파일 삭제. 파괴적 — 확인은 호출측 */
  gitDiscard(repo: string, paths: string[], untracked: string[]): Promise<void>;
  /** HEAD 부터 최근 커밋 목록 (unborn/비 git 은 빈 배열) */
  gitLog(repo: string, limit: number): Promise<GitLogItem[]>;
  /** 로컬 브랜치 이름 목록 */
  gitBranches(repo: string): Promise<string[]>;
  /** 브랜치 전환 (git checkout). 충돌 등 실패는 reject */
  gitCheckout(repo: string, branch: string): Promise<void>;
  /**
   * 원격 동기화 (와이어 v18). 인증은 그 머신의 credential helper(GCM 등)가 먼저 — 비었을 때 뒤에
   * 덧붙인 데몬의 helper 모드가 onRequest('credential', {action, host, …}) 를 프론트에 보낸다
   * (host.ts → gitauth, get/store/erase). 실패(인증 거부·충돌·원격 없음)는 git 의 stderr 로 reject
   */
  gitFetch(repo: string): Promise<void>;
  gitPull(repo: string): Promise<void>;
  /** 상류 없는 브랜치는 origin 에 같은 이름으로 올린다 (push.autoSetupRemote) */
  gitPush(repo: string): Promise<void>;
  /** attach (와이어 v17): 새 셸 대신 기존 tmux 세션(TerminalInfo.id)에 붙는다 — 같은 세션을 여러
   *  탭·창이 동시에 볼 수 있다 */
  createTerminal(cols: number, rows: number, attach?: string): TerminalSession;
  /** 살아 있는 tmux 세션 목록 (와이어 v17, 옵셔널 — WsBackend 만). 기본은 이 워크스페이스 것, all 이면
   *  이 서버의 전부. plain·unsupported 데몬은 빈 배열 */
  listTerminals?(all?: boolean): Promise<TerminalInfo[]>;
  /** tmux 세션 종료 (강제 닫기 — 실행 중인 프로세스가 죽는다). 탭 닫기는 detach 라 세션이 남는다 */
  killTerminal?(id: string): Promise<void>;
  renameTerminal?(id: string, name: string): Promise<void>;
  /** 클라이언트 tmux.conf 를 이 데몬에 적용 — 반환은 tmux 가 낸 경고·오류 문자열 (없으면 '') */
  applyTmuxConf?(content: string): Promise<string>;
  /** 데몬의 터미널 방식 구독 — attach 응답마다 (재접속 포함). error 는 plain 의 사유 */
  onTerminalMode?(cb: (mode: TerminalMode, error: string | null) => void): void;
  /**
   * 기존 데몬 터미널을 이 연결의 핸들로 잡는다 (탭을 다른 창으로 옮기기, 옵셔널 — WsBackend 만).
   * term 만 주면 같은 세션이 이미 소유한 터미널(세션 탭 분리 — 같은 session id 재-attach)의
   * 로컬 핸들 재구성, from 을 주면 같은 root 의 다른 세션이 소유한 터미널을 데몬에서 이 세션으로
   * 옮긴다 (와이어 v10 adoptTerminal — 새 로컬 id 발급). 이동 실패는 onExit(null) 로 드러난다.
   */
  adoptTerminal?(opts: { term?: number; from?: { session: string; term: number } }): TerminalSession;
  /**
   * 파일시스템 변경 푸시 구독 (외부 편집·터미널 작업 반영). overflow 면 changes 는 비어
   * 있고 전체 리프레시가 필요하다. mock 은 미구현 — 구독 자체가 없으면 감시도 없다.
   */
  onFsChanges?(cb: (changes: FsChange[], overflow: boolean) => void): void;
  /**
   * 연결 상태 변화 구독 (mock 은 끊길 일이 없어 미구현). 재연결 시 true — 끊김 중 놓친
   * 변경은 복구할 수 없으므로 구독자가 전체 리프레시로 재동기화해야 한다.
   * error: 재시도 무의미한 영구 실패의 사유 (원격 ssh 접속 실패 등) — 이때 connected=false 고정
   */
  onConnection?(cb: (connected: boolean, error?: string) => void): void;
  /** 원격 접속 단계 구독 (옵셔널 — WsBackend 만, 로컬 세션은 발화하지 않는다). null = 접속 완료
   *  (attach 응답 도달). 실패(onConnection 의 error)는 마지막으로 받은 단계에서 난 것이다 —
   *  구독자가 실패 단계를 기록한다 */
  onConnectStage?(cb: (stage: ConnectStage | null, bytes?: number) => void): void;
  /** 영구 실패(onConnection error) 뒤 사용자 주도 재접속 — 실패 전 상태로 돌아가 다시 연다.
   *  (옵셔널 — WsBackend 만). 실패하지 않은 연결에는 무동작 */
  reconnect?(): void;
  /**
   * 터미널 입력 배압 상태 구독 (옵셔널 — mock 은 즉시 소화라 미구현). 셸이 입력을 읽지
   * 않아 미소화 전송량이 창을 넘으면 (TerminalSession.id, true) — 이후 입력은 로컬 대기.
   * 대기분이 모두 나가면 false.
   */
  onInputBlocked?(cb: (term: number, blocked: boolean) => void): void;
  /**
   * 재연결은 됐지만 데몬 세션이 회수된 경우(장기 끊김) 구독. deadTerms 는 죽은 터미널의
   * TerminalSession.id 명단 — 구독자가 정리해야 응답 없는 유령 터미널이 남지 않는다.
   * 끊김 중에 만든 터미널은 재연결 큐 flush 로 새 세션에 살아 있으므로 명단 밖이다.
   */
  onSessionLost?(cb: (deadTerms: number[]) => void): void;
  /**
   * 데몬 소켓 요청자(셸 심 등)가 이 세션에 보낸 요청 구독 (와이어 v9, 옵셔널 — mock·빈
   * 세션은 요청자가 없다). 데몬은 method·params 를 해석하지 않는다 — 어떤 요청이 있는지는
   * 구독자의 몫. cb 의 반환값이 요청자에게 result 로, throw 는 error 로 돌아간다 (왕복).
   * 구독이 없으면 구현체가 에러로 답한다.
   */
  onRequest?(cb: (method: string, params: unknown) => Promise<unknown>): void;
  /** 연결·핸들 정리 (세션 닫기·창 회수). 옵셔널 — WsBackend(소켓 닫기)·MockBackend(타이머)만, empty 는 없다 */
  dispose?(): void;
}
