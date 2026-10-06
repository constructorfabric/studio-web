//! Who is in Studio right now, and where.
//!
//! **Heartbeats, not connections.** Presence could be inferred from who holds
//! an open SSE subscription, and that would be cheaper — but it answers a
//! narrower question. A browser tab left open overnight holds a subscription
//! and tells you nothing; a heartbeat carries *where the person is* and stops
//! the moment the tab is closed or the laptop sleeps. "Online" here means
//! somebody's Studio said so in the last [`ONLINE_TTL_MS`], which is a claim
//! that can be wrong by at most that window and is never wrong by a night.
//!
//! **In-process and lost on restart**, exactly like the event hub's replay
//! window and the task registries that feed it. That is the right trade for
//! presence: a restart makes everybody look offline for one heartbeat
//! interval, and then the truth comes back on its own. Persisting it would
//! buy a stale row that outlives the process instead.

use std::collections::HashMap;
use std::sync::Mutex;

/// How often a client is expected to say it is still there.
pub const HEARTBEAT_MS: i64 = 30_000;

/// How long a heartbeat counts for. Three intervals: one missed beat is a
/// hiccup on a train, three in a row is somebody who has gone.
pub const ONLINE_TTL_MS: i64 = 3 * HEARTBEAT_MS;

/// Longest `place`/`detail` a client may send. They are labels for a person to
/// read, not a channel for content.
pub const MAX_LABEL: usize = 120;

/// Where somebody is, as the portal describes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Presence {
    pub user_id: String,
    /// Resolved once per heartbeat so the admin list does not have to join.
    pub display_name: Option<String>,
    /// The tenant they are looking at — an organization, workspace or project.
    pub tenant_id: String,
    /// A short label the portal chose: `projects`, `specs`, `sources`, …
    pub place: String,
    /// Optionally what exactly — a project name, a document title.
    pub detail: Option<String>,
    /// When they first appeared in this run. Restarts reset it, and the field
    /// says "since", not "connected at", for that reason.
    pub since_ms: i64,
    pub last_seen_ms: i64,
}

impl Presence {
    /// Whether this record still counts as online at `now`.
    ///
    /// A record from the future counts: clock skew between a browser and the
    /// server is somebody else's problem, and treating a skewed client as
    /// offline would make it flicker rather than making it honest. Only the
    /// past is judged.
    pub fn is_online(&self, now_ms: i64) -> bool {
        now_ms - self.last_seen_ms < ONLINE_TTL_MS
    }
}

/// Trim a client-supplied label to something safe to store and show.
///
/// Returns `None` for what is only whitespace: an empty label and a missing
/// one are the same fact, and keeping both would give the UI two ways to
/// render nothing.
pub fn clean_label(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(MAX_LABEL).collect())
}

/// Longest message somebody may send. A note, not a document: anything
/// longer belongs somewhere it can be replied to.
pub const MAX_MESSAGE: usize = 1_000;

/// The most notes one recipient can have waiting. Past this the oldest go,
/// because an inbox that fills up silently is worse than one that says it
/// dropped something.
pub const MAX_INBOX: usize = 20;

/// A note from one person to another, waiting to be picked up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    pub id: String,
    pub from_user_id: String,
    pub from_display_name: Option<String>,
    pub text: String,
    pub sent_ms: i64,
}

/// The live set, keyed by user.
///
/// One record per person, not per tab. Somebody with Studio open in three
/// windows is one person who is here, and listing them three times would make
/// the admin view read like a traffic report.
#[derive(Default)]
pub struct PresenceRegistry {
    people: Mutex<HashMap<String, Presence>>,
    /// Notes waiting for each recipient, oldest first.
    ///
    /// Held here rather than in a table because they are not correspondence:
    /// a note is for somebody who is in Studio now, and one that outlives the
    /// process would arrive tomorrow, out of context, from a conversation
    /// nobody remembers. Delivery is a drain — read once, then gone.
    inboxes: Mutex<HashMap<String, Vec<Message>>>,
}

impl PresenceRegistry {
    /// Record a heartbeat, and answer with the record as now held.
    ///
    /// `since_ms` survives an update — it is when the person arrived, and a
    /// heartbeat is not an arrival. It is reset only when they were already
    /// counted as gone, because coming back after being offline *is* one.
    pub fn beat(
        &self,
        user_id: &str,
        display_name: Option<String>,
        tenant_id: &str,
        place: Option<String>,
        detail: Option<String>,
        now_ms: i64,
    ) -> Presence {
        let mut people = self.people.lock().expect("presence registry poisoned");
        let existing = people.get(user_id);
        let since_ms = match existing {
            Some(previous) if previous.is_online(now_ms) => previous.since_ms,
            _ => now_ms,
        };
        let record = Presence {
            user_id: user_id.to_owned(),
            display_name,
            tenant_id: tenant_id.to_owned(),
            place: place.unwrap_or_else(|| "studio".to_owned()),
            detail,
            since_ms,
            last_seen_ms: now_ms,
        };
        people.insert(user_id.to_owned(), record.clone());
        record
    }

