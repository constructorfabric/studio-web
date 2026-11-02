// Constructor Studio: adding Studio's debug configurations to a member's
// `.vscode/launch.json` without disturbing anything else in it.
//
// launch.json is JSON with comments and trailing commas, and it is the
// member's file: their configurations, their comments and their layout stay
// as they wrote them. So this does not parse, change and print the whole
// file -- that would drop every comment -- but finds where things are and
// edits the text: Studio's own entries (by name, `isOurs`) are cut out of
// the `configurations` array and the new ones appended at its end. Running it
// twice gives the same file as running it once.
//
// The parser is a small one of its own: the package depends on no JSONC
// parser, and adding one means a lock-file change for one file's worth of
// work.

/** A value in the text, and where it is: `end` is exclusive. */
export type JsonNode =
  | { readonly kind: "object"; readonly start: number; readonly end: number; readonly props: readonly JsonProp[] }
  | { readonly kind: "array"; readonly start: number; readonly end: number; readonly items: readonly JsonNode[] }
  | { readonly kind: "value"; readonly start: number; readonly end: number; readonly value: unknown };

export interface JsonProp {
  readonly key: string;
  /** Where the key's opening quote is. */
  readonly start: number;
  readonly value: JsonNode;
}

export class JsoncError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

/** The index of the first character at or after `from` that is not whitespace or a comment. */
export function nextSignificant(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "﻿") {
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      const close = text.indexOf("*/", i + 2);
      if (close < 0) throw new JsoncError("a comment is not closed", i);
      i = close + 2;
    } else {
      break;
    }
  }
  return i;
}

/** Parse JSON with comments and trailing commas, keeping where each value is. */
export function parseJsonc(text: string): JsonNode {
  let i = 0;
  const fail = (what: string): never => {
    throw new JsoncError(i < text.length ? `${what}, found ${JSON.stringify(text[i])}` : `${what}, found the end of the file`, i);
  };
  const value = (): JsonNode => {
    i = nextSignificant(text, i);
    const c = text[i];
    if (c === "{") return object();
    if (c === "[") return array();
    if (c === '"') {
      const start = i;
      return { kind: "value", start, end: (i = stringEnd(start)), value: JSON.parse(text.slice(start, i)) };
    }
    const literal = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
    if (literal === null) return fail("expected a value");
    const start = i;
    i += literal[0].length;
    return { kind: "value", start, end: i, value: JSON.parse(literal[0]) };
  };
  const stringEnd = (start: number): number => {
    let j = start + 1;
    while (j < text.length && text[j] !== '"') {
      if (text[j] === "\n") break;
      j += text[j] === "\\" ? 2 : 1;
    }
    if (text[j] !== '"') {
      i = start;
      fail("a string is not closed");
    }
    return j + 1;
  };
  const object = (): JsonNode => {
    const start = i++;
    const props: JsonProp[] = [];
    for (;;) {
      i = nextSignificant(text, i);
      if (text[i] === "}") break;
      if (text[i] !== '"') fail("expected a property name or '}'");
      const keyStart = i;
      i = stringEnd(keyStart);
      const key = JSON.parse(text.slice(keyStart, i)) as string;
      i = nextSignificant(text, i);
      if (text[i] !== ":") fail("expected ':'");
      i++;
      props.push({ key, start: keyStart, value: value() });
      i = nextSignificant(text, i);
      if (text[i] === ",") i++;
      else if (text[i] !== "}") fail("expected ',' or '}'");
    }
    return { kind: "object", start, end: ++i, props };
  };
  const array = (): JsonNode => {
    const start = i++;
    const items: JsonNode[] = [];
    for (;;) {
      i = nextSignificant(text, i);
      if (text[i] === "]") break;
      items.push(value());
      i = nextSignificant(text, i);
      if (text[i] === ",") i++;
      else if (text[i] !== "]") fail("expected ',' or ']'");
    }
    return { kind: "array", start, end: ++i, items };
  };
  const root = value();
  i = nextSignificant(text, i);
  if (i < text.length) fail("expected the end of the file");
  return root;
}

