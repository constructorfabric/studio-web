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
/// Per-file byte ceiling for reading text content into a node (256 KiB).
const MAX_TEXT_BYTES: u64 = 256 * 1024;
/// Total text budget across a whole walk, so a big repo can't exhaust memory
/// (the graph store is in-memory). 24 MiB of prose is plenty for a first cut.
const MAX_TOTAL_TEXT_BYTES: u64 = 24 * 1024 * 1024;

/// One file discovered in the checkout.
#[derive(Debug, Clone)]
pub struct WalkedFile {
    /// Repo-relative POSIX path, e.g. `src/main.rs`.
    pub path: String,
    /// Size in bytes on disk.
    pub size: u64,
    /// UTF-8 content for text files under the size caps; `None` for binaries,
    /// oversized files, or once the total text budget is spent.
    pub text: Option<String>,
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
fn checkout_key(connector_id: &str, repo_full_path: &str) -> String {
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

/// Walk a checkout depth-first, skipping `.git` and symlinks, reading text-file
/// content within the caps. Blocking — call under `spawn_blocking`.
pub fn walk(dir: &Path) -> anyhow::Result<Vec<WalkedFile>> {
    let mut out: Vec<WalkedFile> = Vec::new();
    let mut text_budget: u64 = MAX_TOTAL_TEXT_BYTES;
    let mut stack: Vec<PathBuf> = vec![dir.to_path_buf()];

    while let Some(current) = stack.pop() {
        let entries = match std::fs::read_dir(&current) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                return Ok(out);
            }
            let path = entry.path();
            // Skip symlinks entirely — don't follow them or record them.
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(m) => m,
                Err(_) => continue,
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

            let mut text = None;
            if is_text_path(&path)
                && size <= MAX_TEXT_BYTES
                && text_budget >= size
                && let Ok(bytes) = std::fs::read(&path)
                && let Ok(s) = String::from_utf8(bytes)
            {
                text_budget = text_budget.saturating_sub(size);
                text = Some(s);
            }
            out.push(WalkedFile {
                path: rel_str,
                size,
                text,
            });
        }
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}
