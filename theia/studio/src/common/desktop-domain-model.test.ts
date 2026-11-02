import {
    DomainModel, DomainModelFact, DomainModelFinding, buildLine, entitiesOf, factsByKind, locatePassage, markedFindings,
    modelPathOf, orderFindings, readingOf, sideLabel, subjectKey, unreadNote,
} from './desktop-domain-model';

function fact(subject: string, kind = 'attribute', path = 'docs/a.md', status: DomainModelFact['status'] = 'active'): DomainModelFact {
    return { kind, subject, aspect: '', value: '', text: `${subject} ${kind}`, status, status_because: '', source: { path, line_start: 1 } };
}

function finding(fingerprint: string, over: Partial<DomainModelFinding> = {}): DomainModelFinding {
    return { fingerprint, rule: 'contradiction.value', severity: 'medium', message: 'm', sides: [{ path: 'docs/a.md' }], decide: [], ...over };
}

function model(over: Partial<DomainModel> = {}): DomainModel {
    return {
        build: { running: false, documents: 0, done: 0, candidates: 0, judged: 0 },
        documents: [{ path: 'docs/a.md', revision: 'abc', state: 'extracted', facts: 2, dropped: 0 }],
        facts: [],
        ...over,
    };
}

describe('subjectKey', () => {
    it('folds case, articles, punctuation and a plural s, as the backend does', () => {
        expect(subjectKey('The Orders')).toBe('order');
        expect(subjectKey('an order')).toBe('order');
        expect(subjectKey('Status')).toBe('status');
        expect(subjectKey('Access-Class')).toBe('access class');
    });
});

describe('entitiesOf', () => {
    it('meets two spellings of one thing, the most described first, needs and decision-only subjects left out', () => {
        const entities = entitiesOf([
            fact('Order'), fact('orders', 'relation'), fact('the Order', 'requirement', 'docs/b.md'),
            fact('Customer'),
            fact('Slow checkout', 'problem'),
            fact('Use Postgres', 'decision'),
        ]);
        expect(entities.map(e => e.name)).toEqual(['Order', 'Customer']);
        expect(entities[0].facts).toHaveLength(3);
        expect(entities[0].documents).toBe(2);
    });

    it('takes the glossary\'s name and folds its aliases in', () => {
        const entities = entitiesOf([fact('Client'), fact('Customer')], [
            { key: 'customer', name: 'Customer', chosen: true, spellings: [], aliases: [{ key: 'client', name: 'Client' }], facts: 2, documents: 1 },
        ]);
        expect(entities).toEqual([expect.objectContaining({ key: 'customer', name: 'Customer', active: 2 })]);
    });
});

describe('factsByKind', () => {
    it('orders an entity\'s facts as a reader wants them, skipping empty kinds', () => {
        expect(factsByKind([fact('a', 'requirement'), fact('a', 'entity'), fact('a', 'attribute')]).map(g => g.kind))
            .toEqual(['entity', 'attribute', 'requirement']);
    });
});

describe('orderFindings', () => {
    it('puts the undecided first, then high before low, disagreements before references', () => {
        const ordered = orderFindings([
            finding('dismissed', { decision: 'dismissed', severity: 'high' }),
            finding('ref', { rule: 'reference.dangling', severity: 'high' }),
            finding('low', { severity: 'low' }),
            finding('confirmed', { decision: 'confirmed', severity: 'high' }),
            finding('high', { severity: 'high' }),
        ]);
        expect(ordered.map(f => f.fingerprint)).toEqual(['high', 'ref', 'low', 'confirmed', 'dismissed']);
    });

    it('marks every finding but the dismissed ones', () => {
        expect(markedFindings([finding('a'), finding('b', { decision: 'dismissed' }), finding('c', { decision: 'confirmed' })])
            .map(f => f.fingerprint)).toEqual(['a', 'c']);
    });
});

