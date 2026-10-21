// The project's Domain model tab: what its documents say the application is,
// and where they disagree about it (docs/spec-domain-model.md).
//
// Three views, each one person's question (domain-model-screens.tsx):
// - To resolve: can we build from these documents? Everything to decide,
//   most blocking first: the documents' problems, open questions,
//   assumptions, and buildable requirements that state no basis. Below them,
//   changes that make the documentation better, each ready to save
//   (doc-quality.ts); a save shows at once (saved-entities.ts).
// - Model map: what is this application? The entities as a graph of how they
//   connect, each with every fact and the passage it rests on.
// - Requirements: where does this come from, how far did it get? Each
//   requirement followed from its passage to its code and tests.
// Under More, as before: Glossary (the names the project uses, decided by
// members), Work (issues, pull requests and commits naming what the
// documents define), Against the code (docs/project-and-product.md),
// Elsewhere (other projects' requirements) and Documents (which have been
// read). A build runs on the viewer's own model key, so the button says so.

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Candidate, type SpecModelEntityEdit } from "./api";
import { estimateLabel, etaLabel, readFraction, tokensLabel, type SpecModelBuildEstimate } from "./build-eta";
import { ModelMapView, Prose, RequirementsView, ResolveView, SideLink } from "./domain-model-screens";
import { gearRefs } from "./entity-gears";
import { DataTable } from "./data-table";
import { GlossaryScreen } from "./glossary-screen";
import { PrioritiesScreen } from "./priorities-screen";
import type { Obligation } from "./behaviour";
import { BehaviourScreen, HypothesesScreen, NeedsScreen, RulesScreen } from "./discovery-screens";
import { checkIndex, checkWrite, hypothesesFor, methodCatalogue, type Check, type MethodDef } from "./hypothesis-check";
import { hypothesesOf, materialDocument, type EvidenceState, type Hypothesis } from "./need-view";
import { readRule } from "./rule-checks";
import { decisionIndex, EVIDENCE_PREFIX, evidenceIndex, FactReviewContext, factKey, reviewIndex, withoutRejected, type FactReview, type SpecModelReview } from "./review-state";
import { overlaySaved, pruneSaved, savedWrites, withSaved, type SavedEdit } from "./saved-entities";
import { useGearCatalogue } from "./product-configurator-view";
import {
  buildLine,
  coverageCounts,
  entitiesOf,
  orderFindings,
  orderProductFindings,
  orderRelated,
  RELATION_LABEL,
  ruleLabel,
  subjectKey,
  type GlossaryEntry,
  type ProductFinding,
  type RelatedRequirement,
  type RelatedRequirements,
  type RequirementTraces,
  type SpecModel,
  type SpecModelFact,
  type SpecModelFinding,
  type SpecRequirements,
  type WorkLinks,
  workLabel,
  workState,
  unreadNote,
} from "./spec-model";

/** The three questions first; the rest stays a click away under More. */
type View = "resolve" | "map" | "reqs" | "needs" | "hypotheses" | "behaviour" | "rules" | "priorities" | "glossary" | "work" | "product" | "elsewhere" | "coverage";

/** The product findings as read, or why they could not be. */
type ProductRead = { repo: string | null; items: ProductFinding[] } | { error: string };

const POLL_MS = 3000;

