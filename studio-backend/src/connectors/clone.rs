//! The clone channel: a real working copy of the repository on disk.
//!
//! Unlike the tree-API channel (metadata only), this shells out to `git` to
//! clone the repository into a mounted volume, then walks the checkout from
//! disk so File nodes carry the actual file list — and, for text files, their
//! content. The clone is shallow (`--depth 1`, single branch) and idempotent:
//! a repo already on disk is fast-forwarded rather than re-cloned.
//!
//! Credentials never touch the clone URL, the process arguments, or any log
//! line — the token is handed to `git` through a one-shot credential helper
//! that reads it from an environment variable, so a failing clone can print the
//! remote URL without leaking the PAT.

use std::path::{Path, PathBuf};
use std::process::Command;

/// Backstop on files walked per clone, matched to the tree-API cap.
const MAX_FILES: usize = 10_000;
// No ceiling on a file's size, and none on a walk's text. There used to be
// both (256 KiB a file, 24 MiB a walk, from when the graph store lived in
// memory), and a document over either was walked without its text, which the
// classifier skips: a 343 KB architecture note on Insight sat in "not scanned"
// for good. What keeps a walk's text small now is the caller saying which files
// it reads at all (see [`walk`]), not a size a document can outgrow.

/// One file discovered in the checkout.
#[derive(Debug, Clone)]
pub struct WalkedFile {
    /// Repo-relative POSIX path, e.g. `src/main.rs`.
    pub path: String,
    /// Size in bytes on disk.
    pub size: u64,
    /// The content of a text file the walk was asked to read; `None` for a
    /// binary, a file it was not asked about, or one it could not read. Bytes
    /// that are not UTF-8 are replaced rather than costing the whole file.
    pub text: Option<String>,
}

/// What a walk of a checkout found, and whether that is every file in it.
///
/// `complete` is false when the walk stopped at [`MAX_FILES`] or could not
/// read a directory or an entry on the way. A sync forgets the files a
/// repository no longer has by comparing against this list, and a directory
/// the walk could not open looks, in the list, exactly like a directory
/// somebody deleted — so the caller must know which one it has before it
/// forgets anything.
#[derive(Debug, Clone, Default)]
pub struct Walk {
    pub files: Vec<WalkedFile>,
    pub complete: bool,
}

/// The result of a clone/update: where the checkout lives and its HEAD commit.
#[derive(Debug, Clone)]
pub struct CloneResult {
    pub dir: PathBuf,
    pub commit: Option<String>,
}

/// Extensions we read as text. Everything else is treated as binary (metadata
/// only). Deliberately conservative — prose specs, config and source.
const TEXT_EXT: &[&str] = &[
    "md",
    "markdown",
    "txt",
    "rst",
    "adoc",
    "org",
    "rs",
    "ts",
    "tsx",
    "js",
    "jsx",
    "mjs",
    "cjs",
    "py",
    "go",
    "java",
    "kt",
    "kts",
    "rb",
    "php",
    "cs",
    "c",
    "h",
    "cpp",
    "hpp",
    "cc",
    "scala",
    "swift",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "sql",
    "html",
    "htm",
    "css",
    "scss",
    "less",
    "json",
    "jsonc",
    // Studio's own comment logs are `.jsonl` (comment-log.js), and the sync
    // counts the threads in them (`comment_threads.rs`). Without this the file
    // is walked but never read, so every document's conversation reads as
    // empty — the count would be wrong, and wrong in the direction nobody
    // checks.
    "jsonl",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "env",
    "properties",
    "xml",
    "csv",
    "tsv",
    "graphql",
    "proto",
    "dockerfile",
    "makefile",
    "gradle",
    "tf",
    "hcl",
    "lua",
    "r",
    "jl",
    "vue",
    "svelte",
    "astro",
    "gitignore",
    "editorconfig",
];

fn is_text_path(path: &Path) -> bool {
    // Match by extension, or by well-known extension-less filenames.
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let ext = ext.to_ascii_lowercase();
        return TEXT_EXT.contains(&ext.as_str());
    }
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        let name = name.to_ascii_lowercase();
        return matches!(
            name.as_str(),
            "dockerfile" | "makefile" | "readme" | "license" | "notice" | "changelog"
        );
    }
    false
}

