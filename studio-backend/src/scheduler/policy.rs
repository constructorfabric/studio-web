//! The two policies a schedule carries, and the rule that turns "this is due"
//! into "these instants should be enqueued".
//!
//! Both are `serverless-runtime`'s (`DESIGN.md` §3.1 Schedule), spelled the
//! same way so a schedule survives a move to that gear as data.

use time::OffsetDateTime;

use super::cron::Expression;

/// What to do when the previous run of a schedule has not finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Concurrency {
    /// Fire anyway. Right for work that is idempotent and cheap.
    Allow,
    /// Skip this firing. Right for a nightly import that takes longer than a
    /// day only when something is wrong.
    Forbid,
    /// Ask the previous run to stop, then fire. Only as good as the handler's
    /// cancellation — the new run does not wait for the old one to notice.
    Replace,
}

impl Concurrency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Forbid => "forbid",
            Self::Replace => "replace",
        }
    }

    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "" | "allow" => Ok(Self::Allow),
            "forbid" => Ok(Self::Forbid),
            "replace" => Ok(Self::Replace),
            other => Err(anyhow::anyhow!(
                "unknown concurrency policy '{other}' (expected allow | forbid | replace)"
            )),
        }
    }
}

/// What to do about firings that came due while nothing was running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissedPolicy {
    /// Forget them and resume from the next scheduled instant. Right for a
    /// sweep: yesterday's sweep is pointless once today's will run.
    Skip,
    /// Run once to catch up, then resume. Right for something whose result is
    /// a current snapshot — a catalogue refresh.
    CatchUp,
    /// Run each missed instant, up to `max_catch_up_runs`. Right only when
    /// each instant means something on its own.
    Backfill,
}

impl MissedPolicy {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::CatchUp => "catch_up",
            Self::Backfill => "backfill",
        }
    }

    pub fn parse(raw: &str) -> anyhow::Result<Self> {
        match raw.trim().to_lowercase().as_str() {
            "" | "skip" => Ok(Self::Skip),
            "catch_up" | "catchup" => Ok(Self::CatchUp),
            "backfill" => Ok(Self::Backfill),
            other => Err(anyhow::anyhow!(
                "unknown missed-schedule policy '{other}' (expected skip | catch_up | backfill)"
            )),
        }
    }
}

/// What one tick decided for one schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Firings {
    /// The instants to enqueue, oldest first. Empty means "nothing to run, but
    /// the schedule still moves on".
    pub scheduled_for: Vec<OffsetDateTime>,
    /// Where `next_run_at` goes.
    pub next_run_at: OffsetDateTime,
    /// How many due instants were dropped rather than enqueued, for the log —
    /// silently skipping a week of firings should be visible somewhere.
    pub dropped: usize,
}