/** A document's state as the documents list's filter names it. */
const STATE_LABEL: Partial<Record<string, string>> = { extracted: "read", pending: "never read", kept: "last read (copy missing)" };

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function SpecModelTab({
  token,
  projectId,
  workspaceId,
  only,
  orgId,
  onOpenFile,
}: {
  token: string;
  projectId: string;
  /** The project's workspace: where a pasted material is kept. */
  workspaceId?: string;
  /** The project's Issues tab: the same model, only what there is to decide. */
  only?: "issues";
  /** The project's organization: whose members an issue can be assigned to. */
  orgId?: string;
  /** Open a document in the project's IDE session. */
  onOpenFile?: (path: string) => void;
}) {
  const [model, setModel] = useState<SpecModel | null>(null);
  const [findings, setFindings] = useState<SpecModelFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(only === "issues" ? "resolve" : "map");
  /** The requirement followed in the Requirements view. */
  const [traced, setTraced] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [product, setProduct] = useState<ProductRead | null>(null);
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  const [work, setWork] = useState<WorkLinks | { error: string } | null>(null);
  const [requirements, setRequirements] = useState<SpecRequirements | { error: string } | null>(null);
  const [related, setRelated] = useState<RelatedRequirements | { error: string } | null>(null);
  const [traces, setTraces] = useState<RequirementTraces | { error: string } | null>(null);
  /** Entities saved this visit, laid over the model until a build reads them,
   *  so the map, the cards and the queue all show a save at once. */
  const [saved, setSaved] = useState<SavedEdit[]>([]);
  /** The check methods the project's kits add, read when Hypotheses opens. */
  const [kitMethods, setKitMethods] = useState<{ items: MethodDef[]; note: string | null } | null>(null);
  /** Members' accept or reject on each fact: rejected readings leave the
   *  model, accepted ones are the project's reading. */
  const [reviews, setReviews] = useState<SpecModelReview[]>([]);

  const load = useCallback(async () => {
    try {
      // A backend from before fact reviews answers 404: nothing is reviewed.
      void api
        .specModelReviews(token, projectId)
        .then((r) => setReviews(r.items))
        .catch(() => setReviews([]));
      const [m, f, g] = await Promise.all([
        api.specModel(token, projectId),
        api.specModelFindings(token, projectId),
        // A backend from before the glossary answers 404: the model still shows.
        api.glossary(token, projectId).catch(() => ({ items: [] as GlossaryEntry[], total: 0 })),
      ]);
      setModel(m);
      setSaved((s) => pruneSaved(s, m.build));
      setFindings(f.items);
      setGlossary(g.items);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  }, [token, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A separate read: the comparison with the code needs the catalogue and a
  // repository, and its absence must not hide the documents' own problems.
  useEffect(() => {
    let live = true;
    api
      .productFindings(token, projectId)
      .then((r) => live && setProduct({ repo: r.repo, items: orderProductFindings(r.items) }))
      .catch((e: unknown) => live && setProduct({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // Its own read, like the comparison with the code: no synced work must not
  // hide the documents' own problems.
  useEffect(() => {
    let live = true;
    api
      .workLinks(token, projectId)
      .then((r) => live && setWork(r))
      .catch((e: unknown) => live && setWork({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // Read without a model and without a key: what the documents define and
  // what each states it rests on.
  useEffect(() => {
    let live = true;
    api
      .specRequirements(token, projectId)
      .then((r) => live && setRequirements(r))
      .catch((e: unknown) => live && setRequirements({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  // The project's own gears, which keep entities the catalogue does not: the
  // plan's candidates its repositories declare. Read once the map is opened,
  // and quietly left out when the plan cannot be read.
  const [ownGears, setOwnGears] = useState<Candidate[]>([]);
  const mapOpened = view === "map";
  useEffect(() => {
    if (!mapOpened) return;
    let live = true;
    api
      .projectPlan(token, projectId)
      .then((r) => live && setOwnGears(r.items.flatMap((row) => row.candidates).filter((c) => c.origin === "project")))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token, projectId, mapOpened]);
  // The two views read on opening keep what they read for one project only:
  // another project starts them again, and their tab counts with them (#744).
  useEffect(() => {
    setTraces(null);
    setRelated(null);
  }, [token, projectId]);

  // Read when the view is opened: it reads every code file of the checkouts.
  useEffect(() => {
    if (view !== "reqs" || traces !== null) return;
    let live = true;
    api
      .requirementTrace(token, projectId)
      .then((r) => live && setTraces(r))
      .catch((e: unknown) => live && setTraces({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [view, traces, token, projectId]);

  // Read only when the view is opened: it reads every other project's documents.
  useEffect(() => {
    if (view !== "elsewhere" || related !== null) return;
    let live = true;
    api
      .relatedRequirements(token, projectId)
      .then((r) => live && setRelated(r))
      .catch((e: unknown) => live && setRelated({ error: message(e) }));
    return () => {
      live = false;
    };
  }, [view, related, token, projectId]);

  // While a build runs, read again until it stops: the build is in the
  // backend's process, and nothing pushes its progress.
  const running = model?.build.running ?? false;
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [running, load]);

  // What the next build would read and how long it should take, read again
  // whenever a build stops. A backend from before the estimate answers 404:
  // the button then shows no estimate.
  const [estimate, setEstimate] = useState<SpecModelBuildEstimate | null>(null);
  useEffect(() => {
    if (running) return;
    let live = true;
    api
      .specModelBuildEstimate(token, projectId)
      .then((e) => live && setEstimate(e))
      .catch(() => live && setEstimate(null));
    return () => {
      live = false;
    };
  }, [token, projectId, running]);

  const startBuild = async (path?: string) => {
    setStarting(true);
    try {
      await api.startSpecModelBuild(token, projectId, path);
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setStarting(false);
    }
  };

  const decide = async (finding: SpecModelFinding, decision: "confirmed" | "dismissed") => {
    try {
      await api.decideSpecModelFinding(token, projectId, finding.fingerprint, decision);
      setFindings((all) => all.map((f) => (f.fingerprint === finding.fingerprint ? { ...f, decision } : f)));
    } catch (e) {
      setError(message(e));
    }
  };

  const decideTerm = async (key: string, decision: { name: string | null; alias_of: string | null }) => {
    try {
      await api.decideGlossaryEntry(token, projectId, key, decision);
      setGlossary((await api.glossary(token, projectId)).items);
    } catch (e) {
      setError(message(e));
    }
  };

  const saveEntity = async (edit: SpecModelEntityEdit) => {
    const write = await api.saveSpecModelEntity(token, projectId, edit);
    setSaved((s) => withSaved(s, { edit, write, at: Date.now() }));
    return write;
  };

  const reviewByKey = useMemo(() => reviewIndex(reviews), [reviews]);
  const evidence = useMemo(() => evidenceIndex(reviews), [reviews]);
  const decisions = useMemo(() => decisionIndex(reviews), [reviews]);
  // Stable, so the glossary document is read once per project, not per render.
  const loadGlossaryDocument = useCallback(() => api.glossaryDocument(token, projectId), [token, projectId]);
  // Who an issue can go to: the organization's members with a GitHub login
  // among their confirmed or claimed accounts. Read only where issues are.
  const [people, setPeople] = useState<{ name: string; login: string }[]>([]);
  useEffect(() => {
    if (!orgId || view !== "resolve") return;
    let live = true;
    void api
      .orgMembers(token, orgId)
      .then((members) =>
        Promise.all(
          members.slice(0, 50).map((m) =>
            api
              .memberIdentities(token, orgId, m.user_id)
              .then((ids) => {
                const gh = ids.aliases.find((a) => a.kind === "github" && a.confidence !== "suggested");
                return gh ? { name: m.display_name || m.email || gh.external_id, login: gh.external_id } : null;
              })
              .catch(() => null),
          ),
        ),
      )
      .then((list) => live && setPeople(list.filter((p): p is { name: string; login: string } => !!p)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token, orgId, view]);
  useEffect(() => {
    if (view !== "hypotheses" || kitMethods) return;
    let live = true;
    void api
      .kitInstallations(token, projectId)
      .then(async ({ items }) => {
        const kits = [...new Set(items.filter((k) => k.status === "installed").map((k) => k.kit_slug))];
        if (kits.length === 0) return { items: [], note: null };
        const got = await api.specModelCheckMethods(token, projectId, kits);
        const from = [...new Set(got.items.map((m) => m.kit))];
        return {
          items: got.items.map((m) => ({ id: m.id, kit: m.kit, label: m.label, uncertainty: m.uncertainty, inputs: m.inputs, action: m.action, limits: m.limits, appliesTo: m.applies_to })),
          note: [
            from.length ? `Methods from the ${from.join(", ")} kit${from.length === 1 ? "" : "s"} included.` : "",
            Object.keys(got.unread).length
              ? `Not read: ${Object.entries(got.unread).map(([kit, why]) => `${kit} (${why})`).join(", ")}.`
              : "",
          ]
            .filter(Boolean)
            .join(" ") || null,
        };
      })
      .catch((e: unknown) => ({ items: [], note: `The kits' methods were not read: ${message(e)}` }))
      .then((v) => live && setKitMethods(v));
    return () => {
      live = false;
    };
  }, [view, token, projectId, kitMethods]);
  const methods = useMemo(() => methodCatalogue(kitMethods?.items ?? []), [kitMethods]);
  const checks = useMemo(() => checkIndex(reviews), [reviews]);
  const saveCheck = async (h: Hypothesis, check: Check) => {
    const revision = model?.documents.find((d) => d.path === h.fact.source.path)?.revision ?? "";
    await api.reviewSpecModelFacts(token, projectId, [checkWrite(h, check, revision)]);
    setReviews((await api.specModelReviews(token, projectId)).items);
  };
  /** Record a decision kept by key: an excluded obligation, a match across
   *  projects. `proposed` withdraws it. */
  const recordDecision = async (key: string, state: string, note: string | null = null, path = "") => {
    try {
      await api.reviewSpecModelFacts(token, projectId, [{ fact_key: key, state, path, revision: "", note }]);
      setReviews((await api.specModelReviews(token, projectId)).items);
    } catch (e) {
      setError(message(e));
    }
  };
  const recordEvidence = async (f: SpecModelFact, state: EvidenceState) => {
    const revision = model?.documents.find((d) => d.path === f.source.path)?.revision ?? "";
    try {
      await api.reviewSpecModelFacts(token, projectId, [{ fact_key: `${EVIDENCE_PREFIX}${factKey(f)}`, state: state === "unchecked" ? "proposed" : state, path: f.source.path, revision }]);
      setReviews((await api.specModelReviews(token, projectId)).items);
    } catch (e) {
      setError(message(e));
    }
  };
  const allFacts = useMemo(() => overlaySaved(model?.facts ?? [], saved), [model, saved]);
  const facts = useMemo(() => withoutRejected(allFacts, reviewByKey), [allFacts, reviewByKey]);
  const factReview = useMemo<FactReview>(
    () => ({
      stateOf: (f) => reviewByKey.get(factKey(f)),
      reviewedEarlier: (f) => {
        const r = reviews.find((x) => x.fact_key === factKey(f));
        const now = model?.documents.find((d) => d.path === f.source.path)?.revision;
        return !!r && !!r.revision && !!now && r.revision !== now;
      },
      rejectedOf: (keys) => allFacts.filter((f) => reviewByKey.get(factKey(f)) === "rejected" && keys.includes(subjectKey(f.subject))),
      review: async (fs, state) => {
        const revisionOf = new Map((model?.documents ?? []).map((d) => [d.path, d.revision]));
        const items = fs.map((f) => ({ fact_key: factKey(f), state, path: f.source.path, revision: revisionOf.get(f.source.path) ?? "" }));
        try {
          await api.reviewSpecModelFacts(token, projectId, items);
          setReviews((await api.specModelReviews(token, projectId)).items);
        } catch (e) {
          setError(message(e));
        }
      },
    }),
    [reviewByKey, reviews, allFacts, model, token, projectId],
  );
  const writes = useMemo(() => savedWrites(saved), [saved]);
  const hypotheses = useMemo(() => hypothesesOf(facts), [facts]);
  const entities = useMemo(() => entitiesOf(facts, glossary), [facts, glossary]);
  // The lines a fact names are the repository's lines only for a document
  // read at its current revision: a sentence is proposed only there.
  const revisions = useMemo(
    () => new Map((model?.documents ?? []).filter((d) => d.state === "extracted").map((d) => [d.path, d.revision])),
    [model],
  );
  // Which gear keeps each Domain entity: read when the map is first opened.
  // Without the catalogue no gear is known, so no gap is claimed either.
  const catalogue = useGearCatalogue(token, view === "map", projectId);

  const index = catalogue && "index" in catalogue ? catalogue.index : null;
  const gears = useMemo(() => (index ? gearRefs(index, ownGears) : null), [index, ownGears]);
  const ordered = useMemo(() => orderFindings(findings), [findings]);
  const line = model ? buildLine(model.build) : "";

  /* Eight tabs, each one question; a tab of two views shows a segment under
     it. The views themselves are unchanged — only where they are reached. */
  const tabs: { id: string; label: string; why: string; count: number; views: { id: View; label: string; count: number }[] }[] = [
    { id: "entities", label: "Entities", why: "what is this application?", count: entities.length, views: [{ id: "map", label: "Entities", count: entities.length }] },
    {
      id: "reqs",
      label: "Requirements",
      why: "where does each come from, how far did it get?",
      count: requirements && "items" in requirements ? requirements.total : 0,
      views: [{ id: "reqs", label: "Requirements", count: requirements && "items" in requirements ? requirements.total : 0 }],
    },
    {
      id: "need",
      label: "Need",
      why: "who has which problem, and what is expected to help",
      count: facts.filter((f) => f.kind === "problem" || f.kind === "outcome" || f.kind === "idea" || f.kind === "benefit").length,
      views: [
        { id: "needs", label: "Needs", count: facts.filter((f) => f.kind === "problem" || f.kind === "outcome" || f.kind === "idea").length },
        { id: "hypotheses", label: "Hypotheses", count: facts.filter((f) => f.kind === "benefit").length },
      ],
    },
    {
      id: "rules",
      label: "Rules",
      why: "what must hold, and what behaviour the documents must answer",
      count: facts.filter((f) => f.kind === "constraint" && reviewByKey.get(factKey(f)) === "accepted").length + facts.filter((f) => f.kind === "action").length,
      views: [
        { id: "rules", label: "Rules", count: facts.filter((f) => f.kind === "constraint" && reviewByKey.get(factKey(f)) === "accepted").length },
        { id: "behaviour", label: "Behaviour", count: facts.filter((f) => f.kind === "action").length },
      ],
    },
    { id: "priorities", label: "Priorities", why: "what to build first", count: 0, views: [{ id: "priorities", label: "Priorities", count: 0 }] },
    { id: "glossary", label: "Glossary", why: "the project's words", count: glossary.length, views: [{ id: "glossary", label: "Glossary", count: glossary.length }] },
    {
      id: "sources",
      label: "Sources",
      why: "what was read, the work that names it, the code, other projects",
      count: model?.documents.length ?? 0,
      views: [
        { id: "coverage", label: "Documents", count: model?.documents.length ?? 0 },
        { id: "work", label: "Work", count: work && "items" in work ? work.total : 0 },
        { id: "product", label: "Against the code", count: product && "items" in product ? product.items.length : 0 },
        { id: "elsewhere", label: "Elsewhere", count: related && "items" in related ? related.total : 0 },
      ],
    },
  ];
  const tabOf = (v: View) => tabs.find((t) => t.views.some((x) => x.id === v))?.id ?? "entities";

  return (
    <FactReviewContext.Provider value={factReview}>
    <>
      <h1>{only === "issues" ? "Issues" : "Domain model"}</h1>
      <p className="subtitle">
        {only === "issues"
          ? "Everything to decide about the project: what stops a build, what to look at, how the documentation could be better."
          : "What the project's documents say the application is, each fact with the passage it comes from."}
      </p>

      <div className="sm-bar">
        <div className="dm-tabs" role="tablist" aria-label="Domain model" hidden={only === "issues"}>
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tabOf(view) === t.id}
              className={`dm-tabbtn${tabOf(view) === t.id ? " on" : ""}`}
              onClick={() => setView(t.views[0].id)}
              title={t.why}
            >
              {t.label} <span className="chip-n">{t.count}</span>
            </button>
          ))}
        </div>
        <div className="sm-build">
          {line && <span className={model?.build.error ? "sm-build-line sm-err" : "sm-build-line"}>{line}</span>}
          {model && running && model.build.documents > 0 && model.build.done < model.build.documents && (
            <span className="sm-build-progress" data-build-progress>
              <progress value={readFraction(model.build)} max={1} />
              {etaLabel(model.build, Date.now())}
            </span>
          )}
          <button
            className="primary"
            disabled={running || starting || model?.documents.length === 0}
            onClick={() => void startBuild()}
            title={
              "Reads every document not yet read at its current revision, on your own model key, " +
              "four at once" +
              (estimate && estimate.documents > 0
                ? ` (${tokensLabel(estimate.input_tokens)}; ${estimate.measured ? "timed on earlier builds" : "a first guess"})`
                : "")
            }
          >
            {running
              ? "Building…"
              : estimate && estimate.documents > 0
                ? `Build on my key · ${estimateLabel(estimate)}`
                : "Build on my key"}
          </button>
        </div>
      </div>
      {only !== "issues" && (tabs.find((t) => t.id === tabOf(view))?.views.length ?? 0) > 1 && (
        <div className="dm-seg" role="tablist" aria-label="Views">
          {tabs
            .find((t) => t.id === tabOf(view))!
            .views.map((v) => (
              <button key={v.id} type="button" role="tab" aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label} <span className="chip-n">{v.count}</span>
              </button>
            ))}
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {!model && !error && <div className="empty">Loading…</div>}
      {model && unreadNote(model) && (
        <div className="hint" data-no-documentation data-unread={model.unread_documents ?? 0}>
          {unreadNote(model)}
        </div>
      )}

      {model && view === "resolve" && (
        <ResolveView
          findings={ordered}
          requirements={requirements && "items" in requirements ? requirements : null}
          entities={entities}
          glossary={glossary}
          onDecide={decide}
          onSave={saveEntity}
          onSameThing={(alias, of) => decideTerm(alias, { name: null, alias_of: of })}
          onPropose={(f) => api.proposeSpecModelFix(token, projectId, f.fingerprint)}
          onProposeSentence={(sentence) => api.proposeSpecModelSentence(token, projectId, sentence)}
          revisions={revisions}
          people={people}
          issueOf={(key) => (decisions.get(`iss:${key}`)?.state === "opened" ? decisions.get(`iss:${key}`)?.note ?? null : null)}
          onCreateIssue={async (key, issue) => {
            const made = await api.createSpecModelIssue(token, projectId, issue);
            if (made.url) await recordDecision(`iss:${key}`, "opened", made.url);
            return made;
          }}
          onTrace={(id) => {
            setTraced(id);
            setView("reqs");
          }}
          onOpenFile={onOpenFile}
          built={model.facts.length > 0}
        />
      )}
      {model && view === "map" && (
        <ModelMapView
          entities={entities}
          onOpenFile={onOpenFile}
          onSave={saveEntity}
          saved={writes}
          gears={gears}
        />
      )}
      {view === "reqs" && (
        <RequirementsView read={requirements} traces={traces} work={work} selected={traced} onSelect={setTraced} onOpenFile={onOpenFile} />
      )}
      {model && view === "needs" && (
        <NeedsScreen
          facts={facts}
          onOpenFile={onOpenFile}
          readStopped={model.build.error}
          accepted={(f) => reviewByKey.get(factKey(f)) === "accepted"}
          onAddMaterial={
            workspaceId
              ? async (title, content) => {
                  const doc = await api.createProjectDocument(token, workspaceId, projectId, {
                    type_key: "material",
                    title,
                    content: materialDocument(title, content),
                  });
                  // Read at once, on the key of whoever added it: no separate start.
                  await startBuild(`studio:${doc.id}`);
                }
              : undefined
          }
          onPropose={(content) => api.proposeSpecModelFile(token, projectId, "docs/discovery.md", content, "the need as accepted in Studio")}
          requirements={
            requirements && "items" in requirements
              ? requirements.items.filter((r) => ["fr", "usecase", "flow"].includes((r.kind ?? "").toLowerCase()))
              : []
          }
        />
      )}
      {model && view === "hypotheses" && (
        <HypothesesScreen
          facts={facts}
          stateOf={(f) => (evidence.get(factKey(f)) as EvidenceState | undefined) ?? "unchecked"}
          onEvidence={recordEvidence}
          catalogue={methods}
          kitNote={kitMethods?.note}
          checkOf={(h) => checks.get(factKey(h.fact))}
          onSaveCheck={saveCheck}
          onPropose={(content) => api.proposeSpecModelFile(token, projectId, "docs/hypotheses.md", content, "the hypotheses and their checks")}
          onOpenFile={onOpenFile}
        />
      )}
      {model && view === "rules" && (
        <RulesScreen facts={facts} accepted={(f) => reviewByKey.get(factKey(f)) === "accepted"} onOpenFile={onOpenFile} />
      )}
      {model && view === "behaviour" && (
        <BehaviourScreen
          facts={facts}
          rules={facts.filter((f) => f.kind === "constraint" && f.status === "active" && reviewByKey.get(factKey(f)) === "accepted").map(readRule)}
          decisionOf={(key) => decisions.get(key)}
          onExclude={(o: Obligation, reason) => recordDecision(o.key, reason === null ? "proposed" : "excluded", reason, o.from.source.path)}
          onOpenFile={onOpenFile}
        />
      )}
      {view === "priorities" && (
        <PrioritiesScreen
          read={requirements}
          projectId={projectId}
          reviews={reviews}
          claimsFor={(r) =>
            hypothesesFor(r, hypotheses).map((h) => ({
              claim: h.solution || h.effect || h.fact.subject,
              state: (evidence.get(factKey(h.fact)) as EvidenceState | undefined) ?? "unchecked",
              methods: checks.get(factKey(h.fact))?.methods ?? [],
            }))
          }
          onSave={async (writes) => {
            await api.reviewSpecModelFacts(token, projectId, writes);
            setReviews((await api.specModelReviews(token, projectId)).items);
          }}
          onConfirm={(content) => api.proposeSpecModelFile(token, projectId, "docs/priorities.md", content, "the priorities as confirmed in Studio")}
          onTrace={(id) => {
            setTraced(id);
            setView("reqs");
          }}
        />
      )}
      {view === "elsewhere" && (
        <Elsewhere
          read={related}
          onOpenFile={onOpenFile}
          decisionOf={(r) => decisions.get(relatedKey(r))?.state}
          onDecide={(r, state) => recordDecision(relatedKey(r), state, null, r.defined_in.path)}
        />
      )}
      {model && view === "glossary" && (
        <GlossaryScreen
          entries={glossary}
          entities={entities}
          onDecide={decideTerm}
          onProposeRename={(from, to) => api.proposeGlossaryRename(token, projectId, from, to)}
          onProposeSentence={(sentence) => api.proposeSpecModelSentence(token, projectId, sentence)}
          onDistinct={(a, b) => api.decideGlossaryDistinct(token, projectId, a, b).catch((e: unknown) => setError(message(e)))}
          onOpenFile={onOpenFile}
          revisions={revisions}
          onLoadDocument={loadGlossaryDocument}
          onProposeDocument={(rows) => api.proposeGlossaryDocument(token, projectId, rows)}
        />
      )}
      {view === "work" && <Work read={work} onOpenFile={onOpenFile} />}
      {view === "product" && <AgainstTheCode read={product} onOpenFile={onOpenFile} />}
      {model && view === "coverage" && (
        <Coverage model={model} busy={running || starting} onRebuild={(path) => void startBuild(path)} />
      )}
    </>
    </FactReviewContext.Provider>
  );
}



function AgainstTheCode({
  read,
  onOpenFile,
}: {
  read: ProductRead | null;
  onOpenFile?: (path: string) => void;
}) {
  if (!read) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (!read.repo) {
    return (
      <div className="empty">
        No code to compare: the project has no gear repository and no GitHub source whose Cargo
        manifests could be read.
      </div>
    );
  }
  if (read.items.length === 0) {
    return (
      <div className="empty">
        Every capability the documents ask for is filled by a gear in <code>{read.repo}</code>.
      </div>
    );
  }
  return (
    <div className="sm-findings">
      <p className="hint">
        The documents against the crates <code>{read.repo}</code> depends on and the gears it declares.
        A decision about which gear fills a capability is taken in the project&apos;s Product tab.
      </p>
      <div className="card">
        <DataTable<ProductFinding>
          list="dm-against-code"
          urlPrefix="code."
          rows={read.items}
          rowKey={(f) => f.fingerprint}
          rowLabel={(f) => f.capability}
          pageSize={20}
          search={{ placeholder: "Search capabilities" }}
          searchText={(f) => [f.capability, f.message, f.gear]}
          empty={{ title: "Nothing matches." }}
          columns={[
            { id: "sev", header: "Severity", cell: (f) => <span className={`sm-sev sm-sev-${f.severity}`}>{f.severity}</span> },
            { id: "rule", header: "What", cell: (f) => ruleLabel(f.rule) },
            { id: "cap", header: "Capability", compare: (a, b) => a.capability.localeCompare(b.capability), cell: (f) => <code>{f.capability}</code> },
            { id: "docs", header: "Documents", num: true, cell: (f) => f.sides.length },
          ]}
          expand={(f) => (
            <div>
              <p className="sm-message">
                <Prose text={f.message} />
              </p>
              <div className={f.sides.length === 2 ? "sm-sides sm-two" : "sm-sides"}>
                {f.sides.slice(0, 6).map((sd, k) => (
                  <SideLink key={k} side={{ path: sd.path, quote: sd.quote }} onOpenFile={sd.kind === "file" ? onOpenFile : undefined} />
                ))}
                {f.sides.length > 6 && <div className="hint">and {f.sides.length - 6} more documents</div>}
              </div>
            </div>
          )}
        />
      </div>
    </div>
  );
}

/** The issues, pull requests and commits that name an identifier the
 *  documents define, by identifier. A link is made only by the work naming
 *  the identifier; nothing is guessed. */
function Work({
  read,
  onOpenFile,
}: {
  read: WorkLinks | { error: string } | null;
  onOpenFile?: (path: string) => void;
}) {
  if (read === null) return <div className="empty">Loading…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (!read.synced) {
    return <div className="empty">Nothing syncs this deployment&apos;s issues and pull requests, so there is no work to link.</div>;
  }
  const summary = `${read.identifiers} identifier${read.identifiers === 1 ? "" : "s"} defined in the documents; ${read.total} named by work. ${read.unlinked} of ${read.work} issues, pull requests and commits name none.`;
  if (read.items.length === 0) {
    return (
      <div className="empty">
        {read.identifiers === 0
          ? "The documents define no identifiers with a label (**ID**: `…`), so there is nothing for work to name."
          : `No issue, pull request or commit names one of the ${read.identifiers} identifiers the documents define.`}
      </div>
    );
  }
  return (
    <>
      <p className="hint">{summary} A piece of work is linked when its title, text or commit message names the identifier.</p>
      <div className="card">
        <DataTable<WorkLinks["items"][number]>
          list="dm-work"
          urlPrefix="work."
          rows={read.items}
          rowKey={(l) => l.id}
          rowLabel={(l) => l.id}
          pageSize={20}
          search={{ placeholder: "Search identifiers and work" }}
          searchText={(l) => [l.id, ...l.work.map((w) => w.title)]}
          empty={{ title: "Nothing matches." }}
          columns={[
            { id: "id", header: "Identifier", compare: (a, b) => a.id.localeCompare(b.id), cell: (l) => <code>{l.id}</code> },
            { id: "where", header: "Defined in", cell: (l) => <SideLink side={l.defined_in} onOpenFile={onOpenFile} /> },
            { id: "work", header: "Work", num: true, compare: (a, b) => a.work.length - b.work.length, cell: (l) => l.work.length },
            {
              id: "latest",
              header: "Named by",
              cell: (l) => <span className="sub">{l.work.slice(0, 2).map((w) => workLabel(w)).join(", ")}{l.work.length > 2 ? " …" : ""}</span>,
            },
          ]}
          expand={(l) => (
            <ul className="sm-work-items">
              {l.work.map((w, k) => (
                <li key={k}>
                  {w.url ? (
                    <a href={w.url} target="_blank" rel="noreferrer">
                      {workLabel(w)}
                    </a>
                  ) : (
                    <span>{workLabel(w)}</span>
                  )}{" "}
                  <span className="sm-work-title">{w.title}</span> {workState(w) && <span className="sm-status">{workState(w)}</span>}
                </li>
              ))}
            </ul>
          )}
        />
      </div>
    </>
  );
}

/** What other projects of the organization require that reads like this
 *  project's requirements: the same, overlapping, or the opposite. A list of
 *  candidates to read side by side; nothing is decided here. */
/** A match across projects as its decision is kept. */
const relatedKey = (r: RelatedRequirement) => `rel:${r.id}|${r.other_project_id}|${r.other_id}`;

const MATCH_DECISIONS: { state: string; label: string; why: string }[] = [
  { state: "reuse", label: "Reuse it", why: "The other project's functionality serves this need: use it rather than build it again" },
  { state: "coordinate", label: "Coordinate", why: "Related work: keep the two projects in step" },
  { state: "separate", label: "Keep separate", why: "Alike in words, different in what it does or for whom" },
  { state: "unrelated", label: "Unrelated", why: "Not the same functionality at all" },
];

function Elsewhere({
  read,
  onOpenFile,
  decisionOf,
  onDecide,
}: {
  read: RelatedRequirements | { error: string } | null;
  onOpenFile?: (path: string) => void;
  decisionOf?: (r: RelatedRequirement) => string | undefined;
  onDecide?: (r: RelatedRequirement, state: string) => Promise<void>;
}) {
  if (read === null) return <div className="empty">Comparing with the organization&apos;s other projects…</div>;
  if ("error" in read) return <div className="error">{read.error}</div>;
  if (read.items.length === 0) {
    return (
      <div className="empty">
        {read.projects === 0
          ? "There is no other project in this organization you can read, so there is nothing to compare with."
          : `No requirement of the ${read.projects} other project${read.projects === 1 ? "" : "s"} reads like one of this project's.`}
      </div>
    );
  }
  return (
    <>
      <p className="hint">
        Compared with {read.projects} other project{read.projects === 1 ? "" : "s"}
        {read.truncated ? " (the first 40)" : ""}, by the words two statements share. Read both before deciding
        anything: a pair here is a question, not a finding.
      </p>
      <div className="card">
        <DataTable<RelatedRequirement>
          list="dm-elsewhere"
          urlPrefix="else."
          rows={orderRelated(read.items)}
          rowKey={(r) => relatedKey(r)}
          rowLabel={(r) => r.id}
          pageSize={20}
          search={{ placeholder: "Search requirements" }}
          searchText={(r) => [r.id, r.text, r.other_id, r.other_text, r.other_project_name]}
          filters={[
            {
              id: "relation",
              allLabel: "Every match",
              kind: "chips",
              options: (["opposite", "same", "overlap"] as const).map((x) => ({ value: x, label: RELATION_LABEL[x] })),
              match: (r, v) => r.relation === v,
            },
            {
              id: "project",
              allLabel: "Every project",
              kind: "select",
              options: [...new Set(read.items.map((r) => r.other_project_name))].sort().map((x) => ({ value: x, label: x })),
              match: (r, v) => r.other_project_name === v,
            },
          ]}
          empty={{ title: "Nothing matches." }}
          columns={[
            { id: "relation", header: "Match", cell: (r) => <span className={`sm-status sm-rel-${r.relation}`}>{RELATION_LABEL[r.relation]} · {Math.round(r.score * 100)}%</span> },
            { id: "ours", header: "Ours", cell: (r) => <span><code>{r.id}</code> <span className="sub">{r.text.slice(0, 90)}{r.text.length > 90 ? "…" : ""}</span></span> },
            { id: "theirs", header: "Theirs", cell: (r) => <span><code>{r.other_id}</code> <span className="sub">{r.other_project_name}</span></span> },
            {
              id: "decision",
              header: "Decision",
              cell: (r) => {
                const d = decisionOf?.(r);
                return d ? MATCH_DECISIONS.find((m) => m.state === d)?.label ?? d : <span className="sub">—</span>;
              },
            },
          ]}
          expand={(r) => (
            <div>
              <div className="sm-rel-pair">
                <div>
                  <code>{r.id}</code> <SideLink side={r.defined_in} onOpenFile={onOpenFile} />
                  <div className="sm-work-title">{r.text}</div>
                </div>
                <div>
                  <code>{r.other_id}</code>{" "}
                  <span className="sm-status">
                    {r.other_workspace_name} / {r.other_project_name}
                  </span>{" "}
                  <span className="sm-work-title">
                    {r.other_defined_in.path}:{r.other_defined_in.line_start}
                  </span>
                  <div className="sm-work-title">{r.other_text}</div>
                </div>
              </div>
              <div className="sm-req-cites">Shared: {r.shared.join(", ")}</div>
              {onDecide && (
                <div className="dm-actions">
                  {MATCH_DECISIONS.map((d) => (
                    <button
                      key={d.state}
                      type="button"
                      title={d.why}
                      className={decisionOf?.(r) === d.state ? "primary" : "ghost"}
                      aria-pressed={decisionOf?.(r) === d.state}
                      onClick={() => void onDecide(r, decisionOf?.(r) === d.state ? "proposed" : d.state)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        />
      </div>
    </>
  );
}

function Coverage({
  model,
  busy,
  onRebuild,
}: {
  model: SpecModel;
  /** A build is running or starting: no second one. */
  busy: boolean;
  /** Read one document again, replacing only its facts. */
  onRebuild: (path: string) => void;
}) {
  const counts = coverageCounts(model.documents);
  return (
    <>
      <p className="hint">
        {counts.extracted} read at their current revision, {counts.failed} read part-way, {counts.stale} changed
        since they were read, {counts.pending} never read. A build reads only what is not read at its
        revision, so an unchanged document is never paid for twice. To read one document again, whatever its
        state, rebuild from it: only its facts are replaced.
      </p>
      <div className="card">
        <DataTable<SpecModel["documents"][number]>
          list="dm-documents"
          urlPrefix="doc."
          rows={model.documents}
          rowKey={(d) => d.path}
          rowLabel={(d) => d.path}
          pageSize={20}
          search={{ placeholder: "Search documents" }}
          searchText={(d) => [d.path]}
          filters={[
            {
              id: "state",
              allLabel: "Every state",
              kind: "chips",
              options: (["extracted", "kept", "stale", "failed", "pending"] as const)
                .filter((st) => counts[st] > 0)
                .map((st) => ({ value: st, label: STATE_LABEL[st] ?? st })),
              match: (d, v) => d.state === v,
            },
          ]}
          empty={{ title: "Nothing matches." }}
          columns={[
            { id: "path", header: "Document", compare: (a, b) => a.path.localeCompare(b.path), cell: (d) => <code className="dm-where">{d.path}</code> },
            {
              id: "state",
              header: "State",
              cell: (d) => (
                <span
                  className={`sm-state sm-state-${d.state}`}
                  title={d.error ?? (d.state === "kept" ? "The repository copy is missing on the server: the last reading is shown" : undefined)}
                >
                  {d.state}
                </span>
              ),
            },
            { id: "facts", header: "Facts", num: true, compare: (a, b) => a.facts - b.facts, cell: (d) => d.facts },
            { id: "dropped", header: "Dropped", num: true, compare: (a, b) => a.dropped - b.dropped, cell: (d) => d.dropped },
          ]}
          actions={(d) => [
            { label: "Rebuild from this document", disabled: busy, onSelect: () => onRebuild(d.path) },
          ]}
        />
      </div>
    </>
  );
}
