//! Incident persistence: one JSON file, written atomically (temp + rename) so
//! incidents and approvals survive restarts and a crash never leaves a
//! half-written file.

use super::error::HealingError;
use super::model::Incident;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    version: u32,
    incidents: BTreeMap<String, Incident>,
}

#[derive(Debug, Default)]
pub struct HealingStore {
    pub incidents: BTreeMap<String, Incident>,
    path: Option<PathBuf>,
}

impl HealingStore {
    pub fn in_memory() -> Self {
        Self::default()
    }

    pub fn open(path: PathBuf) -> Result<Self, HealingError> {
        let incidents = match std::fs::read(&path) {
            Ok(bytes) => {
                serde_json::from_slice::<StoreFile>(&bytes)
                    .map_err(|e| HealingError::Storage(format!("{}: {}", path.display(), e)))?
                    .incidents
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(HealingError::Storage(e.to_string())),
        };
        Ok(Self {
            incidents,
            path: Some(path),
        })
    }

    pub fn save(&self) -> Result<(), HealingError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let file = StoreFile {
            version: 1,
            incidents: self.incidents.clone(),
        };
        let bytes =
            serde_json::to_vec_pretty(&file).map_err(|e| HealingError::Storage(e.to_string()))?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes).map_err(|e| HealingError::Storage(e.to_string()))?;
        std::fs::rename(&tmp, path).map_err(|e| HealingError::Storage(e.to_string()))
    }
}
