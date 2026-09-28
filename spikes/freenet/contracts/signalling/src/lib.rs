//! Probe P-5: signalling mailbox contract. Throwaway spike code.
//!
//! State: a last-writer-wins map keyed by (linkId, role, seq). Each entry carries the
//! writer's timestamp `t` (ms). A tombstone is an entry with `d: true` and an empty payload.
//!
//! TTL without a clock: the contract never calls `time::now()`, because a wall-clock read
//! inside merge breaks order-independence. The TTL is a contract PARAMETER (`ttl_ms`), so an
//! entry expires at `t + ttl_ms`, and the "clock" is the highest `t` in the merged state.
//! Because expiry is monotone in `t`, the LWW winner for a key always expires last, which
//! makes purge-after-merge commutative, associative and idempotent.
//!
//! Wire form (state, delta): JSON `{"e":[{"l":str,"r":str,"s":u32,"t":u64,"d":bool,"p":str}]}`
//! with entries sorted by key, so equal maps have equal bytes. Summary: `[[l,r,s,t],...]`.
use std::collections::BTreeMap;

use freenet_stdlib::prelude::*;
use serde::{Deserialize, Serialize};

const MAX_ENTRIES: usize = 512;
const MAX_PAYLOAD: usize = 16 * 1024;
const DEFAULT_TTL_MS: u64 = 120_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub l: String,
    pub r: String,
    pub s: u32,
    pub t: u64,
    #[serde(default)]
    pub d: bool,
    #[serde(default)]
    pub p: String,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub struct Wire {
    #[serde(default)]
    pub e: Vec<Entry>,
}

#[derive(Deserialize, Default)]
struct Params {
    #[serde(default)]
    ttl_ms: Option<u64>,
}

type Key = (String, String, u32);
type Map = BTreeMap<Key, Entry>;

fn ttl(parameters: &Parameters<'_>) -> u64 {
    let bytes: &[u8] = parameters.as_ref();
    if bytes.is_empty() {
        return DEFAULT_TTL_MS;
    }
    serde_json::from_slice::<Params>(bytes)
        .ok()
        .and_then(|p| p.ttl_ms)
        .unwrap_or(DEFAULT_TTL_MS)
}

fn parse(bytes: &[u8]) -> Result<Wire, ContractError> {
    if bytes.is_empty() {
        return Ok(Wire::default());
    }
    serde_json::from_slice(bytes).map_err(|e| ContractError::Deser(e.to_string()))
}

fn check(e: &Entry) -> Result<(), ContractError> {
    if e.l.is_empty() || e.l.len() > 128 || e.r.is_empty() || e.r.len() > 16 {
        return Err(ContractError::InvalidUpdateWithInfo { reason: "bad key".into() });
    }
    if e.p.len() > MAX_PAYLOAD || (e.d && !e.p.is_empty()) {
        return Err(ContractError::InvalidUpdateWithInfo { reason: "bad payload".into() });
    }
    Ok(())
}

/// Total order on two entries for one key: later `t` wins, then tombstone, then payload bytes.
fn wins(a: &Entry, b: &Entry) -> bool {
    (a.t, a.d, a.p.as_bytes()) > (b.t, b.d, b.p.as_bytes())
}

fn absorb(map: &mut Map, entries: Vec<Entry>) -> Result<(), ContractError> {
    for e in entries {
        check(&e)?;
        let k = (e.l.clone(), e.r.clone(), e.s);
        match map.get(&k) {
            Some(cur) if !wins(&e, cur) => {}
            _ => {
                map.insert(k, e);
            }
        }
    }
    Ok(())
}

fn purge(map: &mut Map, ttl_ms: u64) {
    let high = map.values().map(|e| e.t).max().unwrap_or(0);
    map.retain(|_, e| e.t.saturating_add(ttl_ms) >= high);
    // Size cap: drop the oldest first; ties broken by key order, so it is deterministic.
    while map.len() > MAX_ENTRIES {
        let oldest = map
            .iter()
            .min_by(|a, b| (a.1.t, a.0).cmp(&(b.1.t, b.0)))
            .map(|(k, _)| k.clone());
        match oldest {
            Some(k) => {
                map.remove(&k);
            }
            None => break,
        }
    }
}

