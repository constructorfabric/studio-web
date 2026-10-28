//! How a person without an organization comes by one (ADR-0018 §4, ADR-0051 §2).
//!
//! Three answers, one setting: create one at once, ask for one and wait for a
//! platform administrator's decision, or neither. The setting used to be a
//! boolean, and `true`/`false` keep meaning `open`/`off` so no installation's
//! configuration changes meaning.

use serde::{Deserialize, Deserializer};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Creation {
    /// Create one and own it at once. A cloud with billing; local and desktop.
    #[default]
    Open,
    /// Ask for one; a platform administrator approves the organization, and
    /// the requester owns it (ADR-0051).
    Request,
    /// Neither: people are joined on first login or invited.
    Off,
}

impl Creation {
    /// The value `capabilities` reports.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Request => "request",
            Self::Off => "off",
        }
    }
}

impl<'de> Deserialize<'de> for Creation {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Flag(bool),
            Word(String),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Flag(true) => Ok(Self::Open),
            Raw::Flag(false) => Ok(Self::Off),
            Raw::Word(word) => match word.trim().to_ascii_lowercase().as_str() {
                // A config file interpolated from the environment hands a
                // boolean over as a string.
                "open" | "true" => Ok(Self::Open),
                "request" => Ok(Self::Request),
                "off" | "false" => Ok(Self::Off),
                other => Err(serde::de::Error::custom(format!(
                    "self_service must be open, request or off, not `{other}`"
                ))),
            },
        }
    }
}

/// Whether a person who already owns `owned` organizations they made may make
/// another, under the installation's `max_owned`. No limit when unset.
#[must_use]
pub fn within_limit(owned: usize, max_owned: Option<usize>) -> bool {
    max_owned.is_none_or(|max| owned < max)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(yaml: &str) -> Result<Creation, serde_json::Error> {
        serde_json::from_str(yaml)
    }

    #[test]
    fn the_old_booleans_keep_their_meaning() {
        assert_eq!(parse("true").expect("parses"), Creation::Open);
        assert_eq!(parse("false").expect("parses"), Creation::Off);
        assert_eq!(parse("\"true\"").expect("parses"), Creation::Open);
        assert_eq!(parse("\"false\"").expect("parses"), Creation::Off);
    }

    #[test]
    fn the_three_words_parse_in_any_case() {
        assert_eq!(parse("\"open\"").expect("parses"), Creation::Open);
        assert_eq!(parse("\"Request\"").expect("parses"), Creation::Request);
        assert_eq!(parse("\" off \"").expect("parses"), Creation::Off);
    }

    #[test]
    fn a_mistyped_mode_is_refused_rather_than_guessed() {
        assert!(parse("\"requests\"").is_err());
        assert!(parse("\"\"").is_err());
    }

    #[test]
    fn the_default_is_open_as_it_always_was() {
        assert_eq!(Creation::default(), Creation::Open);
    }

    #[test]
    fn the_limit_counts_what_a_person_already_owns() {
        assert!(within_limit(0, Some(1)));
        assert!(!within_limit(1, Some(1)));
        assert!(within_limit(5, None));
        assert!(!within_limit(0, Some(0)));
    }
}
