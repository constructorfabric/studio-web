// Studio's debug configurations in a member's launch.json: theirs untouched,
// Studio's replaced, the same file on a second press.
import { JsoncError, mergeLaunchJson, parseJsonc, plainOf } from "./launch-json";

const ours = [
  { type: "lldb", request: "launch", name: "Gearbox shop: shop", args: ["--config", "config/shop.yaml", "run"] },
  { type: "lldb", request: "launch", name: "Gearbox shop: admin" },
];
const isOurs = (name: string): boolean => name.startsWith("Gearbox shop: ");

function merged(text: string | undefined, entries: readonly Record<string, unknown>[] = ours): string {
  const result = mergeLaunchJson(text, entries, isOurs);
  if (!result.ok) throw new Error(result.why);
  return result.text;
}

function names(text: string): string[] {
  return ((plainOf(parseJsonc(text)) as { configurations: { name: string }[] }).configurations ?? []).map((c) => c.name);
}

const memberFile = `{
    // Use IntelliSense to learn about possible attributes.
    "version": "0.2.0",
    "configurations": [
        {
            "type": "node", // the member's own
            "request": "launch",
            "name": "My script",
        },
        /* kept as written */
        {
            "type": "lldb",
            "request": "launch",
            "name": "My other one"
        }
    ]
}
`;

describe("parseJsonc", () => {
  it("reads comments, trailing commas and positions", () => {
    const text = '{ // c\n "a": [1, "x", true, null,], /* d */ "b": {"c": -1.5e3,}, }';
    const node = parseJsonc(text);
    expect(plainOf(node)).toEqual({ a: [1, "x", true, null], b: { c: -1500 } });
    expect(node.start).toBe(0);
    expect(node.end).toBe(text.length);
  });

  it("reads escapes in strings", () => {
    expect(plainOf(parseJsonc('{"a": "q\\"uote\\\\"}'))).toEqual({ a: 'q"uote\\' });
  });

  it.each([
    ['{"a": 1 "b": 2}', "expected ',' or '}'"],
    ['{"a": }', "expected a value"],
    ['{"a": "open', "a string is not closed"],
    ["{} x", "expected the end of the file"],
    ["{ /* open", "a comment is not closed"],
    ["[1, 2", "expected ',' or ']'"],
  ])("refuses %s", (text, message) => {
    expect(() => parseJsonc(text)).toThrow(JsoncError);
    expect(() => parseJsonc(text)).toThrow(message);
  });
});

describe("mergeLaunchJson", () => {
  it("writes a new file when there is none", () => {
    const text = merged(undefined);
    expect(JSON.parse(text)).toEqual({ version: "0.2.0", configurations: ours });
    expect(merged("  \n")).toBe(text);
  });

  it("appends Studio's configurations and keeps the member's file as written", () => {
    const text = merged(memberFile);
    expect(names(text)).toEqual(["My script", "My other one", "Gearbox shop: shop", "Gearbox shop: admin"]);
    // Everything before the appended entries is the member's text, byte for byte.
    const cut = memberFile.indexOf('"My other one"\n        }') + '"My other one"\n        }'.length;
    expect(text.startsWith(memberFile.slice(0, cut))).toBe(true);
    expect(text).toContain("// the member's own");
    expect(text).toContain("/* kept as written */");
    expect(text).toContain('        {\n            "type": "lldb",\n            "request": "launch",\n            "name": "Gearbox shop: shop"');
  });

  it("gives the same file on a second press", () => {
    const once = merged(memberFile);
    expect(merged(once)).toBe(once);
    const result = mergeLaunchJson(once, ours, isOurs);
    expect(result).toMatchObject({ ok: true, removed: 2, added: 2 });
  });

  it("replaces Studio's old configurations, wherever they are, and only those", () => {
    const old = `{
  "configurations": [
    { "name": "Gearbox shop: gone", "type": "lldb" },
    { "name": "Mine", "type": "lldb" },
    { "name": "Gearbox other: kept", "type": "lldb" },
    { "name": "Gearbox shop: shop", "type": "lldb" }
  ]
}`;
    const text = merged(old);
    expect(names(text)).toEqual(["Mine", "Gearbox other: kept", "Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(merged(text)).toBe(text);
    // Two-space files stay two-space.
    expect(text).toContain('\n    {\n      "type": "lldb",');
  });

  it("removes Studio's configurations when there are none to add", () => {
    const once = merged(memberFile);
    const text = merged(once, []);
    expect(names(text)).toEqual(["My script", "My other one"]);
    expect(text).toBe(memberFile);
  });

  it("fills an empty list, and empties it again to []", () => {
    const empty = '{\n    "version": "0.2.0",\n    "configurations": []\n}\n';
    const text = merged(empty);
    expect(names(text)).toEqual(["Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(merged(text)).toBe(text);
    expect(merged(text, [])).toBe(empty);
  });

  it("keeps a comment in an otherwise empty list", () => {
    const commented = '{\n    "configurations": [\n        // add here\n    ]\n}';
    const text = merged(commented);
    expect(text).toContain("// add here");
    expect(merged(text)).toBe(text);
    expect(merged(text, [])).toBe(commented);
  });

  it("keeps a trailing comma's file stable", () => {
    const trailing = '{\n  "configurations": [\n    { "name": "Mine" },\n  ],\n}';
    const once = merged(trailing);
    expect(names(once)).toEqual(["Mine", "Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(merged(once)).toBe(once);
  });

  it("adds a list to a file without one", () => {
    const text = merged('{\n  "version": "0.2.0"\n}');
    expect(names(text)).toEqual(["Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(merged(text)).toBe(text);
    expect(names(merged("{}"))).toEqual(["Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(names(merged('{\n  "version": "0.2.0",\n}'))).toEqual(["Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(names(merged("{ // nothing yet\n}"))).toEqual(["Gearbox shop: shop", "Gearbox shop: admin"]);
  });

  it("handles a file on one line", () => {
    const text = merged('{"configurations":[{"name":"Mine"}]}');
    expect(names(text)).toEqual(["Mine", "Gearbox shop: shop", "Gearbox shop: admin"]);
    expect(merged(text)).toBe(text);
    expect(merged(text, [])).toBe('{"configurations":[{"name":"Mine"}]}');
  });

  it("keeps Windows line ends", () => {
    const text = merged('{\r\n    "configurations": [\r\n        { "name": "Mine" }\r\n    ]\r\n}\r\n');
    expect(text.replace(/\r\n/g, "")).not.toContain("\n");
    expect(merged(text)).toBe(text);
  });

  it("refuses a file it cannot read, and says where", () => {
    expect(mergeLaunchJson('{\n  "configurations": [\n    { "name" "x" }\n  ]\n}', ours, isOurs)).toEqual({
      ok: false,
      why: "launch.json does not read as JSON at 3:14: expected ':', found \"\\\"\"",
    });
    expect(mergeLaunchJson("[]", ours, isOurs)).toMatchObject({ ok: false, why: "launch.json holds something other than an object" });
    expect(mergeLaunchJson('{"configurations": {}}', ours, isOurs)).toMatchObject({ ok: false, why: 'launch.json\'s "configurations" is not a list' });
  });
});