    /// Everybody currently online, most recently seen first.
    ///
    /// Pruning happens here rather than on a timer: the only thing that cares
    /// about a stale record is a read, and a background sweep would be a task
    /// whose entire job is to make a filter unnecessary.
    pub fn online(&self, now_ms: i64) -> Vec<Presence> {
        let mut people = self.people.lock().expect("presence registry poisoned");
        people.retain(|_, record| record.is_online(now_ms));
        let mut list: Vec<Presence> = people.values().cloned().collect();
        list.sort_by(|a, b| {
            b.last_seen_ms
                .cmp(&a.last_seen_ms)
                .then_with(|| a.user_id.cmp(&b.user_id))
        });
        list
    }

    /// Whether one person is online — what a send has to know before it
    /// promises delivery.
    pub fn is_online(&self, user_id: &str, now_ms: i64) -> bool {
        self.people
            .lock()
            .expect("presence registry poisoned")
            .get(user_id)
            .is_some_and(|record| record.is_online(now_ms))
    }

    /// Drop somebody immediately — a sign-out, not a timeout.
    ///
    /// Their inbox goes with them. A note written to somebody who then signed
    /// out was written to the person who was there, and holding it for their
    /// next session would deliver it into a different moment.
    ///
    /// Both maps are held together, people first, as [`Self::post_if_online`]
    /// holds them: a send cannot slip a note in between the two removals.
    pub fn forget(&self, user_id: &str) {
        let mut people = self.people.lock().expect("presence registry poisoned");
        people.remove(user_id);
        self.inboxes
            .lock()
            .expect("presence inboxes poisoned")
            .remove(user_id);
    }

    /// Leave a note for somebody who is online. Answers how many are now
    /// waiting for them, so a sender learns immediately that the recipient is
    /// not reading — or `None`, storing nothing, when they are not there.
    ///
    /// The check and the post are one step under the people lock. Checked
    /// apart, a sign-out landing between them would leave a note in an inbox
    /// [`Self::forget`] had already emptied, for the next session to receive.
    pub fn post_if_online(&self, to_user_id: &str, message: Message, now_ms: i64) -> Option<usize> {
        let people = self.people.lock().expect("presence registry poisoned");
        if !people
            .get(to_user_id)
            .is_some_and(|record| record.is_online(now_ms))
        {
            return None;
        }
        let mut inboxes = self.inboxes.lock().expect("presence inboxes poisoned");
        let inbox = inboxes.entry(to_user_id.to_owned()).or_default();
        inbox.push(message);
        // Oldest first out. A cap that dropped the NEWEST would make the
        // inbox stop working exactly when somebody needs to be reached.
        while inbox.len() > MAX_INBOX {
            inbox.remove(0);
        }
        Some(inbox.len())
    }

    /// Take everything waiting for somebody. A drain, not a read: the caller
    /// is the recipient's own client, and handing the same note twice would
    /// have it pop up again on the next heartbeat.
    pub fn drain(&self, user_id: &str) -> Vec<Message> {
        self.inboxes
            .lock()
            .expect("presence inboxes poisoned")
            .remove(user_id)
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: i64 = 1_700_000_000_000;

    fn beat_at(registry: &PresenceRegistry, user: &str, at: i64) -> Presence {
        registry.beat(user, None, "tenant", Some("specs".into()), None, at)
    }

    #[test]
    fn somebody_who_just_beat_is_online_and_somebody_who_stopped_is_not() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);

