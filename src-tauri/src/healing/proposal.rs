//! Proposal integrity. A proposal's hash covers every field except the hash
//! itself; an approval records that hash and execution recomputes it, so any
//! change after approval (by the backend, a bug, or a tampered state file)
//! invalidates the approval.

use super::model::HealingProposal;
use sha2::{Digest, Sha256};

pub fn compute_hash(p: &HealingProposal) -> String {
    let mut unhashed = p.clone();
    unhashed.hash = String::new();
    // Struct field order is fixed and maps are BTreeMaps, so serialization is
    // deterministic.
    let bytes = serde_json::to_vec(&unhashed).expect("proposal serializes");
    let digest = Sha256::digest(&bytes);
    digest.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn seal(mut p: HealingProposal) -> HealingProposal {
    p.hash = compute_hash(&p);
    p
}

pub fn is_intact(p: &HealingProposal) -> bool {
    !p.hash.is_empty() && compute_hash(p) == p.hash
}