/** The plain value of a node, comments and positions dropped. */
export function plainOf(node: JsonNode): unknown {
  if (node.kind === "value") return node.value;
  if (node.kind === "array") return node.items.map(plainOf);
  return Object.fromEntries(node.props.map((prop) => [prop.key, plainOf(prop.value)]));
}

/** `1:5`-style position of an offset, for a message a person can find in the file. */
export function lineAndColumn(text: string, offset: number): string {
  const before = text.slice(0, offset).split("\n");
  return `${before.length}:${(before[before.length - 1] ?? "").length + 1}`;
}

/** Where the line holding `pos` starts, when only spaces precede `pos` on it; else `pos`. */
function lineStartIfBlankBefore(text: string, pos: number): number {
  let i = pos;
  while (i > 0 && (text[i - 1] === " " || text[i - 1] === "\t")) i--;
  return i === 0 || text[i - 1] === "\n" ? i : pos;
}

/** Past the line end after `pos`, when only spaces follow `pos` on its line; else `pos`. */
function pastLineEndIfBlankAfter(text: string, pos: number): number {
  let i = pos;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++;
  if (text.startsWith("\r\n", i)) return i + 2;
  if (text[i] === "\n") return i + 1;
  return i === text.length ? i : pos;
}

/** The indentation of the line `pos` starts, or `undefined` when something precedes it on the line. */
function indentAt(text: string, pos: number): string | undefined {
  const start = lineStartIfBlankBefore(text, pos);
  return start === pos && pos > 0 && text[pos - 1] !== "\n" ? undefined : text.slice(start, pos);
}

/** `value` as JSON at `indent`, its own lines indented by `unit`. */
function render(value: unknown, indent: string, unit: string, eol: string): string {
  return JSON.stringify(value, null, unit).split("\n").join(eol + indent);
}

/** The text with one element of an array cut out, and the comma that went with it. */
function withoutItem(text: string, list: Extract<JsonNode, { kind: "array" }>, index: number): string {
  const item = list.items[index] as JsonNode;
  const after = nextSignificant(text, item.end);
  const end = text[after] === "," ? after + 1 : item.end;
  if (list.items.length === 1) {
    // The only element: an array left holding nothing but whitespace is `[]`.
    const rest = text.slice(list.start + 1, item.start) + text.slice(end, list.end - 1);
    if (rest.trim() === "") return text.slice(0, list.start + 1) + text.slice(list.end - 1);
  }
  if (index === list.items.length - 1 && list.items.length > 1) {
    // The last one: the comma before it goes, so the one before is last now.
    const comma = nextSignificant(text, (list.items[index - 1] as JsonNode).end);
    if (text.slice(comma + 1, item.start).trim() === "") return text.slice(0, comma) + text.slice(item.end);
    return text.slice(0, comma) + text.slice(comma + 1, lineStartIfBlankBefore(text, item.start)) + text.slice(item.end);
  }
  return text.slice(0, lineStartIfBlankBefore(text, item.start)) + text.slice(pastLineEndIfBlankAfter(text, end));
}

export type LaunchMerge =
  | { readonly ok: true; readonly text: string; readonly removed: number; readonly added: number }
  | { readonly ok: false; readonly why: string };

/**
 * `text` (a launch.json, or `undefined` when there is none) with every
 * configuration whose name `isOurs` says is Studio's replaced by `ours`, at
 * the end of `configurations`. Everything else stays as it was written.
 */
