//! Schedule expressions: a 5-field cron, and an ISO-8601 interval.
//!
//! ## Why this is written here
//!
//! Adding a cron crate is one line of `Cargo.toml` and a lockfile change, and
//! this assembly is deliberate about both (see the note at the top of
//! `Cargo.toml`). A 5-field evaluator is a bounded, well-specified job that
//! fits in one testable file, and the tests below are worth more than the
//! dependency would be: the cases that actually break schedules are the awkward
//! ones — the day-of-month/day-of-week OR rule, February, the minute a
//! `*/n` step rolls over — and they are all pinned here.
//!
//! ## UTC only, on purpose, and said out loud
//!
//! A schedule carries an IANA `timezone` from the first version because it
//! belongs in the contract, but only `UTC` is accepted today: a correct local
//! schedule needs a tz database to know when a wall-clock hour repeats or does
//! not exist, and guessing there means a daily job that silently runs twice or
//! not at all on two days a year. So the field is validated rather than
//! ignored, and "09:00 in Europe/Belgrade" is refused with a message that says
//! why instead of quietly meaning 09:00 UTC.

use std::fmt::Write as _;

use time::{Duration, OffsetDateTime, Time};

/// How often a schedule fires.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Expression {
    /// Standard 5-field cron: minute, hour, day-of-month, month, day-of-week.
    Cron(Cron),
    /// A fixed gap, measured from the previous firing.
    Interval(Duration),
}

impl Expression {
    /// Parse the `{kind, value}` pair the API and the row carry.
    ///
    /// The shape is `serverless-runtime`'s (`gts.cf.core.sless.schedule.v1~`),
    /// so a schedule written today survives a move to that gear as data.
    pub fn parse(kind: &str, value: &str) -> anyhow::Result<Self> {
        match kind.trim().to_lowercase().as_str() {
            "cron" => Ok(Self::Cron(Cron::parse(value)?)),
            "interval" => Ok(Self::Interval(parse_iso8601_duration(value)?)),
            other => Err(anyhow::anyhow!(
                "unknown expression kind '{other}' (expected cron | interval)"
            )),
        }
    }

    /// The first firing strictly after `after`.
    ///
    /// `last_fired` is only consulted for an interval, which measures from the
    /// previous firing rather than from a wall-clock grid. Absent, an interval
    /// schedule fires one interval from now rather than immediately — creating
    /// a schedule should not be a way to trigger a job.
    pub fn next_after(
        &self,
        after: OffsetDateTime,
        last_fired: Option<OffsetDateTime>,
    ) -> anyhow::Result<OffsetDateTime> {
        match self {
            Self::Cron(cron) => cron.next_after(after),
            Self::Interval(every) => Ok(last_fired.unwrap_or(after) + *every),
        }
    }
}

/// A parsed 5-field cron expression. Each field is the set of values it allows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cron {
    minutes: Vec<u8>,
    hours: Vec<u8>,
    /// 1-31. Empty is impossible; `*` fills it.
    days_of_month: Vec<u8>,
    /// 1-12.
    months: Vec<u8>,
    /// 0-6, Sunday = 0.
    days_of_week: Vec<u8>,
    /// Whether the expression restricted day-of-month, and whether it
    /// restricted day-of-week. Cron's oddest rule needs both: when *both* are
    /// restricted the day matches if *either* does, not both.
    dom_restricted: bool,
    dow_restricted: bool,
}

impl Cron {
    pub fn parse(expression: &str) -> anyhow::Result<Self> {
        let fields: Vec<&str> = expression.split_whitespace().collect();
        if fields.len() != 5 {
            return Err(anyhow::anyhow!(
                "a cron expression has 5 fields — minute hour day-of-month month \
                 day-of-week — got {} in '{expression}'",
                fields.len()
            ));
        }
        Ok(Self {
            minutes: field(fields[0], 0, 59, "minute")?,
            hours: field(fields[1], 0, 23, "hour")?,
            days_of_month: field(fields[2], 1, 31, "day-of-month")?,
            months: field(fields[3], 1, 12, "month")?,
            days_of_week: field(fields[4], 0, 6, "day-of-week")?,
            dom_restricted: fields[2].trim() != "*",
            dow_restricted: fields[4].trim() != "*",
        })
    }

