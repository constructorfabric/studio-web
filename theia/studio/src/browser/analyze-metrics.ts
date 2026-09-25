// What the Analyze panel says about a document, read out of what Studio has
// recorded about it.
//
// Two sources, and neither is computed here. Conformance is the document
// type's template check, which the documents gear keeps on a repository file's
// binding and answers on request for a document written in Studio. The other
// four are Spec Quality findings: `spec_finding` nodes in the artifact graph,
// one per detector per document, written by whoever last ran that detector —
// the portal's Specs tab or this panel. This module only reads them, and
// decides how good or bad each reading is.
//
// The thresholds are the product's, not the detector's: a detector reports a
// share or a list, and "is 30% foreign content a problem" is a judgement. They
// are gathered in `ANALYZE_THRESHOLDS` so the judgement is written down once,
// next to the reason for each number.
//
// A metric nobody has measured says so. It never shows a number: an invented
// 0% reads as a verdict about the document, when it is a fact about the
// panel.

export type AnalyzeMetricKey = 'conformance' | 'purpose' | 'leak' | 'bloat' | 'traceability';
export type AnalyzeMetricLevel = 'Good' | 'Attention' | 'Risk';
export type AnalyzeMetricDirection = 'higher-better' | 'lower-better';

/** One detector's verdict on one document, as the artifact graph keeps it. */
export interface SpecFinding {
    readonly detector: string;
    /** The document node it is about: a file node id, or `studio-doc:<id>`. */
    readonly subject: string;
    readonly path?: string;
    /** The detector's own word for how it went (`gate-passed`, `clean`, `high`…). */
    readonly severity?: string;
    readonly summary?: string;
    /** Whatever number the detector reports: a share for purpose and leak, a
     *  count for bloat and traceability. */
    readonly score?: number;
    /** The structured result, when the writer kept one. The portal does not;
     *  this panel does, so the fields below are optional readings of it. */
    readonly details?: Record<string, unknown>;
    /** When the run that produced it was recorded. */
    readonly recordedAt?: string;
}

/** A template check: which sections are there and whether the whole conforms. */
export interface ConformanceReport {
    readonly conforms: boolean;
    readonly sections: readonly {
        readonly key: string;
        readonly title: string;
        readonly present: boolean;
        readonly required: boolean;
        readonly ok: boolean;
        readonly word_count?: number;
    }[];
    readonly issues: readonly string[];
    /** When this check was made. */
    readonly checkedAt?: string;
}

export interface AnalyzeMetric {
    readonly key: AnalyzeMetricKey;
    readonly label: string;
    /** What the metric means, whatever the document scores. */
    readonly definition: string;
    readonly direction: AnalyzeMetricDirection;
    /** False until something has measured it; then there is no score. */
    readonly analysed: boolean;
    /** The reading as a person reads it: `86%`, `2 documents`. */
    readonly scoreText?: string;
    /** 0–100 for a metric that is a share, for its gauge. */
    readonly percent?: number;
    readonly level?: AnalyzeMetricLevel;
    /** What this reading says about this document. */
    readonly interpretation: string;
    readonly recordedAt?: string;
    readonly ariaText: string;
}

/**
 * Where each level starts. Shares are 0–1, as the detectors report them.
 *
 * - purpose: `specShare` is how much of the text read as specification. Below
 *   0.5 the detector recognised too little for the type it named to mean
 *   anything — the portal's `MIN_SPEC_SHARE`, measured against documents of
 *   known kind — so that is Risk; 0.75 and up is a document that is mostly
 *   what it claims to be.
 * - leak: `foreignShare` is how much reads as belonging to another kind. 0.05
 *   is the gate the run itself asks the detector to apply (`gate_threshold`
 *   in `studio-backend/src/documents/quality.rs`), so passing the gate is Good;
 *   past 0.2 a fifth of the document is somebody else's.
 * - bloat: a count of other documents this one shares text with. One is worth
 *   a look; two or more is a document repeating the set.
 * - traceability: links to or from other documents. None is Attention, never
 *   Risk — a glossary that cites nothing is doing its job.
 * - conformance: the template's own verdict decides Good. Short of it, the
 *   share of required sections that are present and filled decides between
 *   Attention (at least half) and Risk.
 */
