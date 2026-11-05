/* A product's infra services as its product.gdl says them (ADR-0065 §1):
 * `infra = [use_service("keycloak", source = "...", image = "...",
 * config = {...}), ...]` inside `product(...)`.
 *
 * Read and written as text, the way a person writes it: the rest of the
 * file, its comments among it, is left as it was. Only literals are read --
 * strings, and dicts of strings -- which is all `use_service` takes. A call
 * with anything else keeps its text: `profile_config` is carried over
 * unread. */

/** One `use_service(...)` call. */
export interface UseService {
  name: string;
  source: string;
  image?: string;
  chart?: string;
  chart_version?: string;
  /** Keys of the passport's `config` the product sets. */
  config: Record<string, string>;
  /** The `profile_config = {...}` argument as written, carried over unread. */
  profileConfigText?: string;
}

type Tok = { kind: "str" | "ident" | "punct"; text: string; value: string; start: number; end: number };

/** Starlark's tokens, enough of them: strings, names, punctuation; comments
 *  and whitespace skipped. */
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "#") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      const start = i;
      const triple = text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      i += close.length;
      let value = "";
      while (i < text.length && !text.startsWith(close, i)) {
        if (text[i] === "\\" && i + 1 < text.length) {
          const n = text[i + 1];
          value += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else {
          value += text[i++];
        }
      }
      i += close.length;
      out.push({ kind: "str", text: text.slice(start, i), value, start, end: i });
    } else if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
      out.push({ kind: "ident", text: text.slice(start, i), value: text.slice(start, i), start, end: i });
    } else {
      out.push({ kind: "punct", text: c, value: c, start: i, end: i + 1 });
      i++;
    }
  }
  return out;
}

const OPENERS = new Set(["(", "[", "{"]);
const opens = (t: Tok | undefined) => t?.kind === "punct" && OPENERS.has(t.text);

/** The index of the token closing the bracket at `at`. */
function closing(toks: Tok[], at: number): number {
  let depth = 0;
  for (let i = at; i < toks.length; i++) {
    const t = toks[i];
    if (t.kind !== "punct") continue;
    if (OPENERS.has(t.text)) depth++;
    else if (t.text === ")" || t.text === "]" || t.text === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The `product(` call's open and close tokens. */
function productCall(toks: Tok[]): { open: number; close: number } | null {
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].kind === "ident" && toks[i].text === "product" && toks[i + 1].text === "(") {
      const close = closing(toks, i + 1);
      return close < 0 ? null : { open: i + 1, close };
    }
  }
  return null;
}

/** A top-level keyword argument of the call between `open` and `close`:
 *  where its name starts and where its value ends (exclusive), by token. */
function argument(toks: Tok[], open: number, close: number, name: string): { name: number; value: number; end: number } | null {
  let i = open + 1;
  while (i < close) {
    const t = toks[i];
    if (t.kind === "ident" && toks[i + 1]?.text === "=" && t.text === name) {
      let j = i + 2;
      const value = j;
      while (j < close && toks[j].text !== ",") j = opens(toks[j]) ? closing(toks, j) + 1 : j + 1;
      return { name: i, value, end: j };
    }
    i = opens(t) ? closing(toks, i) + 1 : i + 1;
  }
  return null;
}

/** A dict of string literals, or null when it holds anything else. */
function stringDict(toks: Tok[], open: number, close: number): Record<string, string> | null {
  const out: Record<string, string> = {};
  let i = open + 1;
  while (i < close) {
    const [k, colon, v] = [toks[i], toks[i + 1], toks[i + 2]];
    if (k?.kind !== "str" || colon?.text !== ":" || v?.kind !== "str") return null;
    out[k.value] = v.value;
    i += 3;
    if (toks[i]?.text === ",") i++;
  }
  return out;
}

