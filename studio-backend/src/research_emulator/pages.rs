//! The emulator's pages: the identity provider's sign-in, the dashboard, and
//! what a service's public link opens.

use std::collections::HashMap;
use std::fmt::Write as _;

use super::Config;
use super::state::{Service, State, rfc3339};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

const STYLE: &str = "body{font:14px/1.5 system-ui,sans-serif;margin:0;padding:24px;color:#1f2328;background:#f6f8fa}\
main{max-width:1100px;margin:auto}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}\
.sub{color:#59636e;margin:0 0 12px}.card{background:#fff;border:1px solid #d0d7de;border-radius:8px;padding:16px;margin-bottom:12px}\
table{border-collapse:collapse;width:100%;background:#fff}th,td{text-align:left;padding:4px 8px;border-bottom:1px solid #d0d7de;vertical-align:top}\
th{color:#59636e;font-weight:600}code{font:12.5px ui-monospace,Consolas,monospace}\
.bad{color:#b42318;font-weight:600}.ok{color:#1a7f37}.tag{display:inline-block;padding:0 6px;border-radius:4px;background:#eaeef2}\
input{font:inherit;padding:6px 8px;border:1px solid #d0d7de;border-radius:6px;width:100%;box-sizing:border-box}\
label{display:block;margin:8px 0 2px;color:#59636e}button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid #1f6feb;background:#1f6feb;color:#fff;cursor:pointer}\
button.alt{background:#fff;color:#1f2328;border-color:#d0d7de}.banner{background:#fff8c5;border:1px solid #d4a72c;border-radius:8px;padding:8px 12px;margin-bottom:16px}";

fn page(title: &str, body: &str) -> String {
    format!(
        "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>{}</title><style>{STYLE}</style></head>\
         <body><main><div class=\"banner\">Constructor Research <b>emulator</b>: nothing here is real Research.</div>{body}</main></body></html>",
        esc(title)
    )
}

pub fn sign_in(cfg: &Config, q: &HashMap<String, String>, st: &State) -> String {
    let hidden: String = [
        "response_type",
        "client_id",
        "redirect_uri",
        "scope",
        "state",
        "code_challenge",
        "code_challenge_method",
    ]
    .iter()
    .map(|k| {
        format!(
            "<input type=\"hidden\" name=\"{k}\" value=\"{}\">",
            esc(q.get(*k).map(String::as_str).unwrap_or(""))
        )
    })
    .collect();
    let action = format!("{}/idp/connect/authorize", cfg.base_path);
    let mut known = String::new();
    for u in st.users.values() {
        let _ = write!(
            known,
            "<form method=\"post\" action=\"{}\" style=\"display:inline-block;margin:0 6px 6px 0\">{hidden}\
             <input type=\"hidden\" name=\"email\" value=\"{}\"><input type=\"hidden\" name=\"first_name\" value=\"{}\">\
             <input type=\"hidden\" name=\"last_name\" value=\"{}\"><button class=\"alt\">{}</button></form>",
            esc(&action),
            esc(&u.email),
            esc(&u.first_name),
            esc(&u.last_name),
            esc(&u.email)
        );
    }
    let known = if known.is_empty() {
        String::new()
    } else {
        format!(
            "<div class=\"card\"><b>Sign in again as</b><div style=\"margin-top:8px\">{known}</div></div>"
        )
    };
    page(
        "Sign in — Research emulator",
        &format!(
            "<h1>Sign in to Constructor Research</h1>\
             <p class=\"sub\">Client <code>{}</code> asks for <code>{}</code>. Any email signs in; the first sign-in makes the member and a project of theirs.</p>\
             {known}\
             <div class=\"card\"><form method=\"post\" action=\"{}\">{hidden}\
             <label>Email</label><input name=\"email\" type=\"email\" required placeholder=\"ann@example.com\">\
             <label>First name</label><input name=\"first_name\" placeholder=\"Ann\">\
             <label>Last name</label><input name=\"last_name\" placeholder=\"Lee\">\
             <p><button>Sign in</button></p></form></div>",
            esc(q.get("client_id").map(String::as_str).unwrap_or("")),
            esc(q.get("scope").map(String::as_str).unwrap_or("")),
            esc(&action)
        ),
    )
}

pub fn sign_in_error(why: &str) -> String {
    page(
        "Sign-in refused — Research emulator",
        &format!(
            "<h1>The sign-in request is refused</h1><div class=\"card bad\">{}</div>",
            esc(why)
        ),
    )
}

