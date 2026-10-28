//! Where each gear keeps its records, as this process runs (ADR-0051 §8a).
//!
//! A gear notes here, when it starts, where its `storage.<kind>` setting puts
//! each kind of its records, and the domain-model port notes each type a gear
//! takes in as its own. The architecture page reads it from the manifest, so
//! what it says is what the backend does, not what somebody last wrote down.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Mutex, OnceLock};

#[derive(Default)]
struct Places {
    /// `(gear, kind)` → the store, as the setting names it.
    stores: BTreeMap<(String, String), String>,
    /// gear → the model types it holds.
    types: BTreeMap<String, BTreeSet<String>>,
}

fn places() -> &'static Mutex<Places> {
    static PLACES: OnceLock<Mutex<Places>> = OnceLock::new();
    PLACES.get_or_init(Mutex::default)
}

/// `gear` keeps its `kind` records in `store` (`model`, `tables`, …).
pub fn note(gear: &str, kind: &str, store: &str) {
    if let Ok(mut p) = places().lock() {
        p.stores
            .insert((gear.to_owned(), kind.to_owned()), store.to_owned());
    }
}

/// `gear` holds the model type `type_id`.
pub fn held(gear: &str, type_id: &str) {
    if let Ok(mut p) = places().lock() {
        p.types
            .entry(gear.to_owned())
            .or_default()
            .insert(type_id.to_owned());
    }
}

/// The name a storage setting is written with: `Model` → `model`.
pub fn store_name(setting: impl std::fmt::Debug) -> String {
    format!("{setting:?}").to_lowercase()
}

/// One gear's records: each kind and its store, and the types it holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GearData {
    pub gear: String,
    pub stores: Vec<(String, String)>,
    pub types: Vec<String>,
}

/// Every gear that noted something, by name.
pub fn snapshot() -> Vec<GearData> {
    let Ok(p) = places().lock() else {
        return Vec::new();
    };
    let mut gears: BTreeMap<&str, GearData> = BTreeMap::new();
    let entry = |gears: &mut BTreeMap<&str, GearData>, g: &str| -> GearData {
        gears.remove(g).unwrap_or(GearData {
            gear: g.to_owned(),
            stores: Vec::new(),
            types: Vec::new(),
        })
    };
    for ((gear, kind), store) in &p.stores {
        let mut d = entry(&mut gears, gear);
        d.stores.push((kind.clone(), store.clone()));
        gears.insert(gear, d);
    }
    for (gear, types) in &p.types {
        let mut d = entry(&mut gears, gear);
        d.types = types.iter().cloned().collect();
        gears.insert(gear, d);
    }
    gears.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gear_s_stores_and_types_come_back_together() {
        note("gear-x-test", "records", "model");
        note("gear-x-test", "files", "tables");
        held("gear-x-test", "thing");
        held("gear-x-test", "thing");
        let x = snapshot()
            .into_iter()
            .find(|g| g.gear == "gear-x-test")
            .unwrap();
        assert_eq!(
            x.stores,
            vec![
                ("files".to_owned(), "tables".to_owned()),
                ("records".to_owned(), "model".to_owned())
            ]
        );
        assert_eq!(x.types, vec!["thing".to_owned()]);
    }

    #[test]
    fn a_setting_is_named_as_it_is_written() {
        #[derive(Debug)]
        enum S {
            Tables,
        }
        assert_eq!(store_name(S::Tables), "tables");
    }
}
