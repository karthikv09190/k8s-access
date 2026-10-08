//! Self-Healing: detection → diagnosis → proposal → administrator approval →
//! policy → execution → verification. There is no autonomous mode: the only
//! mutation path is `service::HealingService::execute_approved`.

pub mod analysis;
pub mod audit;
pub mod chat;
pub mod context;
pub mod credentials;
pub mod detector;
pub mod diagnosis;
pub mod error;
pub mod gateway;
pub mod model;
pub mod notify;
pub mod patch;
pub mod policy;
pub mod proposal;
pub mod provider;
pub mod reader;
pub mod rollback;
pub mod sanitizer;
pub mod service;
pub mod state_machine;
pub mod store;
pub mod verifier;

#[cfg(test)]
mod tests;