fn ago(now: u64, ms: u64) -> String {
    let s = now.saturating_sub(ms) / 1000;
    if s < 60 {
        format!("{s}s ago")
    } else if s < 3600 {
        format!("{}m ago", s / 60)
    } else {
        format!("{}h ago", s / 3600)
    }
}

pub fn dashboard(cfg: &Config, st: &State, now: u64) -> String {
    let t = cfg.timings;
    let mut b = String::new();
    let _ = write!(
        b,
        "<h1>Constructor Research emulator</h1>\
         <p class=\"sub\">Studio's settings: issuer <code>{u}/idp</code>, api_url <code>{u}/api/platform-account/v1</code>, \
         client <code>{c}</code>. A desk starts in {d}s, an image builds in {bl}s, a service comes up in {s}s.</p>\
         <div class=\"card\"><form method=\"post\" action=\"{bp}/_emulator/fail-next-build\" style=\"display:inline\">\
         <button class=\"alt\">{fail}</button></form> \
         <form method=\"post\" action=\"{bp}/_emulator/reset\" style=\"display:inline\" onsubmit=\"return confirm('Forget every member, key and project?')\">\
         <button class=\"alt\">Reset everything</button></form> \
         <span class=\"sub\">A Dockerfile that says <code>research-emulator: fail</code> fails its build too.</span></div>",
        u = esc(&cfg.public_url),
        c = esc(&cfg.client_id),
        d = t.desk.as_secs(),
        bl = t.build.as_secs(),
        s = t.start.as_secs(),
        bp = esc(&cfg.base_path),
        fail = if st.fail_next_build {
            "The next build fails — click to undo"
        } else {
            "Make the next build fail"
        },
    );

    let off: Vec<_> = st.calls.iter().filter(|c| c.off_list).collect();
    if !off.is_empty() {
        let _ = write!(
            b,
            "<h2 class=\"bad\">Requests the restricted gateway would refuse ({})</h2><table><tr><th>When</th><th>Request</th><th>Answer</th></tr>",
            off.len()
        );
        for c in off.iter().rev() {
            let _ = write!(
                b,
                "<tr><td>{}</td><td><code>{} {}</code></td><td>{}</td></tr>",
                ago(now, c.at_ms),
                esc(&c.method),
                esc(&c.path),
                c.status
            );
        }
        b.push_str("</table>");
    }

    b.push_str("<h2>Members and their projects</h2><table><tr><th>Member</th><th>Projects</th><th>Access keys</th></tr>");
    for u in st.users.values() {
        let projects: Vec<String> = st
            .projects
            .values()
            .filter(|p| p.owner == u.id)
            .map(|p| format!("{} <code>{}</code>", esc(&p.name), p.id))
            .collect();
        let keys: Vec<String> = st
            .keys
            .iter()
            .filter(|(_, k)| k.user_id == u.id)
            .map(|(key, k)| {
                format!(
                    "{} <code>{}…</code> until {}",
                    esc(&k.name),
                    esc(&key[..key.len().min(9)]),
                    esc(&k.expires_at)
                )
            })
            .collect();
        let _ = write!(
            b,
            "<tr><td>{} {}<br><code>{}</code></td><td>{}</td><td>{}</td></tr>",
            esc(&u.first_name),
            esc(&u.last_name),
            esc(&u.email),
            projects.join("<br>"),
            keys.join("<br>")
        );
    }
    b.push_str("</table>");

    b.push_str(
        "<h2>Desks</h2><table><tr><th>Desk</th><th>Project</th><th>Status</th><th>Files</th></tr>",
    );
    for d in st.desks.values() {
        let files = st.files.get(&d.id).map(|f| f.files.len()).unwrap_or(0);
        let _ = write!(
            b,
            "<tr><td>{} <code>{}</code></td><td><code>{}</code></td><td><span class=\"tag\">{}</span></td><td>{files}</td></tr>",
            esc(&d.name),
            d.id,
            d.project_id,
            esc(&d.status)
        );
    }
    b.push_str("</table>");

    b.push_str("<h2>Images</h2><table><tr><th>Image</th><th>Dockerfile</th><th>Status</th><th>Started</th><th>Log</th></tr>");
    for i in st.images.values().rev() {
        let status = i.status(now, t);
        let class = match status {
            "error" => "bad",
            "done" => "ok",
            _ => "",
        };
        let (log, _) = i.log_so_far(now, t);
        let _ = write!(
            b,
            "<tr><td>{} <code>{}</code></td><td><code>{}</code></td><td class=\"{class}\">{status}{}</td><td>{}</td>\
             <td><details><summary>{} lines</summary><pre>{}</pre></details></td></tr>",
            esc(&i.name),
            i.id,
            esc(&i.dockerfile),
            i.fails
                .as_deref()
                .filter(|_| status == "error")
                .map(|w| format!("<br>{}", esc(w)))
                .unwrap_or_default(),
            ago(now, i.started_ms),
            log.len(),
            esc(&log.join("\n"))
        );
    }
    b.push_str("</table>");

    b.push_str("<h2>Applications and services</h2><table><tr><th>Application</th><th>Service</th><th>Status</th><th>Link</th></tr>");
    for a in st.apps.values() {
        let services: Vec<&Service> = st.services.values().filter(|s| s.app_id == a.id).collect();
        if services.is_empty() {
            let _ = write!(
                b,
                "<tr><td>{} <code>{}</code></td><td colspan=\"3\">no services</td></tr>",
                esc(&a.name),
                a.id
            );
        }
        for s in services {
            let link = if s.ports.iter().any(|p| p.expose_to_internet) {
                format!(
                    "<a href=\"{bp}/_apps/{id}/\">open</a>",
                    bp = esc(&cfg.base_path),
                    id = s.id
                )
            } else {
                String::new()
            };
            let _ = write!(
                b,
                "<tr><td>{} <code>{}</code></td><td>{} <code>{}</code></td><td><span class=\"tag\">{}</span></td><td>{link}</td></tr>",
                esc(&a.name),
                a.id,
                esc(&s.name),
                s.id,
                esc(&s.status)
            );
        }
    }
    b.push_str("</table>");

    b.push_str(
        "<h2>Recent requests</h2><table><tr><th>When</th><th>Request</th><th>Answer</th></tr>",
    );
    for c in st.calls.iter().rev().take(100) {
        let _ = write!(
            b,
            "<tr><td>{}</td><td><code>{} {}</code></td><td class=\"{}\">{}</td></tr>",
            ago(now, c.at_ms),
            esc(&c.method),
            esc(&c.path),
            if c.off_list || c.status >= 400 {
                "bad"
            } else {
                ""
            },
            c.status
        );
    }
    b.push_str("</table>");
    page("Research emulator", &b)
}

