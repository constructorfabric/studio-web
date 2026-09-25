import { ANALYZE_METRIC_ORDER, AnalyzeMetric, SpecFinding, buildMetrics, latestByDetector } from './analyze-metrics';

const AT = '2026-09-24T08:00:00Z';

function only(key: AnalyzeMetric['key'], metrics: AnalyzeMetric[]): AnalyzeMetric {
    const found = metrics.find(metric => metric.key === key);
    if (!found) {
        throw new Error(`no ${key}`);
    }
    return found;
}

function finding(detector: string, reading: Partial<SpecFinding> = {}): SpecFinding {
    return { detector, subject: 'node-1', recordedAt: AT, ...reading };
}

describe('Analyze metrics', () => {
    it('always has the same five, in the same order', () => {
        expect(buildMetrics({ findings: [] }).map(metric => metric.key)).toEqual([...ANALYZE_METRIC_ORDER]);
        expect(ANALYZE_METRIC_ORDER).toEqual(['conformance', 'purpose', 'leak', 'bloat', 'traceability']);
    });

    it('says "not analysed yet" with no number for everything nobody measured', () => {
        for (const metric of buildMetrics({ findings: [] })) {
            expect(metric.analysed).toBe(false);
            expect(metric.scoreText).toBeUndefined();
            expect(metric.percent).toBeUndefined();
            expect(metric.level).toBeUndefined();
            expect(metric.recordedAt).toBeUndefined();
            expect(metric.interpretation).toMatch(/^Not analysed yet\./);
            expect(metric.ariaText).toContain('not analysed yet');
        }
    });

    it('explains a missing conformance check with the reason it is missing', () => {
        const conformance = only('conformance', buildMetrics({ findings: [], conformanceMissing: 'No type yet.' }));
        expect(conformance.interpretation).toBe('Not analysed yet. No type yet.');
    });

    describe('conformance', () => {
        const section = (title: string, present: boolean, ok: boolean, required = true) => ({ key: title.toLowerCase(), title, present, ok, required });

        it('is Good when the template says it conforms', () => {
            const metric = only('conformance', buildMetrics({
                findings: [],
                conformance: { conforms: true, sections: [section('Goals', true, true), section('Notes', false, false, false)], issues: [], checkedAt: AT },
            }));
            expect(metric).toMatchObject({ analysed: true, scoreText: '100%', percent: 100, level: 'Good', recordedAt: AT });
            expect(metric.interpretation).toContain('1 of 1 required section in place');
        });

        it('is Attention with at least half the required sections in place, and names what is missing or empty', () => {
            const metric = only('conformance', buildMetrics({
                findings: [],
                conformance: {
                    conforms: false,
                    sections: [section('Goals', true, true), section('Scope', true, true), section('Risks', false, false), section('Metrics', true, false)],
                    issues: [],
                },
            }));
            expect(metric).toMatchObject({ scoreText: '50%', level: 'Attention' });
            expect(metric.interpretation).toContain('Missing: Risks.');
            expect(metric.interpretation).toContain('Empty or too short: Metrics.');
        });

        it('is Risk below half', () => {
            const metric = only('conformance', buildMetrics({
                findings: [],
                conformance: { conforms: false, sections: [section('Goals', false, false), section('Scope', true, true), section('Risks', false, false)], issues: [] },
            }));
            expect(metric).toMatchObject({ scoreText: '33%', level: 'Risk' });
        });
    });

    describe('purpose', () => {
        it('maps the specification share to a level at 75% and 50%', () => {
            const level = (score: number) => only('purpose', buildMetrics({ findings: [finding('purpose', { score })] })).level;
            expect(level(0.9)).toBe('Good');
            expect(level(0.75)).toBe('Good');
            expect(level(0.6)).toBe('Attention');
            expect(level(0.5)).toBe('Attention');
            expect(level(0.49)).toBe('Risk');
        });

        it('names the type it reads as, from the portal\'s summary or the panel\'s details', () => {
            const fromSummary = only('purpose', buildMetrics({ findings: [finding('purpose', { score: 0.86, summary: 'purpose: adr (86% specification)' })] }));
            expect(fromSummary).toMatchObject({ scoreText: '86%', percent: 86, recordedAt: AT });
            expect(fromSummary.interpretation).toBe('Reads as adr; 86% of it is specification.');
            const fromDetails = only('purpose', buildMetrics({ findings: [finding('purpose', { score: 0.8, details: { doc_type: 'prd' } })] }));
            expect(fromDetails.interpretation).toContain('Reads as prd;');
        });

        it('asks for attention when it reads as another type than the one it is bound to', () => {
            const metric = only('purpose', buildMetrics({
                typeKey: 'prd',
                findings: [finding('purpose', { score: 0.9, details: { doc_type: 'adr' } })],
            }));
            expect(metric.level).toBe('Attention');
            expect(metric.interpretation).toContain('It is bound as prd.');
        });
    });

    describe('leak', () => {
        it('is Good within the 5% gate, Attention to 20%, Risk beyond', () => {
            const level = (score: number) => only('leak', buildMetrics({ findings: [finding('leak', { score })] })).level;
            expect(level(0)).toBe('Good');
            expect(level(0.05)).toBe('Good');
            expect(level(0.12)).toBe('Attention');
            expect(level(0.2)).toBe('Attention');
            expect(level(0.35)).toBe('Risk');
        });

        it('names the kinds it reads as, and falls back to the verdict word without a share', () => {
            const named = only('leak', buildMetrics({ findings: [finding('leak', { score: 0.3, details: { foreign_roles: ['design'] } })] }));
            expect(named.interpretation).toBe('30% reads as design.');
            expect(named.direction).toBe('lower-better');
            const bare = only('leak', buildMetrics({ findings: [finding('leak', { severity: 'clean', summary: 'leak: clean' })] }));
            expect(bare).toMatchObject({ analysed: true, level: 'Good', scoreText: undefined, interpretation: 'leak: clean.' });
        });
    });

    describe('bloat', () => {
        it('counts the documents it repeats: none Good, one Attention, two Risk', () => {
            const read = (score: number) => only('bloat', buildMetrics({ findings: [finding('bloat', { score })] }));
            expect(read(0)).toMatchObject({ level: 'Good', scoreText: '0 documents' });
            expect(read(1)).toMatchObject({ level: 'Attention', scoreText: '1 document' });
            expect(read(3)).toMatchObject({ level: 'Risk', scoreText: '3 documents' });
            expect(read(3).percent).toBeUndefined();
        });

        it('names them when the finding kept them', () => {
            const metric = only('bloat', buildMetrics({ findings: [finding('bloat', { score: 1, details: { repeats: ['docs/adr/0001-x.md'] } })] }));
            expect(metric.interpretation).toBe('Shares text with 0001-x.md.');
        });
    });

    describe('traceability', () => {
        it('counts links both ways when the panel recorded both', () => {
            const metric = only('traceability', buildMetrics({
                findings: [finding('traceability', { score: 1, details: { references: ['docs/adr.md'], referenced_by: ['docs/plan.md', 'docs/prd.md'] } })],
            }));
            expect(metric).toMatchObject({ level: 'Good', scoreText: '3 links' });
            expect(metric.interpretation).toBe('References adr.md. Referenced by plan.md, prd.md.');
        });

        it('is Attention, not Risk, for a document linked to nothing', () => {
            const metric = only('traceability', buildMetrics({ findings: [finding('traceability', { score: 0, details: { references: [], referenced_by: [] } })] }));
            expect(metric).toMatchObject({ level: 'Attention', scoreText: '0 links' });
        });

        it('says who references it is unknown for a finding the portal wrote', () => {
            const metric = only('traceability', buildMetrics({ findings: [finding('traceability', { score: 2, summary: 'traceability: references a.md, b.md' })] }));
            expect(metric).toMatchObject({ level: 'Good', scoreText: '2 links' });
            expect(metric.interpretation).toContain('Who references it was not recorded.');
        });
    });

    it('reads the newest finding when a detector has two', () => {
        const latest = latestByDetector([
            finding('leak', { score: 0.4, recordedAt: '2026-09-01T00:00:00Z' }),
            finding('leak', { score: 0.01, recordedAt: '2026-09-20T00:00:00Z' }),
        ]);
        expect(latest.get('leak')?.score).toBe(0.01);
    });
});