export const ANALYZE_THRESHOLDS = {
    purpose: { good: 0.75, attention: 0.5 },
    leak: { good: 0.05, attention: 0.2 },
    bloat: { attention: 1, risk: 2 },
    conformance: { attention: 0.5 },
} as const;

const DEFINITIONS: Record<AnalyzeMetricKey, { label: string; direction: AnalyzeMetricDirection; definition: string }> = {
    conformance: {
        label: 'Conformance',
        direction: 'higher-better',
        definition: 'Required sections of the document type\'s template that are present and filled.',
    },
    purpose: {
        label: 'Purpose',
        direction: 'higher-better',
        definition: 'Which document type the text reads as, and how much of it reads as specification.',
    },
    leak: {
        label: 'Leak',
        direction: 'lower-better',
        definition: 'Share of the text that belongs to another kind of document than its type.',
    },
    bloat: {
        label: 'Bloat',
        direction: 'lower-better',
        definition: 'Other documents in the project this one repeats text from.',
    },
    traceability: {
        label: 'Traceability',
        direction: 'higher-better',
        definition: 'References from this document to others in the project, and from them to it.',
    },
};

export const ANALYZE_METRIC_ORDER: readonly AnalyzeMetricKey[] = ['conformance', 'purpose', 'leak', 'bloat', 'traceability'];

/** Everything known about one document, turned into the panel's five metrics. */
export function buildMetrics(input: {
    readonly conformance?: ConformanceReport;
    /** Why there is no conformance, when there is none: an untyped file has no template. */
    readonly conformanceMissing?: string;
    readonly findings: readonly SpecFinding[];
    /** The type the document is bound to, to compare with the type it reads as. */
    readonly typeKey?: string;
}): AnalyzeMetric[] {
    const latest = latestByDetector(input.findings);
    return ANALYZE_METRIC_ORDER.map(key => {
        switch (key) {
            case 'conformance':
                return conformanceMetric(input.conformance, input.conformanceMissing);
            case 'purpose':
                return purposeMetric(latest.get('purpose'), input.typeKey);
            case 'leak':
                return leakMetric(latest.get('leak'));
            case 'bloat':
                return bloatMetric(latest.get('bloat'));
            case 'traceability':
            default:
                return traceabilityMetric(latest.get('traceability'));
        }
    });
}

/** One finding per detector: the graph upserts on (detector, subject), but a
 *  reader should not depend on it, so the newest wins if there are two. */
export function latestByDetector(findings: readonly SpecFinding[]): Map<string, SpecFinding> {
    const out = new Map<string, SpecFinding>();
    for (const finding of findings) {
        const held = out.get(finding.detector);
        if (!held || (finding.recordedAt ?? '') > (held.recordedAt ?? '')) {
            out.set(finding.detector, finding);
        }
    }
    return out;
}

function conformanceMetric(report: ConformanceReport | undefined, missing: string | undefined): AnalyzeMetric {
    if (!report) {
        return notAnalysed('conformance', missing);
    }
    const required = report.sections.filter(section => section.required);
    const ok = required.filter(section => section.ok);
    const share = required.length === 0 ? (report.conforms ? 1 : 0) : ok.length / required.length;
    const level: AnalyzeMetricLevel = report.conforms
        ? 'Good'
        : share >= ANALYZE_THRESHOLDS.conformance.attention ? 'Attention' : 'Risk';
    const absent = required.filter(section => !section.present).map(section => section.title);
    const thin = required.filter(section => section.present && !section.ok).map(section => section.title);
    const parts: string[] = [];
    if (report.conforms) {
        parts.push('Conforms to its template.');
    } else {
        parts.push('Does not conform to its template.');
    }
    if (required.length > 0) {
        parts.push(`${ok.length} of ${required.length} required section${required.length === 1 ? '' : 's'} in place.`);
    }
    if (absent.length > 0) {
        parts.push(`Missing: ${absent.join(', ')}.`);
    }
    if (thin.length > 0) {
        parts.push(`Empty or too short: ${thin.join(', ')}.`);
    }
    return metric('conformance', {
        percent: Math.round(share * 100),
        scoreText: `${Math.round(share * 100)}%`,
        level,
        interpretation: parts.join(' '),
        recordedAt: report.checkedAt,
    });
}

