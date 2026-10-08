import { corpusOffer, corpusSourceDecl } from "./corpus-source";

const COPY = {
  id: "gears-rust",
  path: "C:\\Users\\me\\ConstructorStudio\\corpus\\github.com__o__gears-rust\\0123456789ab\\gears-rust",
};
const ORIGIN = {
  sourceId: "gears-rust",
  url: "https://github.com/o/gears-rust.git",
  rev: "0123456789ab".padEnd(40, "0"),
  needsToken: false,
};
const STUDIO_WEB = [{ path: "C:\\Repos\\studio-web", id: "studio-web" }];

describe("the corpus as a New Product source", () => {
  it("offers the machine's copy, checked, in a workspace with no gears of its own", () => {
    // studio-web opened on the desktop: the engine's only root is the copy.
    expect(corpusOffer({ copy: COPY, workspaceRoots: STUDIO_WEB, engineRoots: [COPY.path] })).toEqual({
      kind: "copy",
      copy: COPY,
      preselect: true,
    });
    expect(corpusOffer({ copy: COPY, workspaceRoots: STUDIO_WEB, engineRoots: [] })).toMatchObject({ preselect: true });
  });

  it("offers it unchecked beside a workspace that has gears of its own", () => {
    const offer = corpusOffer({
      copy: COPY,
      workspaceRoots: [{ path: "C:/p/my-gears", id: "my-gears" }],
      engineRoots: ["C:/p/my-gears", COPY.path.replace(/\\/g, "/")],
    });
    expect(offer).toEqual({ kind: "copy", copy: COPY, preselect: false });
  });

  it("does not offer it when the workspace has its own checkout of the corpus", () => {
    // A session: /workspace/gears-rust is a folder, the loader refuses two sources with one id.
    const offer = corpusOffer({
      copy: COPY,
      workspaceRoots: [{ path: "/workspace/gears-rust", id: "gears-rust" }],
      engineRoots: ["/workspace/gears-rust"],
    });
    expect(offer).toEqual({ kind: "none" });
  });

  it("offers to bring a public corpus the backend lists and this machine has no copy of", () => {
    expect(corpusOffer({ toBring: ORIGIN, bringable: true, workspaceRoots: STUDIO_WEB, engineRoots: [] })).toEqual({
      kind: "bring",
      origin: ORIGIN,
    });
  });

  it("says a private corpus comes through Studio, signed in on the desktop", () => {
    const privateOrigin = { ...ORIGIN, needsToken: true, clonePath: "/cf/studio-product/v1/gearbox/corpus" };
    const offer = corpusOffer({ toBring: privateOrigin, bringable: true, workspaceRoots: STUDIO_WEB, engineRoots: [] });
    expect(offer.kind).toBe("bring");
    expect(offer.kind === "bring" ? offer.note : undefined).toMatch(/private.*signed in/);
  });

  it("says why a corpus cannot be brought from here", () => {
    const offer = corpusOffer({
      toBring: { ...ORIGIN, needsToken: true },
      bringable: "This corpus is private, and this Studio does not relay it.",
      workspaceRoots: STUDIO_WEB,
      engineRoots: [],
    });
    expect(offer).toEqual({
      kind: "bring",
      origin: { ...ORIGIN, needsToken: true },
      unavailable: "This corpus is private, and this Studio does not relay it.",
    });
  });

  it("offers nothing when there is no corpus to speak of: a session is unchanged", () => {
    expect(corpusOffer({ workspaceRoots: [{ path: "/workspace/gears-rust", id: "gears-rust" }], engineRoots: [] })).toEqual({
      kind: "none",
    });
  });

  it("declares the copy as an absolute path source under the engine's id for it", () => {
    expect(corpusSourceDecl(COPY)).toEqual({
      id: "gears-rust",
      at: "C:/Users/me/ConstructorStudio/corpus/github.com__o__gears-rust/0123456789ab/gears-rust",
    });
  });
});