/// A filesystem-safe directory name for one connection+repo pair, so two
/// connections to the same host stay on separate checkouts.
pub fn checkout_key(connector_id: &str, repo_full_path: &str) -> String {
    let sanitize = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    };
    format!("{}__{}", sanitize(connector_id), sanitize(repo_full_path))
}

/// Build a `git` command pre-seeded with a credential helper that supplies the
/// token from `$STUDIO_GIT_TOKEN` (kept out of argv and the URL).
fn git(username: &str, token: &str) -> Command {
    let mut cmd = Command::new("git");
    // Never block on an interactive credential/prompt in a headless clone.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    cmd.env("STUDIO_GIT_TOKEN", token);
    // Reset any inherited helpers, then install ours. The username is not
    // secret; the password is read from the env var by the helper's shell.
    cmd.arg("-c").arg("credential.helper=");
    cmd.arg("-c").arg(format!(
        "credential.helper=!f() {{ echo username={username}; echo password=$STUDIO_GIT_TOKEN; }}; f"
    ));
    cmd
}

fn run(mut cmd: Command, what: &str) -> anyhow::Result<()> {
    let out = cmd
        .output()
        .map_err(|e| anyhow::anyhow!("failed to run git ({what}): {e} — is git installed?"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        anyhow::bail!(
            "git {what} failed ({}): {}",
            out.status,
            stderr.trim().chars().take(400).collect::<String>()
        );
    }
    Ok(())
}

/// Clone (or fast-forward an existing checkout of) one repository into
/// `work_root`, shallow and single-branch. Blocking — call under
/// `spawn_blocking`.
pub fn clone_or_update(
    work_root: &Path,
    connector_id: &str,
    repo_full_path: &str,
    clone_url: &str,
    username: &str,
    token: &str,
    git_ref: Option<&str>,
) -> anyhow::Result<CloneResult> {
    std::fs::create_dir_all(work_root)
        .map_err(|e| anyhow::anyhow!("cannot create clone root {}: {e}", work_root.display()))?;
    let dir = work_root.join(checkout_key(connector_id, repo_full_path));

    if dir.join(".git").is_dir() {
        // Existing checkout: fetch the tip shallowly and hard-reset onto it, so
        // a re-sync reflects the latest commit without accumulating history.
        let mut fetch = git(username, token);
        fetch
            .arg("-C")
            .arg(&dir)
            .arg("fetch")
            .arg("--depth")
            .arg("1")
            .arg("origin");
        if let Some(b) = git_ref {
            fetch.arg(b);
        }
        run(fetch, "fetch")?;

        let mut reset = git(username, token);
        reset
            .arg("-C")
            .arg(&dir)
            .arg("reset")
            .arg("--hard")
            .arg("FETCH_HEAD");
        run(reset, "reset")?;
    } else {
        let mut clone = git(username, token);
        clone
            .arg("clone")
            .arg("--depth")
            .arg("1")
            .arg("--single-branch");
        if let Some(b) = git_ref {
            clone.arg("--branch").arg(b);
        }
        clone.arg(clone_url).arg(&dir);
        run(clone, "clone")?;
    }

    // Capture the checked-out commit for snapshot ids on the file nodes.
    let commit = git(username, token)
        .arg("-C")
        .arg(&dir)
        .arg("rev-parse")
        .arg("HEAD")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty());

    Ok(CloneResult { dir, commit })
}

/// What a Re-sync did to the shared checkout before reading it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckoutUpdate {
    /// Already at the remote's tip, or it tracks no branch of `origin`.
    Current,
    /// Fast-forwarded from one commit to the other.
    Advanced { from: String, to: String },
    /// Left where it is -- local edits, or history the remote does not have --
    /// and read as it stands. The reason is for the sync's report.
    Kept { reason: String },
}

/// A read-only git question about the checkout, answered or `None`.
fn local(checkout: &Path, args: &[&str]) -> Option<String> {
    Command::new("git")
        .arg("-c")
        .arg(format!("safe.directory={}", checkout.display()))
        .arg("-C")
        .arg(checkout)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
}

/// The branch of `origin` the checkout tracks: its upstream, else the
/// remote's default branch. `None` when it tracks nothing, and the checkout is
/// then read as it stands.
fn tracked_branch(checkout: &Path) -> Option<String> {
    let full = local(
        checkout,
        &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    )
    .or_else(|| {
        local(
            checkout,
            &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        )
    })?;
    full.strip_prefix("origin/").map(str::to_string)
}