        assert_eq!(registry.online(T0 + HEARTBEAT_MS).len(), 1);
        // One missed beat is a hiccup on a train.
        assert_eq!(registry.online(T0 + 2 * HEARTBEAT_MS).len(), 1);
        // Three in a row is somebody who has gone.
        assert!(registry.online(T0 + ONLINE_TTL_MS).is_empty());
    }

    #[test]
    fn a_read_prunes_what_it_walks_past() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);
        registry.online(T0 + ONLINE_TTL_MS);
        // Gone from the map, not merely filtered out of one answer.
        assert!(!registry.is_online("alice", T0));
    }

    #[test]
    fn one_person_is_one_row_however_many_tabs_they_have() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);
        beat_at(&registry, "alice", T0 + 1_000);
        beat_at(&registry, "alice", T0 + 2_000);
        assert_eq!(registry.online(T0 + 2_000).len(), 1);
    }

    #[test]
    fn a_heartbeat_is_not_an_arrival() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);
        let later = beat_at(&registry, "alice", T0 + HEARTBEAT_MS);
        assert_eq!(later.since_ms, T0, "still here since T0");
        assert_eq!(later.last_seen_ms, T0 + HEARTBEAT_MS);
    }

    #[test]
    fn coming_back_after_going_offline_is_an_arrival() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);
        let back = beat_at(&registry, "alice", T0 + 10 * ONLINE_TTL_MS);
        assert_eq!(back.since_ms, T0 + 10 * ONLINE_TTL_MS);
    }

    #[test]
    fn a_clock_ahead_of_ours_does_not_read_as_gone() {
        // Skew between a browser and the server is not the person's fault, and
        // treating it as absence would make them flicker.
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0 + 60_000);
        assert!(registry.is_online("alice", T0));
    }

    #[test]
    fn the_newest_beat_is_listed_first() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);
        beat_at(&registry, "bob", T0 + 1_000);
        let online = registry.online(T0 + 1_000);
        assert_eq!(
            online
                .iter()
                .map(|p| p.user_id.as_str())
                .collect::<Vec<_>>(),
            ["bob", "alice"]
        );
    }

    #[test]
    fn signing_out_is_immediate_rather_than_a_wait() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "alice", T0);
        registry.forget("alice");
        assert!(!registry.is_online("alice", T0));
    }

    #[test]
    fn a_label_is_trimmed_capped_and_never_blank() {
        assert_eq!(clean_label("  specs  "), Some("specs".to_owned()));
        assert_eq!(clean_label("   "), None);
        assert_eq!(clean_label(""), None);
        assert_eq!(
            clean_label(&"x".repeat(500)).unwrap().chars().count(),
            MAX_LABEL
        );
    }

    fn note(id: &str, at: i64) -> Message {
        Message {
            id: id.to_owned(),
            from_user_id: "alice".to_owned(),
            from_display_name: None,
            text: "ping".to_owned(),
            sent_ms: at,
        }
    }

    #[test]
    fn a_note_waits_until_its_recipient_asks_for_it() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "bob", T0);
        assert_eq!(registry.post_if_online("bob", note("m1", T0), T0), Some(1));

        let taken = registry.drain("bob");
        assert_eq!(taken.len(), 1);
        // A drain, not a read: the same note must not pop up again on the
        // next heartbeat.
        assert!(registry.drain("bob").is_empty());
    }

    #[test]
    fn a_full_inbox_drops_the_oldest_not_the_newest() {
        // A cap that dropped the newest would make the inbox stop working at
        // exactly the moment somebody needs to be reached.
        let registry = PresenceRegistry::default();
        beat_at(&registry, "bob", T0);
        for i in 0..(MAX_INBOX + 3) {
            registry.post_if_online("bob", note(&format!("m{i}"), T0 + i as i64), T0);
        }
        let inbox = registry.drain("bob");
        assert_eq!(inbox.len(), MAX_INBOX);
        assert_eq!(inbox.first().unwrap().id, "m3");
        assert_eq!(inbox.last().unwrap().id, format!("m{}", MAX_INBOX + 2));
    }

    #[test]
    fn signing_out_takes_the_inbox_with_it() {
        let registry = PresenceRegistry::default();
        beat_at(&registry, "bob", T0);
        registry.post_if_online("bob", note("m1", T0), T0);
        registry.forget("bob");
        assert!(registry.drain("bob").is_empty());
    }

    #[test]
    fn a_note_to_somebody_not_here_is_not_stored() {
        let registry = PresenceRegistry::default();
        assert_eq!(registry.post_if_online("bob", note("m1", T0), T0), None);

        // Signed out after being here: the send that follows stores nothing
        // either, so the next session does not open on a stale note.
        beat_at(&registry, "bob", T0);
        registry.forget("bob");
        assert_eq!(registry.post_if_online("bob", note("m2", T0), T0), None);
        beat_at(&registry, "bob", T0 + 1);
        assert!(registry.drain("bob").is_empty());
    }

    #[test]
    fn a_place_nobody_sent_still_says_something() {
        let registry = PresenceRegistry::default();
        let record = registry.beat("alice", None, "tenant", None, None, T0);
        assert_eq!(record.place, "studio");
    }
}