export function mergeLaunchJson(
  text: string | undefined,
  ours: readonly Readonly<Record<string, unknown>>[],
  isOurs: (name: string) => boolean,
): LaunchMerge {
  if (text === undefined || text.trim() === "") {
    return { ok: true, text: JSON.stringify({ version: "0.2.0", configurations: ours }, null, 4) + "\n", removed: 0, added: ours.length };
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const parse = (current: string): JsonNode | string => {
    try {
      return parseJsonc(current);
    } catch (error) {
      if (error instanceof JsoncError) return `launch.json does not read as JSON at ${lineAndColumn(current, error.offset)}: ${error.message}`;
      throw error;
    }
  };
  let root = parse(text);
  if (typeof root === "string") return { ok: false, why: root };
  if (root.kind !== "object") return { ok: false, why: "launch.json holds something other than an object" };

  let out = text;
  const firstPropIndent = root.props.length > 0 ? indentAt(out, (root.props[0] as JsonProp).start) : undefined;
  const unit = firstPropIndent !== undefined && firstPropIndent !== "" ? firstPropIndent : "    ";

  if (!root.props.some((prop) => prop.key === "configurations")) {
    const prop = `"configurations": []`;
    const last = root.props[root.props.length - 1];
    if (last === undefined) {
      const inside = out.slice(root.start + 1, root.end - 1);
      out =
        inside.trim() === ""
          ? out.slice(0, root.start + 1) + eol + unit + prop + eol + out.slice(root.end - 1)
          : out.slice(0, root.start + 1) + eol + unit + prop + "," + out.slice(root.start + 1);
    } else {
      const after = nextSignificant(out, last.value.end);
      out =
        out[after] === ","
          ? out.slice(0, after + 1) + eol + unit + prop + out.slice(after + 1)
          : out.slice(0, last.value.end) + "," + eol + unit + prop + out.slice(last.value.end);
    }
    root = parse(out) as JsonNode;
  }

  const configurations = (node: JsonNode): { prop: JsonProp; list: Extract<JsonNode, { kind: "array" }> } | undefined => {
    const prop = node.kind === "object" ? node.props.find((p) => p.key === "configurations") : undefined;
    return prop !== undefined && prop.value.kind === "array" ? { prop, list: prop.value } : undefined;
  };
  if (configurations(root) === undefined) return { ok: false, why: "launch.json's \"configurations\" is not a list" };

  // One at a time, reading the text again after each cut: positions move.
  let removed = 0;
  for (;;) {
    const { list } = configurations(root) as { list: Extract<JsonNode, { kind: "array" }> };
    const index = list.items.findIndex((item) => {
      const value = plainOf(item) as { name?: unknown } | null;
      return item.kind === "object" && typeof value?.name === "string" && isOurs(value.name);
    });
    if (index < 0) break;
    out = withoutItem(out, list, index);
    removed++;
    root = parse(out) as JsonNode;
  }

  if (ours.length > 0) {
    const { prop, list } = configurations(root) as { prop: JsonProp; list: Extract<JsonNode, { kind: "array" }> };
    const keyIndent = indentAt(out, prop.start) ?? "";
    const first = list.items[0];
    const itemIndent = (first !== undefined ? indentAt(out, first.start) : undefined) ?? keyIndent + unit;
    const entries = ours.map((entry) => render(entry, itemIndent, unit, eol)).join("," + eol + itemIndent);
    const last = list.items[list.items.length - 1];
    if (last === undefined) {
      const inside = out.slice(list.start + 1, list.end - 1);
      out =
        inside.trim() === ""
          ? out.slice(0, list.start + 1) + eol + itemIndent + entries + eol + keyIndent + out.slice(list.end - 1)
          : out.slice(0, list.start + 1) + eol + itemIndent + entries + out.slice(list.start + 1);
    } else {
      const after = nextSignificant(out, last.end);
      out =
        out[after] === ","
          ? out.slice(0, after + 1) + eol + itemIndent + entries + out.slice(after + 1)
          : out.slice(0, last.end) + "," + eol + itemIndent + entries + out.slice(last.end);
    }
  }
  return { ok: true, text: out, removed, added: ours.length };
}
