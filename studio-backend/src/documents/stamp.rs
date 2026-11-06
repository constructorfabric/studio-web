//! Dates as this gear's rows carry them into the domain model.
//!
//! RFC 3339 in UTC with all nine fractional digits, always: the domain query
//! orders strings by code point, and `…:05Z` against `…:05.5Z` sorts the
//! wrong way round unless every stamp has the same width. Reading takes any
//! RFC 3339.

use serde::{Deserialize, Deserializer, Serializer, de};
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

pub fn format(t: OffsetDateTime) -> String {
    let u = t.to_offset(UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:09}Z",
        u.year(),
        u8::from(u.month()),
        u.day(),
        u.hour(),
        u.minute(),
        u.second(),
        u.nanosecond()
    )
}

pub fn serialize<S: Serializer>(t: &OffsetDateTime, s: S) -> Result<S::Ok, S::Error> {
    s.serialize_str(&format(*t))
}

pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<OffsetDateTime, D::Error> {
    let s = String::deserialize(d)?;
    OffsetDateTime::parse(&s, &Rfc3339).map_err(de::Error::custom)
}

pub mod option {
    use super::{Deserialize, Deserializer, OffsetDateTime, Rfc3339, Serializer, de};

    #[allow(clippy::ref_option)]
    pub fn serialize<S: Serializer>(t: &Option<OffsetDateTime>, s: S) -> Result<S::Ok, S::Error> {
        match t {
            Some(t) => s.serialize_some(&super::format(*t)),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<OffsetDateTime>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|s| OffsetDateTime::parse(&s, &Rfc3339).map_err(de::Error::custom))
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use time::{OffsetDateTime, UtcOffset};

    #[test]
    fn every_stamp_has_the_same_width_so_strings_sort_as_times() {
        let at = |nanos: i128| OffsetDateTime::from_unix_timestamp_nanos(nanos).unwrap();
        let whole = super::format(at(1_793_029_085_000_000_000));
        let half = super::format(at(1_793_029_085_500_000_000));
        assert_eq!(whole.len(), half.len());
        assert!(whole.ends_with(".000000000Z"), "{whole}");
        assert!(whole < half);
        let east = at(1_793_029_085_000_000_000).to_offset(UtcOffset::from_hms(3, 0, 0).unwrap());
        assert_eq!(super::format(east), whole);
    }
}