/** The infra services `text` chooses; null when its product says no `infra`. */
export function readInfra(text: string): UseService[] | null {
  const toks = tokens(text);
  const call = productCall(toks);
  if (!call) return null;
  const arg = argument(toks, call.open, call.close, "infra");
  if (!arg || toks[arg.value]?.text !== "[") return null;
  const listClose = closing(toks, arg.value);
  const out: UseService[] = [];
  for (let i = arg.value + 1; i < listClose; i++) {
    if (!(toks[i].kind === "ident" && toks[i].text === "use_service" && toks[i + 1]?.text === "(")) continue;
    const open = i + 1;
    const close = closing(toks, open);
    const first = toks[open + 1];
    const s: UseService = { name: first?.kind === "str" ? first.value : "", source: "", config: {} };
    for (const key of ["source", "image", "chart", "chart_version"] as const) {
      const a = argument(toks, open, close, key);
      if (a && toks[a.value].kind === "str" && a.end === a.value + 1) s[key] = toks[a.value].value;
    }
    const config = argument(toks, open, close, "config");
    if (config && toks[config.value].text === "{") s.config = stringDict(toks, config.value, closing(toks, config.value)) ?? {};
    const profiles = argument(toks, open, close, "profile_config");
    if (profiles) s.profileConfigText = text.slice(toks[profiles.value].start, toks[profiles.end - 1].end);
    out.push(s);
    i = close;
  }
  return out;
}

const quote = (s: string) => JSON.stringify(s);

/** One call, on one line. */
export function useServiceText(s: UseService): string {
  const args = [quote(s.name), `source = ${quote(s.source)}`];
  if (s.image) args.push(`image = ${quote(s.image)}`);
  if (s.chart) args.push(`chart = ${quote(s.chart)}`);
  if (s.chart_version) args.push(`chart_version = ${quote(s.chart_version)}`);
  const config = Object.entries(s.config);
  if (config.length) args.push(`config = {${config.map(([k, v]) => `${quote(k)}: ${quote(v)}`).join(", ")}}`);
  if (s.profileConfigText) args.push(`profile_config = ${s.profileConfigText}`);
  return `use_service(${args.join(", ")})`;
}

/** The indentation of the line `at` is on. */
function indentAt(text: string, at: number): string {
  const line = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(line))?.[0] ?? "";
}

/** `text` with its product's `infra` set to `list`: the argument replaced
 *  where it is, else added before `gears`, else at the end of `product(...)`.
 *  An empty list takes the argument out. */
export function writeInfra(text: string, list: readonly UseService[]): string {
  const toks = tokens(text);
  const call = productCall(toks);
  if (!call) throw new Error("product.gdl has no product(...) call");
  const arg = argument(toks, call.open, call.close, "infra");
  const gears = argument(toks, call.open, call.close, "gears");
  const indent = indentAt(text, toks[(arg ?? gears)?.name ?? call.close].start) || "    ";
  const block =
    list.length === 0
      ? ""
      : `infra = [\n${list.map((s) => `${indent}    ${useServiceText(s)},`).join("\n")}\n${indent}]`;
  if (arg) {
    const start = toks[arg.name].start;
    if (block) return text.slice(0, start) + block + text.slice(toks[arg.end - 1].end);
    // Out with its comma and the line it stood on.
    const after = toks[arg.end]?.text === "," ? toks[arg.end].end : toks[arg.end - 1].end;
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = text.indexOf("\n", after);
    const whole = text.slice(lineStart, start).trim() === "" && (lineEnd < 0 || text.slice(after, lineEnd).trim() === "");
    return whole ? text.slice(0, lineStart) + text.slice(lineEnd < 0 ? after : lineEnd + 1) : text.slice(0, start) + text.slice(after);
  }
  if (!block) return text;
  if (gears) {
    const at = toks[gears.name].start;
    return `${text.slice(0, at)}${block},\n${indent}${text.slice(at)}`;
  }
  const last = toks[call.close - 1];
  const comma = last.text === "," || last.text === "(" ? "" : ",";
  return `${text.slice(0, last.end)}${comma}\n${indent}${block},\n${text.slice(last.end).replace(/^[ \t]*/, "")}`;
}

/** The id of the source the product's own repository is (`at = path(...)`):
 *  where a service added from the project's catalogue is found. */
export function homeSource(text: string): string | null {
  const m = /source\(\s*id\s*=\s*"([^"]+)"\s*,\s*at\s*=\s*path\(/.exec(text);
  return m?.[1] ?? null;
}