function purposeMetric(finding: SpecFinding | undefined, typeKey: string | undefined): AnalyzeMetric {
    if (!finding) {
        return notAnalysed('purpose');
    }
    const share = shareOf(finding.score ?? numberIn(finding.details, 'spec_share'));
    const docType = stringIn(finding.details, 'doc_type') ?? purposeTypeFromSummary(finding.summary);
    if (share === undefined) {
        return metric('purpose', {
            interpretation: finding.summary ? sentence(finding.summary) : 'Analysed, but the result carried no share to judge.',
            recordedAt: finding.recordedAt,
        });
    }
    let level: AnalyzeMetricLevel = share >= ANALYZE_THRESHOLDS.purpose.good
        ? 'Good'
        : share >= ANALYZE_THRESHOLDS.purpose.attention ? 'Attention' : 'Risk';
    const parts: string[] = [];
    if (share < ANALYZE_THRESHOLDS.purpose.attention) {
        parts.push(`Only ${pct(share)} reads as specification — too little for a type to mean anything.`);
    } else {
        parts.push(docType
            ? `Reads as ${docType}; ${pct(share)} of it is specification.`
            : `${pct(share)} of it is specification.`);
    }
    // A document bound to one type that reads as another is worth a look
    // however much of it is specification: one of the two is wrong.
    if (docType && typeKey && docType !== typeKey && share >= ANALYZE_THRESHOLDS.purpose.attention) {
        parts.push(`It is bound as ${typeKey}.`);
        if (level === 'Good') {
            level = 'Attention';
        }
    }
    return metric('purpose', {
        percent: Math.round(share * 100),
        scoreText: pct(share),
        level,
        interpretation: parts.join(' '),
        recordedAt: finding.recordedAt,
    });
}

function leakMetric(finding: SpecFinding | undefined): AnalyzeMetric {
    if (!finding) {
        return notAnalysed('leak');
    }
    const share = shareOf(finding.score ?? numberIn(finding.details, 'leak_share'));
    const roles = stringsIn(finding.details, 'foreign_roles');
    if (share === undefined) {
        // No share, but the detector may still have said pass or fail.
        const level: AnalyzeMetricLevel | undefined = finding.severity === 'clean'
            ? 'Good'
            : finding.severity === 'high' ? 'Risk' : undefined;
        return metric('leak', {
            level,
            interpretation: finding.summary ? sentence(finding.summary) : 'Analysed, but the detector gave no verdict.',
            recordedAt: finding.recordedAt,
        });
    }
    const level: AnalyzeMetricLevel = share <= ANALYZE_THRESHOLDS.leak.good
        ? 'Good'
        : share <= ANALYZE_THRESHOLDS.leak.attention ? 'Attention' : 'Risk';
    const interpretation = level === 'Good'
        ? `${pct(share)} reads as another kind of document — within the gate.`
        : `${pct(share)} reads as ${roles.length > 0 ? roles.join(', ') : 'another kind of document'}.`;
    return metric('leak', {
        percent: Math.round(share * 100),
        scoreText: pct(share),
        level,
        interpretation,
        recordedAt: finding.recordedAt,
    });
}

function bloatMetric(finding: SpecFinding | undefined): AnalyzeMetric {
    if (!finding) {
        return notAnalysed('bloat');
    }
    const repeats = stringsIn(finding.details, 'repeats');
    const count = finding.score ?? (repeats.length > 0 ? repeats.length : undefined);
    if (count === undefined) {
        return metric('bloat', {
            interpretation: finding.summary ? sentence(finding.summary) : 'Analysed, but the result carried no count.',
            recordedAt: finding.recordedAt,
        });
    }
    const level: AnalyzeMetricLevel = count >= ANALYZE_THRESHOLDS.bloat.risk
        ? 'Risk'
        : count >= ANALYZE_THRESHOLDS.bloat.attention ? 'Attention' : 'Good';
    const named = repeats.length > 0 ? repeats.map(basename).join(', ') : undefined;
    const interpretation = count === 0
        ? 'Repeats nothing another document in the project already says.'
        : `Shares text with ${named ?? `${count} other document${count === 1 ? '' : 's'}`}.`;
    return metric('bloat', {
        scoreText: documents(count),
        level,
        interpretation,
        recordedAt: finding.recordedAt,
    });
}