/// **Re-sync pulls the project's checkout up to the remote, then reads it.**
///
/// The shared checkout is the one the IDE works in, cloned when a session
/// first opened. Nothing advanced it but a person pulling in the IDE, so a sync
/// that only walked it kept reporting the repository as it was that day: a
/// merged PR's documents never arrived, however often Re-sync was pressed.
///
/// So the tracked branch is fetched and the checkout fast-forwarded -- what a
/// pull does, and only when a pull would lose nothing: a clean working tree
/// whose history the remote extends. Local edits or diverged history leave it
/// alone (`Kept`); the sync reads it as it stands and says why, rather than
/// overwriting somebody's work.
pub fn update_shared_checkout(
    checkout: &Path,
    username: &str,
    token: &str,
) -> anyhow::Result<CheckoutUpdate> {
    let Some(branch) = tracked_branch(checkout) else {
        return Ok(CheckoutUpdate::Current);
    };
    let safe = format!("safe.directory={}", checkout.display());
    let mut fetch = git(username, token);
    fetch
        .arg("-c")
        .arg(&safe)
        .arg("-C")
        .arg(checkout)
        .args(["fetch", "--quiet", "origin"])
        .arg(format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"));
    run(fetch, "fetch")?;

    let head = local(checkout, &["rev-parse", "HEAD"]);
    let remote = local(checkout, &["rev-parse", &format!("origin/{branch}")]);
    let (Some(head), Some(remote)) = (head, remote) else {
        return Ok(CheckoutUpdate::Current);
    };
    if head == remote {
        return Ok(CheckoutUpdate::Current);
    }
    if local(checkout, &["status", "--porcelain"]).is_some_and(|s| !s.is_empty()) {
        return Ok(CheckoutUpdate::Kept {
            reason: format!(
                "the checkout has local changes; origin/{branch} is ahead and was not merged"
            ),
        });
    }
    let fast_forward = Command::new("git")
        .arg("-c")
        .arg(&safe)
        .arg("-C")
        .arg(checkout)
        .args(["merge-base", "--is-ancestor", &head, &remote])
        .status()
        .is_ok_and(|s| s.success());
    if !fast_forward {
        return Ok(CheckoutUpdate::Kept {
            reason: format!("the checkout has commits origin/{branch} does not; it was not moved"),
        });
    }
    let mut merge = Command::new("git");
    merge
        .arg("-c")
        .arg(&safe)
        .arg("-C")
        .arg(checkout)
        .args(["merge", "--ff-only", "--quiet"])
        .arg(format!("origin/{branch}"));
    run(merge, "fast-forward")?;
    Ok(CheckoutUpdate::Advanced {
        from: head,
        to: remote,
    })
}

/// The HEAD commit of a checkout already on disk (no credentials needed —
/// a local `rev-parse`). `None` if git is unavailable or the dir is not a repo.
pub fn head_commit(dir: &Path) -> Option<String> {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .arg("rev-parse")
        .arg("HEAD")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Walk a checkout depth-first, skipping `.git` and symlinks, reading the
/// content of the text files `read_text` names by their repo-relative path.
/// Blocking — call under `spawn_blocking`.
///
/// Every file is listed; only the text is chosen. A sync reads what it
/// classifies and counts (documents and comment logs) and lists the rest by
/// path, so a repository of source never sits in memory whole.
///
/// Unreadable directories and entries are still skipped rather than failing
/// the walk — one of them must not cost a sync every other file — but the walk
/// says that it skipped something (see [`Walk::complete`]).
pub fn walk(dir: &Path, read_text: &dyn Fn(&str) -> bool) -> anyhow::Result<Walk> {
    let mut out: Vec<WalkedFile> = Vec::new();
    let mut complete = true;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for entry in entries {
            let Ok(entry) = entry else {
                complete = false;
                continue;
            };
            if out.len() >= MAX_FILES {
                // There is at least one more entry, so the cap cut the walk
                // short rather than landing exactly on the repository's size.
                return Ok(Walk {
                    files: out,
                    complete: false,
                });
            }
            let path = entry.path();
            // Skip symlinks entirely — don't follow them or record them.
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    complete = false;
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                if path.file_name().and_then(|n| n.to_str()) == Some(".git") {
                    continue;
                }
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }

            let rel = path.strip_prefix(dir).unwrap_or(&path);
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            let size = meta.len();

            let text = (is_text_path(&path) && read_text(&rel_str))
                .then(|| std::fs::read(&path).ok().map(utf8))
                .flatten();
            out.push(WalkedFile {
                path: rel_str,
                size,
                text,
            });
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(Walk {
        files: out,
        complete,
    })
}

/// Text as a reader wants it: the file's own when it is UTF-8, and with the
/// stray bytes replaced when it is not.
fn utf8(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

/// One file of a checkout, as [`walk`] would have read it: `None` unless it is
/// a regular text file outside `.git`, reached without a symlink.
///
/// `rel` is repo-relative with `/` separators. A path that is absolute, empty
/// in a segment or climbs with `..` reads nothing rather than leaving `dir`.
pub fn read_text_file(dir: &Path, rel: &str) -> Option<String> {
    let segments: Vec<&str> = rel.split('/').collect();
    if rel.starts_with('/')
        || segments
            .iter()
            .any(|seg| seg.is_empty() || *seg == "." || *seg == ".." || seg.contains('\\'))
        || segments.contains(&".git")
    {
        return None;
    }

    // Every step is checked, not only the file: `walk` never descends a
    // symlinked directory, so a file below one is not in the checkout.
    let mut path = dir.to_path_buf();
    for seg in &segments {
        path.push(seg);
        if std::fs::symlink_metadata(&path)
            .ok()?
            .file_type()
            .is_symlink()
        {
            return None;
        }
    }
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || !is_text_path(&path) {
        return None;
    }
    std::fs::read(&path).ok().map(utf8)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sync counts a document's comment threads by reading the logs the IDE
    /// writes beside it, and it can only read what the walk read.
    ///
    /// This is here rather than in `comment_threads.rs` because the dependency
    /// runs the other way: that module is correct whatever this list says, and
    /// silently useless if `jsonl` leaves it. A reader trimming the extension
    /// list has no reason to suspect the connection, which is what a test is
    /// for.
    #[test]
    fn a_comment_log_is_read_as_text() {
        assert!(is_text_path(Path::new(
            ".studio/comments/docs/prd.md/oidc-sub-1.jsonl"
        )));
        assert!(is_text_path(Path::new(".studio/comments/docs/prd.md.json")));
    }

    fn sh(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "-c",
                "init.defaultBranch=main",
            ])
            .args(args)
            .output()
            .expect("git runs");
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_pair(root: &Path) -> (PathBuf, PathBuf) {
        let (bare, seed, ide) = (root.join("origin.git"), root.join("seed"), root.join("ide"));
        std::fs::create_dir_all(root).expect("root");
        sh(root, &["init", "--quiet", "--bare", "origin.git"]);
        sh(
            root,
            &["clone", "--quiet", bare.to_str().expect("path"), "seed"],
        );
        std::fs::write(seed.join("README.md"), "one\n").expect("write");
        sh(&seed, &["add", "."]);
        sh(&seed, &["commit", "--quiet", "-m", "one"]);
        sh(&seed, &["push", "--quiet", "origin", "HEAD:main"]);
        sh(
            root,
            &["clone", "--quiet", bare.to_str().expect("path"), "ide"],
        );
        (seed, ide)
    }

    fn push_prd(seed: &Path) {
        std::fs::create_dir_all(seed.join("docs/prd")).expect("dir");
        std::fs::write(seed.join("docs/prd/p.md"), "---\ntype: prd\n---\n").expect("write");
        sh(seed, &["add", "."]);
        sh(seed, &["commit", "--quiet", "-m", "two"]);
        sh(seed, &["push", "--quiet", "origin", "HEAD:main"]);
    }

    /// A merged PR reaches the project's checkout on Re-sync, the way a pull
    /// would bring it.
    #[test]
    fn re_sync_fast_forwards_a_clean_checkout() {
        let root = std::env::temp_dir().join(format!("resync-{}", uuid::Uuid::new_v4()));
        let (seed, ide) = init_pair(&root);
        assert_eq!(
            update_shared_checkout(&ide, "", "").expect("update"),
            CheckoutUpdate::Current
        );
        push_prd(&seed);
        assert!(matches!(
            update_shared_checkout(&ide, "", "").expect("update"),
            CheckoutUpdate::Advanced { .. }
        ));
        assert!(ide.join("docs/prd/p.md").is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Somebody's unsaved work is never overwritten to get there.
    #[test]
    fn re_sync_leaves_a_checkout_with_local_changes_alone() {
        let root = std::env::temp_dir().join(format!("resync-{}", uuid::Uuid::new_v4()));
        let (seed, ide) = init_pair(&root);
        push_prd(&seed);
        std::fs::write(ide.join("README.md"), "edited in the IDE\n").expect("write");
        assert!(matches!(
            update_shared_checkout(&ide, "", "").expect("update"),
            CheckoutUpdate::Kept { .. }
        ));
        assert!(!ide.join("docs/prd/p.md").exists());
        assert_eq!(
            std::fs::read_to_string(ide.join("README.md")).expect("read"),
            "edited in the IDE\n"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A checkout the walk read end to end is a complete listing: it is what a
    /// sync may forget files against.
    #[test]
    fn a_walk_that_read_everything_is_complete() {
        let root = std::env::temp_dir().join(format!("walk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("docs")).expect("dir");
        std::fs::write(root.join("README.md"), "one\n").expect("write");
        std::fs::write(root.join("docs/a.md"), "two\n").expect("write");
        let walked = walk(&root, &|_| true).expect("walk");
        assert!(walked.complete);
        let paths: Vec<&str> = walked.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["README.md", "docs/a.md"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Every file is listed and only the asked-for ones are read, whatever
    /// their size.
    #[test]
    fn a_walk_reads_the_text_it_is_asked_for_and_lists_the_rest() {
        let root = std::env::temp_dir().join(format!("walk-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).expect("dir");
        let big = "# Note\n".repeat(100_000);
        std::fs::write(root.join("NOTE.md"), &big).expect("write");
        std::fs::write(root.join("src/main.rs"), "fn main() {}\n").expect("write");
        let walked = walk(&root, &|p: &str| p.ends_with(".md")).expect("walk");
        let text = |p: &str| {
            walked
                .files
                .iter()
                .find(|f| f.path == p)
                .map(|f| f.text.as_ref().map(String::len))
        };
        assert_eq!(text("NOTE.md"), Some(Some(big.len())));
        assert_eq!(text("src/main.rs"), Some(None), "listed, not read");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A checkout that is not there reads as no files at all. That must not be
    /// mistaken for a repository somebody emptied, or the sync would forget
    /// every file it has.
    #[test]
    fn a_walk_that_could_not_read_its_root_is_not_complete() {
        let root = std::env::temp_dir().join(format!("walk-missing-{}", uuid::Uuid::new_v4()));
        let walked = walk(&root, &|_| true).expect("walk");
        assert!(walked.files.is_empty());
        assert!(!walked.complete);
    }

    /// One file reads as the walk would read it, and nothing outside it.
    #[test]
    fn read_text_file_reads_one_file_and_refuses_to_leave_the_checkout() {
        let root = std::env::temp_dir().join(format!("read-one-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(
            root.join("docs/prd.md"),
            "# PRD
",
        )
        .unwrap();
        std::fs::write(root.join("docs/logo.png"), [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(root.join(".git/config"), "secret").unwrap();
        let big = "x".repeat(2 * 1024 * 1024);
        std::fs::write(root.join("big.md"), &big).unwrap();
        std::fs::write(root.join("latin1.md"), b"caf\xe9\n").unwrap();

        assert_eq!(
            read_text_file(&root, "docs/prd.md").as_deref(),
            Some(
                "# PRD
"
            )
        );
        assert_eq!(read_text_file(&root, "docs/missing.md"), None);
        assert_eq!(
            read_text_file(&root, "docs/logo.png"),
            None,
            "not a text path"
        );
        assert_eq!(
            read_text_file(&root, "big.md").map(|t| t.len()),
            Some(big.len()),
            "no size is too large to read"
        );
        assert_eq!(
            read_text_file(&root, "latin1.md").as_deref(),
            Some("caf\u{fffd}\n"),
            "a stray byte is replaced, not the file dropped"
        );
        for escape in [
            "../etc/passwd",
            "docs/../../x.md",
            "/etc/passwd",
            ".git/config",
            "docs//prd.md",
        ] {
            assert_eq!(
                read_text_file(&root, escape),
                None,
                "{escape} must read nothing"
            );
        }

        std::fs::remove_dir_all(&root).ok();
    }
}
