//! Desktop sessions: a workspace open in the desktop Studio (ADR-0027 §4).
//!
//! A container session is found by asking its runtime. A desktop session has
//! no runtime this backend can ask — no daemon knows about the member's laptop
//! — so it is a lease: the desktop says "still open" every
//! [`HEARTBEAT_SECS`], and a lease whose last word is older than
//! [`LEASE_TTL_SECS`] is gone.
//!
//! **Nothing is limited.** A member may have a workspace open on as many
//! devices as they like, several members may have it open at once, and a
//! container session may be running beside them all. Git already reconciles
//! them, and a lease is a record of where the workspace is open, not a
//! reservation of it. What a lease is for is to be found: the portal shows it,
//! and the desktop's events and commands (phases 4 and 5) are addressed by it.
//!
//! **State is per-process**, for the reason `studio-presence` gives: a restart
//! forgets every lease, and each desktop's next heartbeat writes its own back,
//! because a heartbeat and a registration are the same call and a lease's id
//! is derived rather than drawn. The failure is a desktop missing from the
//! portal for one heartbeat interval, which is better than a stored row
//! claiming a laptop that closed while the backend was down is still open.

use std::collections::HashMap;
use std::sync::Mutex;

use uuid::Uuid;

/// How often a desktop renews its lease.
pub const HEARTBEAT_SECS: u64 = 30;

/// A lease not renewed for this long has ended. Three heartbeats: one lost
/// request is not a closed laptop.
pub const LEASE_TTL_SECS: u64 = 3 * HEARTBEAT_SECS;

const DESKTOP_NS: Uuid = Uuid::from_u128(0x9c2d_41f0_7b3e_4a8d_b615_2e7f_0c93_d458);

/// The lease id of one device's session in one workspace, for one member.
///
/// Derived, like [`super::service::session_id_for`], so a desktop renewing
/// after a backend restart gets the id it had before.
pub fn desktop_session_id(workspace_id: Uuid, member: &str, device_id: &str) -> Uuid {
    let mut name = Vec::with_capacity(16 + member.len() + device_id.len() + 2);
    name.extend_from_slice(workspace_id.as_bytes());
    name.push(0);
    name.extend_from_slice(member.as_bytes());
    name.push(0);
    name.extend_from_slice(device_id.as_bytes());
    Uuid::new_v5(&DESKTOP_NS, &name)
}