function traceabilityMetric(finding: SpecFinding | undefined): AnalyzeMetric {
    if (!finding) {
        return notAnalysed('traceability');
    }
    const references = stringsIn(finding.details, 'references');
    const referencedBy = finding.details && Array.isArray(finding.details.referenced_by)
        ? stringsIn(finding.details, 'referenced_by')
        : undefined;
    const outgoing = references.length > 0 ? references.length : finding.score;
    if (outgoing === undefined) {
        return metric('traceability', {
            interpretation: finding.summary ? sentence(finding.summary) : 'Analysed, but the result carried no references.',
            recordedAt: finding.recordedAt,
        });
    }
    const links = outgoing + (referencedBy?.length ?? 0);
    const level: AnalyzeMetricLevel = links > 0 ? 'Good' : 'Attention';
    const parts: string[] = [];
    parts.push(outgoing === 0
        ? 'References no other document in the project.'
        : `References ${references.length > 0 ? references.map(basename).join(', ') : documents(outgoing)}.`);
    if (referencedBy === undefined) {
        // Only this panel's runs keep the reverse direction; the portal's
        // finding carries what the document cites, not what cites it.
        parts.push('Who references it was not recorded.');
    } else if (referencedBy.length === 0) {
        parts.push('Nothing references it.');
    } else {
        parts.push(`Referenced by ${referencedBy.map(basename).join(', ')}.`);
    }
    return metric('traceability', {
        scoreText: `${links} link${links === 1 ? '' : 's'}`,
        level,
        interpretation: parts.join(' '),
        recordedAt: finding.recordedAt,
    });
}

/** No reading. Always says so in the same words first, whatever else it
 *  adds, so "not analysed yet" is one thing a person learns to recognise. */
function notAnalysed(key: AnalyzeMetricKey, why?: string): AnalyzeMetric {
    return metric(key, { analysed: false, interpretation: why ? `Not analysed yet. ${why}` : 'Not analysed yet.' });
}

function metric(key: AnalyzeMetricKey, reading: {
    readonly analysed?: boolean;
    readonly scoreText?: string;
    readonly percent?: number;
    readonly level?: AnalyzeMetricLevel;
    readonly interpretation: string;
    readonly recordedAt?: string;
}): AnalyzeMetric {
    const definition = DEFINITIONS[key];
    const analysed = reading.analysed ?? true;
    const value = reading.scoreText
        ? `${reading.scoreText}${reading.level ? ` (${reading.level})` : ''}`
        : analysed ? 'no score' : 'not analysed yet';
    return {
        key,
        label: definition.label,
        definition: definition.definition,
        direction: definition.direction,
        analysed,
        scoreText: reading.scoreText,
        percent: reading.percent,
        level: reading.level,
        interpretation: reading.interpretation,
        recordedAt: reading.recordedAt,
        ariaText: `${definition.label}: ${value}. ${definition.direction === 'higher-better' ? 'Higher is better.' : 'Lower is better.'} `
            + `${definition.definition} ${reading.interpretation}`,
    };
}

/** "purpose: adr (86% specification)" — the portal's summary, which is all a
 *  portal-written finding says about the type. */
function purposeTypeFromSummary(summary: string | undefined): string | undefined {
    const match = summary?.match(/^purpose:\s*(\S+)\s*\(/);
    return match?.[1];
}

function shareOf(value: number | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined;
}

function numberIn(details: Record<string, unknown> | undefined, key: string): number | undefined {
    const value = details?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringIn(details: Record<string, unknown> | undefined, key: string): string | undefined {
    const value = details?.[key];
    return typeof value === 'string' && value ? value : undefined;
}

function stringsIn(details: Record<string, unknown> | undefined, key: string): string[] {
    const value = details?.[key];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function pct(share: number): string {
    return `${Math.round(share * 100)}%`;
}

function documents(count: number): string {
    return `${count} document${count === 1 ? '' : 's'}`;
}

function basename(path: string): string {
    return path.split('/').pop() || path;
}

function sentence(text: string): string {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
