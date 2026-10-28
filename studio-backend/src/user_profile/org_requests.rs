//! A person asking to own an organization that does not exist yet (ADR-0051).
//!
//! The installation decides whether a person may create an organization at
//! once, ask for one, or neither (`studio-organizations.self_service`). This is
//! the middle case: the request is a record here, beside invitations — the same
//! kind of thing in the other direction — and a platform administrator's
//! decision either rejects it or turns it into an organization the requester
//! owns.
//!
//! No IO here, so the rules are stated as tests — the same shape as
//! `invitations` and `alias_policy`.

use uuid::Uuid;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_WITHDRAWN: &str = "withdrawn";

/// Every status a request can be in, for a filter that names one.
pub const STATUSES: [&str; 4] = [
    STATUS_PENDING,
    STATUS_APPROVED,
    STATUS_REJECTED,
    STATUS_WITHDRAWN,
];

/// Longest note accepted. The note is read by one administrator deciding one
/// request; anything longer is not a note.
pub const MAX_NOTE_LEN: usize = 2000;

/// Longest rejection reason accepted.
pub const MAX_REASON_LEN: usize = 2000;

/// One request, as every gear sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrganizationRequest {
    /// Also the id the organization gets when the request is approved, so an
    /// approval repeated after a partial failure finishes the same one.
    pub id: Uuid,
    /// The person who asked (ADR-0025), not a login.
    pub requested_by: String,
    pub name: String,
    pub note: String,
    pub status: String,
    /// The platform administrator who decided, or the requester who withdrew.
    pub decided_by: Option<String>,
    pub decided_at_ms: Option<i64>,
    pub reason: Option<String>,
    pub organization_id: Option<Uuid>,
    pub created_at_ms: i64,
    /// Who asked, as their profile names them — for the administrator
    /// deciding. Filled on read, never stored: a request must not freeze an
    /// old name.
    pub requester_name: Option<String>,
    /// An address the identity provider verified for the requester, if any.
    pub requester_email: Option<String>,
}

/// Why a request cannot be filed, withdrawn or decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequestRefusal {
    /// No such request — also the answer for somebody else's, so a person
    /// cannot learn which ids exist.
    NotFound,
    /// The person already has a pending request; this is its id.
    AlreadyPending(Uuid),
    /// The request was already decided or withdrawn; this is its status.
    NotPending(String),
}

impl RequestRefusal {
    #[must_use]
    pub fn message(&self) -> String {
        match self {
            Self::NotFound => "that organization request does not exist".to_owned(),
            Self::AlreadyPending(id) => format!(
                "you already have a pending organization request ({id}); withdraw it or wait for \
                 its decision"
            ),
            Self::NotPending(status) => {
                format!("that organization request is {status}, not pending")
            }
        }
    }
}

/// Trim a note and refuse one too long to be a note. Empty is fine.
pub fn clean_note(raw: &str) -> Result<String, String> {
    let note = raw.trim();
    if note.chars().count() > MAX_NOTE_LEN {
        return Err(format!("a note must be at most {MAX_NOTE_LEN} characters"));
    }
    Ok(note.to_owned())
}

/// Trim a rejection reason and refuse one too long. Empty reads as none.
pub fn clean_reason(raw: Option<&str>) -> Result<Option<String>, String> {
    let Some(reason) = raw.map(str::trim).filter(|r| !r.is_empty()) else {
        return Ok(None);
    };
    if reason.chars().count() > MAX_REASON_LEN {
        return Err(format!(
            "a reason must be at most {MAX_REASON_LEN} characters"
        ));
    }
    Ok(Some(reason.to_owned()))
}

/// May this request be approved as `org_id`?
///
/// `Ok(true)` means do the work; `Ok(false)` means it is already done — the
/// request was approved as this very organization, and repeating the approval
/// is how a caller finishes one that failed half-way, or learns that it did
/// not.
pub fn may_approve(request: &OrganizationRequest, org_id: Uuid) -> Result<bool, RequestRefusal> {
    match request.status.as_str() {
        STATUS_PENDING => Ok(true),
        STATUS_APPROVED if request.organization_id == Some(org_id) => Ok(false),
        other => Err(RequestRefusal::NotPending(other.to_owned())),
    }
}

/// May this request be rejected or withdrawn? Only while pending.
pub fn may_close(request: &OrganizationRequest) -> Result<(), RequestRefusal> {
    if request.status == STATUS_PENDING {
        Ok(())
    } else {
        Err(RequestRefusal::NotPending(request.status.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(status: &str, organization_id: Option<Uuid>) -> OrganizationRequest {
        OrganizationRequest {
            id: Uuid::from_u128(7),
            requested_by: Uuid::from_u128(9).to_string(),
            name: "Acme".to_owned(),
            note: String::new(),
            status: status.to_owned(),
            decided_by: None,
            decided_at_ms: None,
            reason: None,
            organization_id,
            created_at_ms: 1,
            requester_name: None,
            requester_email: None,
        }
    }

    #[test]
    fn a_pending_request_may_be_approved() {
        assert_eq!(
            may_approve(&request(STATUS_PENDING, None), Uuid::from_u128(7)),
            Ok(true)
        );
    }

    #[test]
    fn approving_again_as_the_same_organization_is_a_no_op_not_a_refusal() {
        let id = Uuid::from_u128(7);
        assert_eq!(
            may_approve(&request(STATUS_APPROVED, Some(id)), id),
            Ok(false)
        );
    }

    #[test]
    fn an_approved_request_cannot_become_a_second_organization() {
        let approved = request(STATUS_APPROVED, Some(Uuid::from_u128(7)));
        assert_eq!(
            may_approve(&approved, Uuid::from_u128(8)),
            Err(RequestRefusal::NotPending(STATUS_APPROVED.to_owned()))
        );
    }

    #[test]
    fn a_closed_request_is_neither_approved_nor_closed_again() {
        for status in [STATUS_REJECTED, STATUS_WITHDRAWN] {
            let closed = request(status, None);
            assert!(may_approve(&closed, Uuid::from_u128(7)).is_err());
            assert!(may_close(&closed).is_err());
        }
        assert!(may_close(&request(STATUS_APPROVED, Some(Uuid::from_u128(7)))).is_err());
        assert!(may_close(&request(STATUS_PENDING, None)).is_ok());
    }

    #[test]
    fn a_note_may_be_empty_and_not_endless() {
        assert_eq!(clean_note("  hi  ").as_deref(), Ok("hi"));
        assert_eq!(clean_note("").as_deref(), Ok(""));
        assert!(clean_note(&"я".repeat(MAX_NOTE_LEN)).is_ok());
        assert!(clean_note(&"a".repeat(MAX_NOTE_LEN + 1)).is_err());
    }

    #[test]
    fn a_blank_reason_is_no_reason() {
        assert_eq!(clean_reason(None), Ok(None));
        assert_eq!(clean_reason(Some("   ")), Ok(None));
        assert_eq!(clean_reason(Some(" spam ")), Ok(Some("spam".to_owned())));
        assert!(clean_reason(Some(&"a".repeat(MAX_REASON_LEN + 1))).is_err());
    }
}