/// A device id is the desktop's own, stable per installation: short and plain,
/// so it can key a lease and be logged.
pub fn valid_device_id(device_id: &str) -> bool {
    !device_id.is_empty()
        && device_id.len() <= 128
        && device_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The name a person gave their machine, trimmed to something a list can show.
pub fn device_label(name: Option<&str>) -> Option<String> {
    let name = name.map(str::trim).filter(|s| !s.is_empty())?;
    Some(name.chars().take(120).collect())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopLease {
    pub id: Uuid,
    pub workspace_id: Uuid,
    /// The member's home tenant, for the event ingress (phase 4).
    pub tenant_id: Uuid,
    /// The member's subject id, as the security context names them.
    pub member: String,
    pub device_id: String,
    pub device_name: Option<String>,
    pub started_at_epoch_secs: u64,
    pub last_seen_epoch_secs: u64,
}

impl DesktopLease {
    pub fn expires_at_epoch_secs(&self) -> u64 {
        self.last_seen_epoch_secs + LEASE_TTL_SECS
    }

    fn live_at(&self, now: u64) -> bool {
        now < self.expires_at_epoch_secs()
    }
}

/// Who is renewing, and from where.
pub struct Renewal<'a> {
    pub workspace_id: Uuid,
    pub tenant_id: Uuid,
    pub member: &'a str,
    pub device_id: &'a str,
    pub device_name: Option<String>,
}

/// Every live lease this process has heard of. The clock is the caller's, so
/// expiry is tested without waiting for it.
#[derive(Default)]
pub struct DesktopLeases {
    leases: Mutex<HashMap<Uuid, DesktopLease>>,
}

impl DesktopLeases {
    fn live(&self, now: u64) -> std::sync::MutexGuard<'_, HashMap<Uuid, DesktopLease>> {
        let mut leases = self.leases.lock().unwrap_or_else(|e| e.into_inner());
        leases.retain(|_, lease| lease.live_at(now));
        leases
    }

    /// Open a lease, or renew it. `true` when it was not open before — which
    /// after a restart includes a desktop that never closed.
    pub fn renew(&self, now: u64, renewal: Renewal<'_>) -> (DesktopLease, bool) {
        let id = desktop_session_id(renewal.workspace_id, renewal.member, renewal.device_id);
        let mut leases = self.live(now);
        let opened = !leases.contains_key(&id);
        let lease = leases.entry(id).or_insert_with(|| DesktopLease {
            id,
            workspace_id: renewal.workspace_id,
            tenant_id: renewal.tenant_id,
            member: renewal.member.to_owned(),
            device_id: renewal.device_id.to_owned(),
            device_name: None,
            started_at_epoch_secs: now,
            last_seen_epoch_secs: now,
        });
        lease.last_seen_epoch_secs = now;
        if renewal.device_name.is_some() {
            lease.device_name = renewal.device_name;
        }
        (lease.clone(), opened)
    }

    /// The workspace's live leases, oldest first.
    pub fn in_workspace(&self, now: u64, workspace_id: Uuid) -> Vec<DesktopLease> {
        let mut found: Vec<DesktopLease> = self
            .live(now)
            .values()
            .filter(|lease| lease.workspace_id == workspace_id)
            .cloned()
            .collect();
        found.sort_by_key(|lease| (lease.started_at_epoch_secs, lease.id));
        found
    }

    /// End a lease the member holds. Somebody else's lease is answered like a
    /// missing one: ending it is not theirs to do, and saying it exists would
    /// be telling them where a colleague is working from.
    pub fn end(&self, now: u64, id: Uuid, member: &str) -> bool {
        let mut leases = self.live(now);
        match leases.get(&id) {
            Some(lease) if lease.member == member => leases.remove(&id).is_some(),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn renewal<'a>(workspace_id: Uuid, member: &'a str, device_id: &'a str) -> Renewal<'a> {
        Renewal {
            workspace_id,
            tenant_id: Uuid::nil(),
            member,
            device_id,
            device_name: None,
        }
    }

    #[test]
    fn a_heartbeat_keeps_the_lease_and_its_id_and_silence_ends_it() {
        let leases = DesktopLeases::default();
        let ws = Uuid::new_v4();
        let (first, opened) = leases.renew(1_000, renewal(ws, "alice", "laptop"));
        assert!(opened);
        let (again, opened) = leases.renew(1_000 + HEARTBEAT_SECS, renewal(ws, "alice", "laptop"));
        assert!(!opened);
        assert_eq!(again.id, first.id);
        assert_eq!(again.started_at_epoch_secs, 1_000);
        assert_eq!(
            again.expires_at_epoch_secs(),
            1_000 + HEARTBEAT_SECS + LEASE_TTL_SECS
        );

        let silent_until = again.expires_at_epoch_secs();
        assert_eq!(leases.in_workspace(silent_until - 1, ws).len(), 1);
        assert!(leases.in_workspace(silent_until, ws).is_empty());
    }

    #[test]
    fn a_restart_is_healed_by_the_next_heartbeat_under_the_same_id() {
        let ws = Uuid::new_v4();
        let before = DesktopLeases::default()
            .renew(10, renewal(ws, "alice", "laptop"))
            .0;
        let after_restart = DesktopLeases::default();
        let (lease, opened) = after_restart.renew(20, renewal(ws, "alice", "laptop"));
        assert!(opened);
        assert_eq!(lease.id, before.id);
    }

    #[test]
    fn nothing_limits_how_many_are_open() {
        let leases = DesktopLeases::default();
        let ws = Uuid::new_v4();
        leases.renew(1, renewal(ws, "alice", "laptop"));
        leases.renew(2, renewal(ws, "alice", "desktop"));
        leases.renew(3, renewal(ws, "bob", "laptop"));
        leases.renew(4, renewal(Uuid::new_v4(), "alice", "laptop"));
        let open = leases.in_workspace(5, ws);
        assert_eq!(
            open.iter()
                .map(|l| (l.member.as_str(), l.device_id.as_str()))
                .collect::<Vec<_>>(),
            [("alice", "laptop"), ("alice", "desktop"), ("bob", "laptop")]
        );
    }

    #[test]
    fn only_its_holder_ends_a_lease() {
        let leases = DesktopLeases::default();
        let ws = Uuid::new_v4();
        let (lease, _) = leases.renew(1, renewal(ws, "alice", "laptop"));
        assert!(!leases.end(2, lease.id, "bob"));
        assert_eq!(leases.in_workspace(2, ws).len(), 1);
        assert!(leases.end(2, lease.id, "alice"));
        assert!(!leases.end(2, lease.id, "alice"));
    }

    #[test]
    fn a_heartbeat_without_a_name_keeps_the_one_it_had() {
        let leases = DesktopLeases::default();
        let ws = Uuid::new_v4();
        let mut named = renewal(ws, "alice", "laptop");
        named.device_name = device_label(Some("  Alice's ThinkPad  "));
        leases.renew(1, named);
        let (lease, _) = leases.renew(2, renewal(ws, "alice", "laptop"));
        assert_eq!(lease.device_name.as_deref(), Some("Alice's ThinkPad"));
        assert_eq!(device_label(Some("   ")), None);
    }

    #[test]
    fn a_device_id_is_short_and_plain() {
        assert!(valid_device_id("3f2a9c1e-laptop.local_1"));
        assert!(!valid_device_id(""));
        assert!(!valid_device_id("a/b"));
        assert!(!valid_device_id("has space"));
        assert!(!valid_device_id(&"x".repeat(129)));
    }
}
