//! 데몬→프론트 요청 통로 (와이어 v9) — 데몬 소켓에 접속한 요청자(셸 심 등, ticket
//! cli-open-command)의 frontRequest 를 세션의 프론트에 `{"event":"request",rid,method,params}`
//! 로 전달하고, 프론트의 requestReply(rid, result|error)를 요청자에게 응답으로 되돌린다.
//! 데몬은 method·params 를 해석하지 않는다 — 어떤 요청이 있는지는 프론트 핸들러의 몫.
//!
//! 요청자는 attach 없이 frontRequest 만 보내고 끊는다 — attach 는 세션 sink 를 빼앗는다
//! (tmux 식 탈취). 대상 세션은 PTY 환경변수 SUPERLITE_SESSION 이 알려 준다 (term.rs).
//!
//! ponytail: 타임아웃 없음 — 요청자가 기다리다 끊으면 응답 전송이 조용히 실패할 뿐이다.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedSender;

use crate::term::{sink_send, Sink, SinkState};

/// 데몬 전체 요청 번호 — 세션 간 겹치지 않게 (프론트 응답은 세션 연결로 오므로 겹쳐도
/// 되지만, 로그 대조가 쉬워진다)
static NEXT_RID: AtomicU64 = AtomicU64::new(1);

/// 세션별 미응답 요청: rid → (요청자 연결 tx, 요청자가 붙인 id)
pub(crate) type Pending = Mutex<HashMap<u64, (UnboundedSender<String>, Value)>>;

/// poison 무시 — 대기 맵은 어느 요청자의 패닉에도 남은 요청자에게 응답을 돌려야 한다
fn lock(p: &Pending) -> std::sync::MutexGuard<'_, HashMap<u64, (UnboundedSender<String>, Value)>> {
    p.lock().unwrap_or_else(|e| e.into_inner())
}

/// 요청자의 frontRequest 를 세션 프론트로 전달. 프론트 미접속(detach)이면 즉시 에러 —
/// 버퍼에 쌓아 두고 재접속을 기다리는 것은 요청자(셸 명령)의 기대가 아니다
pub(crate) fn request(
    pending: &Pending,
    sink: &Sink,
    req_tx: &UnboundedSender<String>,
    req_id: Value,
    method: &str,
    params: Value,
) {
    if !matches!(&*sink.lock().unwrap(), SinkState::Attached(_)) {
        let _ = req_tx
            .send(json!({"id": req_id, "error": "세션에 프론트가 접속해 있지 않다"}).to_string());
        return;
    }
    let rid = NEXT_RID.fetch_add(1, Ordering::Relaxed);
    lock(pending).insert(rid, (req_tx.clone(), req_id));
    // 검사 직후 끊긴 미시 race 는 버퍼(비폐기)로 가고, 연결 정리(fail_all)가 요청자에게
    // 에러를 돌린다 — 재접속 후 도착하는 늦은 응답은 pending 에 없어 무시된다
    sink_send(
        sink,
        json!({"event": "request", "rid": rid, "method": method, "params": params}).to_string(),
        false,
    );
}

/// 프론트의 requestReply → 요청자에게 응답 회신. error 가 있으면 에러, 없으면 result
pub(crate) fn reply(pending: &Pending, p: &Value) {
    let Some(rid) = p["rid"].as_u64() else { return };
    let Some((tx, id)) = lock(pending).remove(&rid) else {
        return;
    };
    let out = match p.get("error") {
        Some(e) if !e.is_null() => json!({"id": id, "error": e}),
        _ => json!({"id": id, "result": p["result"]}),
    };
    let _ = tx.send(out.to_string());
}

/// 프론트 연결 소실 — 응답이 올 수 없는 대기 요청 전부를 에러로 회신
pub(crate) fn fail_all(pending: &Pending, reason: &str) {
    let drained: Vec<_> = lock(pending).drain().collect();
    for (_, (tx, id)) in drained {
        let _ = tx.send(json!({"id": id, "error": reason}).to_string());
    }
}