fn encode(map: Map) -> Result<Vec<u8>, ContractError> {
    let wire = Wire { e: map.into_values().collect() };
    serde_json::to_vec(&wire).map_err(|e| ContractError::Deser(e.to_string()))
}

pub struct Signalling;

#[contract]
impl ContractInterface for Signalling {
    fn validate_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
        _related: RelatedContracts<'static>,
    ) -> Result<ValidateResult, ContractError> {
        let wire = match parse(state.as_ref()) {
            Ok(w) => w,
            Err(_) => return Ok(ValidateResult::Invalid),
        };
        if wire.e.len() > MAX_ENTRIES || wire.e.iter().any(|e| check(e).is_err()) {
            return Ok(ValidateResult::Invalid);
        }
        // Only the canonical form is valid (sorted, deduplicated, already purged). The node
        // stores PUT bytes without running update_state, so a non-canonical state would be
        // rewritten by the first merge and `fdev verify-merge` reports state_idempotence.
        let mut map = Map::new();
        if absorb(&mut map, wire.e).is_err() {
            return Ok(ValidateResult::Invalid);
        }
        purge(&mut map, ttl(&_parameters));
        match encode(map) {
            Ok(bytes) if bytes.as_slice() == state.as_ref() => Ok(ValidateResult::Valid),
            _ => Ok(ValidateResult::Invalid),
        }
    }

    fn update_state(
        parameters: Parameters<'static>,
        state: State<'static>,
        data: Vec<UpdateData<'static>>,
    ) -> Result<UpdateModification<'static>, ContractError> {
        let ttl_ms = ttl(&parameters);
        let mut map = Map::new();
        absorb(&mut map, parse(state.as_ref())?.e)?;
        for update in data {
            match update {
                UpdateData::State(s) => absorb(&mut map, parse(s.as_ref())?.e)?,
                UpdateData::Delta(d) => absorb(&mut map, parse(d.as_ref())?.e)?,
                UpdateData::StateAndDelta { state, delta } => {
                    absorb(&mut map, parse(state.as_ref())?.e)?;
                    absorb(&mut map, parse(delta.as_ref())?.e)?;
                }
                _ => return Err(ContractError::InvalidUpdate),
            }
        }
        purge(&mut map, ttl_ms);
        Ok(UpdateModification::valid(State::from(encode(map)?)))
    }

    fn summarize_state(
        _parameters: Parameters<'static>,
        state: State<'static>,
    ) -> Result<StateSummary<'static>, ContractError> {
        let wire = parse(state.as_ref())?;
        let summary: Vec<(String, String, u32, u64)> =
            wire.e.into_iter().map(|e| (e.l, e.r, e.s, e.t)).collect();
        let bytes = serde_json::to_vec(&summary).map_err(|e| ContractError::Deser(e.to_string()))?;
        Ok(StateSummary::from(bytes))
    }

    fn get_state_delta(
        _parameters: Parameters<'static>,
        state: State<'static>,
        summary: StateSummary<'static>,
    ) -> Result<StateDelta<'static>, ContractError> {
        let wire = parse(state.as_ref())?;
        let known: Vec<(String, String, u32, u64)> = if summary.as_ref().is_empty() {
            Vec::new()
        } else {
            serde_json::from_slice(summary.as_ref())
                .map_err(|e| ContractError::Deser(e.to_string()))?
        };
        let known: BTreeMap<Key, u64> =
            known.into_iter().map(|(l, r, s, t)| ((l, r, s), t)).collect();
        let mut out = Map::new();
        for e in wire.e {
            let k = (e.l.clone(), e.r.clone(), e.s);
            if known.get(&k).map_or(true, |t| *t < e.t) {
                out.insert(k, e);
            }
        }
        if out.is_empty() {
            return Ok(StateDelta::from(Vec::new()));
        }
        Ok(StateDelta::from(encode(out)?))
    }
}