    /// Whether a date's day matches, applying cron's OR rule.
    fn day_matches(&self, day_of_month: u8, day_of_week: u8) -> bool {
        let dom = self.days_of_month.contains(&day_of_month);
        let dow = self.days_of_week.contains(&day_of_week);
        match (self.dom_restricted, self.dow_restricted) {
            // `0 3 13 * 5` fires on the 13th *and* on every Friday. This is the
            // rule people get wrong, and Vixie cron's behaviour is the standard.
            (true, true) => dom || dow,
            (true, false) => dom,
            (false, true) => dow,
            (false, false) => true,
        }
    }

    /// The first matching minute strictly after `after`.
    ///
    /// Walks minute by minute, skipping whole days when the date cannot match —
    /// so a yearly schedule costs a few hundred date comparisons, not half a
    /// million minute comparisons. Bounded at four years so a schedule that can
    /// never match (29 February in a cron restricted to non-leap months) is an
    /// error rather than a hang.
    pub fn next_after(&self, after: OffsetDateTime) -> anyhow::Result<OffsetDateTime> {
        // Start at the next whole minute: a schedule fires at :00 seconds, and
        // "strictly after" must not return the minute we are already in.
        let mut at = after
            .replace_second(0)?
            .replace_nanosecond(0)?
            .saturating_add(Duration::minutes(1));

        const MAX_DAYS: i64 = 366 * 4;
        let give_up = at + Duration::days(MAX_DAYS);
        while at <= give_up {
            let date = at.date();
            if !self.months.contains(&(u8::from(date.month())))
                || !self.day_matches(
                    date.day(),
                    // `time` counts Monday..Sunday as 0..6; cron wants
                    // Sunday = 0.
                    date.weekday().number_days_from_sunday(),
                )
            {
                // Nothing on this date can match: jump to its midnight + 1 day.
                at = at.replace_time(Time::MIDNIGHT) + Duration::days(1);
                continue;
            }
            if self.hours.contains(&at.hour()) && self.minutes.contains(&at.minute()) {
                return Ok(at);
            }
            at += Duration::minutes(1);
        }
        Err(anyhow::anyhow!(
            "this cron expression has no next firing within {} years — it can never match",
            MAX_DAYS / 366
        ))
    }
}