describe('locatePassage', () => {
    const text = '# Orders\n\nAn order has one customer.\n\nLater:\nAn order has one customer.\n';

    it('finds the quote, the occurrence nearest the line it was read at winning', () => {
        expect(locatePassage(text, { path: 'a', line_start: 6, quote: 'An order has one customer.' }))
            .toEqual({ kind: 'found', start: { line: 5, character: 0 }, end: { line: 5, character: 26 } });
        expect(locatePassage(text, { path: 'a', line_start: 2, quote: 'An order has one customer.' }))
            .toEqual({ kind: 'found', start: { line: 2, character: 0 }, end: { line: 2, character: 26 } });
    });

    it('finds a quote the file wraps over two lines, and one moved by an edit above it', () => {
        const wrapped = 'intro\nAn order has\n   one customer.\n';
        expect(locatePassage(wrapped, { path: 'a', line_start: 40, quote: 'An order has one customer.' }))
            .toEqual({ kind: 'found', start: { line: 1, character: 0 }, end: { line: 2, character: 16 } });
    });

    it('says a quote no longer in the file is gone, rather than pointing at a stale line', () => {
        expect(locatePassage(text, { path: 'a', line_start: 3, quote: 'An order has many customers.' })).toEqual({ kind: 'gone' });
    });

    it('uses the lines read at when there is no quote, kept inside the file', () => {
        expect(locatePassage('one\r\ntwo\r\nthree', { path: 'a', line_start: 2, line_end: 3 }))
            .toEqual({ kind: 'lines', start: { line: 1, character: 0 }, end: { line: 2, character: 5 } });
        expect(locatePassage('one\ntwo', { path: 'a', line_start: 40 }))
            .toEqual({ kind: 'lines', start: { line: 1, character: 0 }, end: { line: 1, character: 3 } });
        expect(locatePassage('one', { path: 'a' }))
            .toEqual({ kind: 'lines', start: { line: 0, character: 0 }, end: { line: 0, character: 3 } });
    });
});

describe('the document in front', () => {
    it('is named by the first candidate path the model has read', () => {
        const documents = model().documents;
        expect(modelPathOf(['repo/docs/a.md', 'docs/a.md', 'a.md'], documents)).toBe('docs/a.md');
        expect(modelPathOf(['notes.md'], documents)).toBeUndefined();
    });

    it('reads its own facts, needs left out, and the findings with a side in it', () => {
        const m = model({ facts: [fact('Order'), fact('Order', 'problem'), fact('Other', 'attribute', 'docs/b.md')] });
        const reading = readingOf('docs/a.md', m, [
            finding('here'),
            finding('elsewhere', { sides: [{ path: 'docs/b.md' }] }),
            finding('both', { severity: 'high', sides: [{ path: 'docs/b.md' }, { path: 'docs/a.md' }] }),
        ]);
        expect(reading.document?.revision).toBe('abc');
        expect(reading.facts.map(f => f.kind)).toEqual(['attribute']);
        expect(reading.findings.map(f => f.fingerprint)).toEqual(['both', 'here']);
    });
});

describe('what the view says', () => {
    it('describes a build running, stopped and finished', () => {
        const build = { running: true, documents: 4, done: 1, candidates: 0, judged: 0, current: 'docs/a.md' };
        expect(buildLine(build)).toBe('Reading documents 1/4 · docs/a.md');
        expect(buildLine({ ...build, done: 4, candidates: 3, judged: 1 })).toBe('Checking disagreements 1/3');
        expect(buildLine({ ...build, running: false, error: 'no model key' })).toBe('Stopped: no model key');
        expect(buildLine({ ...build, running: false, done: 4, finished_at: 'now' })).toBe('Built 4 document(s), checked 0 candidate(s)');
        expect(buildLine({ ...build, running: false })).toBe('');
    });

    it('says why the model reads less than is typed', () => {
        expect(unreadNote(model())).toBeUndefined();
        expect(unreadNote(model({ documents: [] }))).toMatch(/none are typed yet/);
        expect(unreadNote(model({ unread_documents: 1, unread_because: 'the clone failed' }))).toBe('1 typed document cannot be read on the server: the clone failed.');
        expect(unreadNote(model({ unread_documents: 2 }))).toMatch(/^2 typed documents cannot be read: the server has no copy/);
    });

    it('labels a side by its lines', () => {
        expect(sideLabel({ path: 'a.md' })).toBe('a.md');
        expect(sideLabel({ path: 'a.md', line_start: 3, line_end: 3 })).toBe('a.md:3');
        expect(sideLabel({ path: 'a.md', line_start: 3, line_end: 5 })).toBe('a.md:3-5');
    });
});