/// Decide what a due schedule should enqueue.
///
/// `due_at` is the schedule's stored `next_run_at`; `now` is the tick. The
/// common case is one instant and no drops: the schedule came due a few seconds
/// ago and fires once.
///
/// The policy only governs the *extra* instants between `due_at` and `now` —
/// the ones nothing was running for. Every policy fires the instant that was
/// actually due, because a schedule that is due and does nothing is
/// indistinguishable from a broken one.
pub fn plan(
    expression: &Expression,
    due_at: OffsetDateTime,
    now: OffsetDateTime,
    policy: MissedPolicy,
    max_catch_up_runs: i16,
) -> anyhow::Result<Firings> {
    // Every instant from the one that was due up to now, capped so a long
    // outage cannot make one tick walk a year of minutes.
    const MAX_WALK: usize = 1000;
    let mut missed = vec![due_at];
    let mut cursor = due_at;
    while missed.len() < MAX_WALK {
        let next = expression.next_after(cursor, Some(cursor))?;
        if next > now {
            break;
        }
        missed.push(next);
        cursor = next;
    }

    // Where the schedule goes next: the first instant after now, measured from
    // the last instant we accounted for.
    let next_run_at = expression.next_after(now, Some(*missed.last().unwrap_or(&due_at)))?;

    let (scheduled_for, dropped) = match policy {
        MissedPolicy::Skip => {
            // Fire the instant that was due; forget anything older that piled
            // up behind it.
            let dropped = missed.len().saturating_sub(1);
            (vec![*missed.last().unwrap_or(&due_at)], dropped)
        }
        MissedPolicy::CatchUp => {
            // One run to catch up, whatever the backlog. The instant recorded
            // is the most recent missed one — a snapshot task should report
            // "now", not last Tuesday.
            let dropped = missed.len().saturating_sub(1);
            (vec![*missed.last().unwrap_or(&due_at)], dropped)
        }
        MissedPolicy::Backfill => {
            let cap = usize::try_from(max_catch_up_runs.max(1)).unwrap_or(1);
            if missed.len() <= cap {
                let all = missed.clone();
                (all, 0)
            } else {
                // Keep the most recent `cap`: if only some of a backlog can
                // run, the newest instants are the ones worth running.
                let dropped = missed.len() - cap;
                (missed[dropped..].to_vec(), dropped)
            }
        }
    };

    Ok(Firings {
        scheduled_for,
        next_run_at,
        dropped,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use time::{Date, Duration, Month};

    fn utc(y: i32, m: u8, d: u8, h: u8, min: u8) -> OffsetDateTime {
        Date::from_calendar_date(y, Month::try_from(m).unwrap(), d)
            .unwrap()
            .with_hms(h, min, 0)
            .unwrap()
            .assume_utc()
    }

    fn daily_3am() -> Expression {
        Expression::parse("cron", "0 3 * * *").unwrap()
    }

    #[test]
    fn a_schedule_that_is_merely_due_fires_once_under_every_policy() {
        let due = utc(2026, 9, 9, 3, 0);
        let now = utc(2026, 9, 9, 3, 0) + Duration::seconds(20);
        for policy in [
            MissedPolicy::Skip,
            MissedPolicy::CatchUp,
            MissedPolicy::Backfill,
        ] {
            let plan = plan(&daily_3am(), due, now, policy, 3).unwrap();
            assert_eq!(plan.scheduled_for, vec![due], "{policy:?}");
            assert_eq!(plan.dropped, 0, "{policy:?}");
            assert_eq!(plan.next_run_at, utc(2026, 9, 10, 3, 0), "{policy:?}");
        }
    }

    #[test]
    fn skip_runs_once_and_says_how_many_it_dropped() {
        // Due on the 5th; the process was down until the 9th. Four instants
        // piled up (5th..8th) plus the 9th.
        let plan = plan(
            &daily_3am(),
            utc(2026, 9, 5, 3, 0),
            utc(2026, 9, 9, 12, 0),
            MissedPolicy::Skip,
            3,
        )
        .unwrap();
        assert_eq!(plan.scheduled_for, vec![utc(2026, 9, 9, 3, 0)]);
        assert_eq!(plan.dropped, 4);
        assert_eq!(plan.next_run_at, utc(2026, 9, 10, 3, 0));
    }

    #[test]
    fn backfill_runs_each_missed_instant_up_to_its_cap() {
        let plan = plan(
            &daily_3am(),
            utc(2026, 9, 5, 3, 0),
            utc(2026, 9, 9, 12, 0),
            MissedPolicy::Backfill,
            3,
        )
        .unwrap();
        // Five instants were due (5th..9th); the cap keeps the newest three.
        assert_eq!(
            plan.scheduled_for,
            vec![
                utc(2026, 9, 7, 3, 0),
                utc(2026, 9, 8, 3, 0),
                utc(2026, 9, 9, 3, 0),
            ]
        );
        assert_eq!(plan.dropped, 2);
    }

    #[test]
    fn backfill_under_its_cap_runs_everything() {
        let plan = plan(
            &daily_3am(),
            utc(2026, 9, 8, 3, 0),
            utc(2026, 9, 9, 12, 0),
            MissedPolicy::Backfill,
            3,
        )
        .unwrap();
        assert_eq!(
            plan.scheduled_for,
            vec![utc(2026, 9, 8, 3, 0), utc(2026, 9, 9, 3, 0)]
        );
        assert_eq!(plan.dropped, 0);
    }

    #[test]
    fn catch_up_runs_the_newest_instant_not_the_oldest() {
        // The distinction matters: a catalogue refresh recorded as "the 5th"
        // would look like a stale result forever.
        let plan = plan(
            &daily_3am(),
            utc(2026, 9, 5, 3, 0),
            utc(2026, 9, 9, 12, 0),
            MissedPolicy::CatchUp,
            3,
        )
        .unwrap();
        assert_eq!(plan.scheduled_for, vec![utc(2026, 9, 9, 3, 0)]);
        assert_eq!(plan.dropped, 4);
    }

    #[test]
    fn an_interval_schedule_advances_from_the_instant_it_was_due() {
        let every_hour = Expression::parse("interval", "PT1H").unwrap();
        let plan = plan(
            &every_hour,
            utc(2026, 9, 9, 10, 0),
            utc(2026, 9, 9, 10, 0) + Duration::seconds(5),
            MissedPolicy::Skip,
            3,
        )
        .unwrap();
        assert_eq!(plan.scheduled_for, vec![utc(2026, 9, 9, 10, 0)]);
        // Not "now + 1h": the grid stays anchored to the schedule.
        assert_eq!(plan.next_run_at, utc(2026, 9, 9, 11, 0));
    }

    #[test]
    fn a_long_outage_does_not_walk_forever() {
        // A minutely schedule, down for a year: the walk is capped, and the
        // schedule still lands on a sane next instant rather than hanging.
        let minutely = Expression::parse("cron", "* * * * *").unwrap();
        let plan = plan(
            &minutely,
            utc(2025, 9, 9, 3, 0),
            utc(2026, 9, 9, 3, 0),
            MissedPolicy::Skip,
            3,
        )
        .unwrap();
        assert_eq!(plan.scheduled_for.len(), 1);
        assert!(plan.dropped > 0);
    }

    #[test]
    fn both_policies_round_trip_through_their_wire_form() {
        for c in [
            Concurrency::Allow,
            Concurrency::Forbid,
            Concurrency::Replace,
        ] {
            assert_eq!(Concurrency::parse(c.as_str()).unwrap(), c);
        }
        for m in [
            MissedPolicy::Skip,
            MissedPolicy::CatchUp,
            MissedPolicy::Backfill,
        ] {
            assert_eq!(MissedPolicy::parse(m.as_str()).unwrap(), m);
        }
        // The empty string is the documented default of each, so an absent
        // field in an API body does not become an error.
        assert_eq!(Concurrency::parse("").unwrap(), Concurrency::Allow);
        assert_eq!(MissedPolicy::parse("").unwrap(), MissedPolicy::Skip);
        assert!(Concurrency::parse("queue").is_err());
        assert!(MissedPolicy::parse("retry").is_err());
    }
}