/// One cron field: `*`, `n`, `a-b`, `*/s`, `a-b/s`, or a comma-separated list
/// of those.
fn field(raw: &str, min: u8, max: u8, name: &str) -> anyhow::Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    for part in raw.trim().split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(anyhow::anyhow!("empty {name} field in a cron expression"));
        }
        let (range, step) = match part.split_once('/') {
            Some((range, step)) => {
                let step: u8 = step
                    .trim()
                    .parse()
                    .map_err(|_| anyhow::anyhow!("'{step}' is not a step for the {name} field"))?;
                if step == 0 {
                    return Err(anyhow::anyhow!(
                        "a step of 0 in the {name} field never fires"
                    ));
                }
                (range, step)
            }
            None => (part, 1),
        };
        let (from, to) = if range == "*" {
            (min, max)
        } else if let Some((from, to)) = range.split_once('-') {
            (
                parse_in(from, min, max, name)?,
                parse_in(to, min, max, name)?,
            )
        } else {
            let one = parse_in(range, min, max, name)?;
            // `5/15` means "from 5, every 15" — an open-ended step from a
            // single value, which is how cron reads it.
            if step == 1 { (one, one) } else { (one, max) }
        };
        if from > to {
            return Err(anyhow::anyhow!(
                "the {name} range {from}-{to} runs backwards"
            ));
        }
        let mut value = from;
        while value <= to {
            out.push(value);
            // `u8` and `to <= max <= 59`, so this cannot overflow before the
            // loop ends.
            value = value.saturating_add(step);
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

fn parse_in(raw: &str, min: u8, max: u8, name: &str) -> anyhow::Result<u8> {
    let value: u8 = raw
        .trim()
        .parse()
        .map_err(|_| anyhow::anyhow!("'{raw}' is not a number in the {name} field"))?;
    if value < min || value > max {
        return Err(anyhow::anyhow!(
            "{value} is outside {min}-{max} in the {name} field"
        ));
    }
    Ok(value)
}

/// The subset of ISO-8601 durations a schedule can express: days, hours,
/// minutes, seconds. `PT15M`, `PT1H`, `P1D`, `P1DT6H`.
///
/// Months and years are deliberately absent — they are not fixed lengths, so
/// "every month" is a cron expression, not an interval.
pub fn parse_iso8601_duration(raw: &str) -> anyhow::Result<Duration> {
    let text = raw.trim().to_uppercase();
    let rest = text.strip_prefix('P').ok_or_else(|| {
        anyhow::anyhow!("'{raw}' is not an ISO-8601 duration — it must start with P (e.g. PT15M)")
    })?;
    if rest.contains('Y')
        || rest.contains('M') && !rest.split('T').nth(1).is_some_and(|t| t.contains('M'))
    {
        return Err(anyhow::anyhow!(
            "'{raw}' uses months or years, which are not fixed lengths — express \
             that as a cron expression instead"
        ));
    }
    let (date_part, time_part) = match rest.split_once('T') {
        Some((d, t)) => (d, t),
        None => (rest, ""),
    };

    let mut total = Duration::ZERO;
    let mut seen_any = false;
    let mut number = String::new();
    for (part, units) in [(date_part, "DW"), (time_part, "HMS")] {
        for ch in part.chars() {
            if ch.is_ascii_digit() {
                number.push(ch);
                continue;
            }
            if !units.contains(ch) {
                return Err(anyhow::anyhow!("'{raw}' has an unexpected '{ch}'"));
            }
            let value: i64 = number
                .parse()
                .map_err(|_| anyhow::anyhow!("'{raw}' has a '{ch}' with no number before it"))?;
            number.clear();
            seen_any = true;
            total += match ch {
                'W' => Duration::weeks(value),
                'D' => Duration::days(value),
                'H' => Duration::hours(value),
                'M' => Duration::minutes(value),
                'S' => Duration::seconds(value),
                _ => unreachable!("units are filtered above"),
            };
        }
    }
    if !number.is_empty() {
        return Err(anyhow::anyhow!("'{raw}' ends with a number and no unit"));
    }
    if !seen_any {
        return Err(anyhow::anyhow!("'{raw}' names no duration at all"));
    }
    // A one-second schedule is a busy loop with extra steps, and the ticker
    // wakes on a coarser cadence anyway.
    if total < Duration::minutes(1) {
        return Err(anyhow::anyhow!(
            "'{raw}' is shorter than a minute; the shortest interval is PT1M"
        ));
    }
    Ok(total)
}

/// Render a duration back as an ISO-8601 string, for round-tripping a stored
/// interval into an API response.
pub fn format_iso8601_duration(d: Duration) -> String {
    let total = d.whole_seconds().max(0);
    let (days, rest) = (total / 86_400, total % 86_400);
    let (hours, rest) = (rest / 3_600, rest % 3_600);
    let (minutes, seconds) = (rest / 60, rest % 60);
    let mut out = String::from("P");
    if days > 0 {
        let _ = write!(out, "{days}D");
    }
    if hours > 0 || minutes > 0 || seconds > 0 {
        out.push('T');
        if hours > 0 {
            let _ = write!(out, "{hours}H");
        }
        if minutes > 0 {
            let _ = write!(out, "{minutes}M");
        }
        if seconds > 0 {
            let _ = write!(out, "{seconds}S");
        }
    }
    if out == "P" { "PT0S".to_owned() } else { out }
}

/// The only timezone this version evaluates. See the module note.
pub const SUPPORTED_TIMEZONE: &str = "UTC";

/// Validate a schedule's timezone.
pub fn check_timezone(tz: &str) -> anyhow::Result<()> {
    let tz = tz.trim();
    if tz.eq_ignore_ascii_case(SUPPORTED_TIMEZONE) || tz.eq_ignore_ascii_case("Etc/UTC") {
        return Ok(());
    }
    Err(anyhow::anyhow!(
        "timezone '{tz}' is not supported yet — schedules are evaluated in UTC. \
         A local schedule needs a tz database to handle the hours that repeat or \
         do not exist at a DST boundary, and quietly treating '{tz}' as UTC would \
         make a daily job run at the wrong time for half the year"
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use time::{Date, Month};

    /// A UTC instant, without pulling in `time`'s non-default `macros` feature.
    fn utc(y: i32, m: u8, d: u8, h: u8, min: u8, s: u8) -> OffsetDateTime {
        Date::from_calendar_date(y, Month::try_from(m).unwrap(), d)
            .unwrap()
            .with_hms(h, min, s)
            .unwrap()
            .assume_utc()
    }

    fn next(expression: &str, from: OffsetDateTime) -> OffsetDateTime {
        Cron::parse(expression).unwrap().next_after(from).unwrap()
    }

    #[test]
    fn every_minute_is_the_next_minute() {
        assert_eq!(
            next("* * * * *", utc(2026, 9, 9, 10, 15, 30)),
            utc(2026, 9, 9, 10, 16, 0)
        );
    }

    #[test]
    fn a_firing_is_strictly_after_the_instant_asked_about() {
        // Standing exactly on a firing must yield the *next* one, or a ticker
        // that runs at :00 would fire the same schedule forever.
        assert_eq!(
            next("0 3 * * *", utc(2026, 9, 9, 3, 0, 0)),
            utc(2026, 9, 10, 3, 0, 0)
        );
    }

    #[test]
    fn a_daily_schedule_crosses_midnight() {
        assert_eq!(
            next("0 3 * * *", utc(2026, 9, 9, 23, 59, 0)),
            utc(2026, 9, 10, 3, 0, 0)
        );
    }

    #[test]
    fn a_step_walks_the_field_and_rolls_over_the_hour() {
        assert_eq!(
            next("*/15 * * * *", utc(2026, 9, 9, 10, 46, 0)),
            utc(2026, 9, 9, 11, 0, 0)
        );
        assert_eq!(
            next("*/15 * * * *", utc(2026, 9, 9, 10, 0, 0)),
            utc(2026, 9, 9, 10, 15, 0)
        );
    }

    #[test]
    fn a_list_and_a_range_both_work() {
        assert_eq!(
            next("0 9,17 * * *", utc(2026, 9, 9, 10, 0, 0)),
            utc(2026, 9, 9, 17, 0, 0)
        );
        assert_eq!(
            next("30 8-10 * * *", utc(2026, 9, 9, 8, 31, 0)),
            utc(2026, 9, 9, 9, 30, 0)
        );
    }

    #[test]
    fn day_of_month_and_day_of_week_are_or_not_and() {
        // Vixie cron's rule, and the one everybody gets wrong: with both
        // restricted, either matching is enough. 2026-09-11 is a Friday, the
        // 13th is a Sunday.
        let cron = Cron::parse("0 3 13 * 5").unwrap();
        let from = utc(2026, 9, 9, 0, 0, 0); // Wednesday
        let first = cron.next_after(from).unwrap();
        assert_eq!(first, utc(2026, 9, 11, 3, 0, 0), "the Friday");
        let second = cron.next_after(first).unwrap();
        assert_eq!(second, utc(2026, 9, 13, 3, 0, 0), "the 13th");
    }

    #[test]
    fn a_restricted_day_of_week_alone_ignores_the_day_of_month() {
        // Monday.
        let at = next("0 0 * * 1", utc(2026, 9, 9, 12, 0, 0));
        assert_eq!(at, utc(2026, 9, 14, 0, 0, 0));
        assert_eq!(at.weekday().number_days_from_sunday(), 1);
    }

    #[test]
    fn a_monthly_schedule_skips_to_the_right_month() {
        let at = next("0 0 1 * *", utc(2026, 9, 9, 12, 0, 0));
        assert_eq!(at, utc(2026, 10, 1, 0, 0, 0));
    }

    #[test]
    fn the_29th_of_february_lands_on_a_leap_year() {
        // 2027 and 2028: only 2028 has a 29 February. A walker that gave up
        // after a year would report "never".
        let at = next("0 0 29 2 *", utc(2027, 3, 1, 0, 0, 0));
        assert_eq!(at.year(), 2028);
        assert_eq!(at.month(), Month::February);
        assert_eq!(at.day(), 29);
    }

    #[test]
    fn a_malformed_expression_says_what_is_wrong() {
        for (expression, expected) in [
            ("* * * *", "5 fields"),
            ("60 * * * *", "outside 0-59"),
            ("* 24 * * *", "outside 0-23"),
            ("* * 0 * *", "outside 1-31"),
            ("* * * 13 *", "outside 1-12"),
            ("* * * * 7", "outside 0-6"),
            ("*/0 * * * *", "step of 0"),
            ("30-10 * * * *", "backwards"),
            ("x * * * *", "not a number"),
        ] {
            let err = Cron::parse(expression).unwrap_err().to_string();
            assert!(err.contains(expected), "'{expression}' said: {err}");
        }
    }

    #[test]
    fn intervals_parse_the_shapes_a_person_writes() {
        assert_eq!(
            parse_iso8601_duration("PT15M").unwrap(),
            Duration::minutes(15)
        );
        assert_eq!(parse_iso8601_duration("PT1H").unwrap(), Duration::hours(1));
        assert_eq!(parse_iso8601_duration("P1D").unwrap(), Duration::days(1));
        assert_eq!(
            parse_iso8601_duration("P1DT6H30M").unwrap(),
            Duration::days(1) + Duration::hours(6) + Duration::minutes(30)
        );
        assert_eq!(
            parse_iso8601_duration("pt30m").unwrap(),
            Duration::minutes(30)
        );
    }

    #[test]
    fn intervals_refuse_what_they_cannot_mean() {
        for (raw, expected) in [
            ("15M", "must start with P"),
            ("P1M", "months or years"),
            ("P1Y", "months or years"),
            ("PT30S", "shorter than a minute"),
            ("P", "names no duration"),
            ("PT1", "no unit"),
            ("PT1X", "unexpected"),
        ] {
            let err = parse_iso8601_duration(raw).unwrap_err().to_string();
            assert!(err.contains(expected), "'{raw}' said: {err}");
        }
    }

    #[test]
    fn an_interval_round_trips_through_its_text_form() {
        for raw in ["PT1M", "PT15M", "PT1H", "P1D", "P1DT6H30M"] {
            let parsed = parse_iso8601_duration(raw).unwrap();
            assert_eq!(
                parse_iso8601_duration(&format_iso8601_duration(parsed)).unwrap(),
                parsed,
                "{raw}"
            );
        }
    }

    #[test]
    fn an_interval_measures_from_the_last_firing_not_the_clock() {
        let every = Expression::parse("interval", "PT1H").unwrap();
        let last = utc(2026, 9, 9, 10, 0, 0);
        let now = utc(2026, 9, 9, 10, 45, 0);
        // Not now + 1h: the schedule is due at 11:00, 45 minutes from now.
        assert_eq!(
            every.next_after(now, Some(last)).unwrap(),
            utc(2026, 9, 9, 11, 0, 0)
        );
    }

    #[test]
    fn a_new_interval_schedule_does_not_fire_immediately() {
        let every = Expression::parse("interval", "PT1H").unwrap();
        let now = utc(2026, 9, 9, 10, 45, 0);
        assert_eq!(
            every.next_after(now, None).unwrap(),
            utc(2026, 9, 9, 11, 45, 0)
        );
    }

    #[test]
    fn only_utc_is_accepted_and_the_refusal_explains_itself() {
        assert!(check_timezone("UTC").is_ok());
        assert!(check_timezone("utc").is_ok());
        assert!(check_timezone("Etc/UTC").is_ok());
        let err = check_timezone("Europe/Belgrade").unwrap_err().to_string();
        assert!(err.contains("evaluated in UTC"), "{err}");
        assert!(err.contains("DST"), "{err}");
    }
}