pub fn service(st: &State, s: &Service) -> String {
    let image = st.images.get(&s.image_id);
    let env: String = s
        .environment_variables
        .iter()
        .map(|e| {
            format!(
                "<tr><td><code>{}</code></td><td><code>{}</code></td></tr>",
                esc(&e.name),
                esc(&e.value)
            )
        })
        .collect();
    let ports: Vec<String> = s
        .ports
        .iter()
        .map(|p| {
            format!(
                "{}{}",
                p.number,
                if p.expose_to_internet {
                    " (public)"
                } else {
                    ""
                }
            )
        })
        .collect();
    let app = st
        .apps
        .get(&s.app_id)
        .map(|a| a.name.as_str())
        .unwrap_or("");
    page(
        &format!("{} — Research emulator", s.name),
        &format!(
            "<h1>{name}</h1><p class=\"sub\">Service of application <b>{app}</b>. On a real stand this link opens the product; \
             the emulator only says what would run.</p>\
             <div class=\"card\"><table>\
             <tr><th>Status</th><td><span class=\"tag\">{status}</span> since {since}</td></tr>\
             <tr><th>Image</th><td>{image}</td></tr>\
             <tr><th>Hardware</th><td><code>{hw}</code></td></tr>\
             <tr><th>Ports</th><td>{ports}</td></tr>\
             <tr><th>Volumes</th><td><code>{volumes}</code></td></tr></table></div>\
             <h2>Environment</h2><table><tr><th>Name</th><th>Value</th></tr>{env}</table>",
            name = esc(&s.name),
            app = esc(app),
            status = esc(&s.status),
            since = rfc3339(s.since_ms),
            image = image
                .map(|i| format!(
                    "{} <code>{}</code> from <code>{}</code>",
                    esc(&i.name),
                    i.id,
                    esc(&i.dockerfile)
                ))
                .unwrap_or_else(|| format!(
                    "<span class=\"bad\">unknown image {}</span>",
                    esc(&s.image_id)
                )),
            hw = esc(&s.hardware_configuration_id),
            ports = esc(&ports.join(", ")),
            volumes = esc(&s.volumes.to_string()),
        ),
    )
}

pub fn no_service(id: &str) -> String {
    page(
        "No such service — Research emulator",
        &format!(
            "<h1>No service <code>{}</code></h1><p class=\"sub\">It was removed, or the emulator was reset.</p>",
            esc(id)
        ),
    )
}
