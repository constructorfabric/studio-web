import 'reflect-metadata';
jest.mock('./desktop-domain-model-controller', () => ({
    DesktopDomainModelController: class DesktopDomainModelController {},
    sideKey: (side: { path: string; line_start?: number | null; quote?: string | null }) => `${side.path}|${side.line_start ?? ''}|${side.quote ?? ''}`,
}));
import * as React from '@theia/core/shared/react';
import { Container } from '@theia/core/shared/inversify';
import { MessageLoop } from '@theia/core/shared/@lumino/messaging';
import { Emitter } from '@theia/core/lib/common';
import { DesktopDomainModelController, DomainModelState } from './desktop-domain-model-controller';
import { DesktopDomainModelWidget } from './desktop-domain-model-widget';
import type { DomainModel, DomainModelFinding } from '../common/desktop-domain-model';

const MODEL: DomainModel = {
    build: { running: false, documents: 1, done: 1, candidates: 0, judged: 0, finished_at: 'now' },
    documents: [{ path: 'docs/orders.md', revision: 'abc1234567', state: 'extracted', facts: 2, dropped: 0 }],
    facts: [
        { kind: 'attribute', subject: 'Order', aspect: 'total', value: '', text: 'An order has a total.', status: 'active', status_because: '', source: { path: 'docs/orders.md', line_start: 4, quote: 'An order has a total.' } },
        { kind: 'requirement', subject: 'Customer', aspect: '', value: '', text: 'A customer signs in.', status: 'deferred', status_because: 'later', source: { path: 'docs/people.md', line_start: 2 } },
    ],
};

const FINDING: DomainModelFinding = {
    fingerprint: 'f1', rule: 'contradiction.value', severity: 'high', message: 'One customer or many?',
    sides: [{ path: 'docs/orders.md', line_start: 1, quote: 'An order has one customer.' }, { path: 'docs/pay.md', line_start: 9, quote: 'many' }],
    decide: ['How many customers may an order have?'],
};

function ready(over: Partial<DomainModelState> = {}): DomainModelState {
    return {
        status: 'ready', projectId: 'p', workspaceId: 'ws', model: MODEL, findings: [FINDING], glossary: [],
        current: { uri: 'file:///w/docs/orders.md', label: 'orders.md', modelPath: 'docs/orders.md' },
        passages: new Map([['docs/pay.md|9|many', 'gone']]),
        ...over,
    };
}

function createController(initial: DomainModelState) {
    const emitter = new Emitter<void>();
    let state = initial;
    return {
        onDidChange: emitter.event,
        getState: () => state,
        refresh: jest.fn(async () => undefined),
        build: jest.fn(async () => undefined),
        decide: jest.fn(async () => undefined),
        openSide: jest.fn(async () => undefined),
        setState(next: DomainModelState) {
            state = next;
            emitter.fire();
        },
    };
}

type Controller = ReturnType<typeof createController>;

describe('DesktopDomainModelWidget', () => {
    const act = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    let widgets: DesktopDomainModelWidget[] = [];

    beforeAll(() => { act.IS_REACT_ACT_ENVIRONMENT = true; });
    afterEach(() => {
        widgets.forEach(widget => React.act(() => { widget.node.remove(); widget.dispose(); MessageLoop.flush(); }));
        widgets = [];
    });

    function mount(controller: Controller): DesktopDomainModelWidget {
        const container = new Container();
        container.bind(DesktopDomainModelWidget).toSelf();
        container.bind(DesktopDomainModelController).toConstantValue(controller as never);
        let widget!: DesktopDomainModelWidget;
        React.act(() => {
            widget = container.get(DesktopDomainModelWidget);
            document.body.appendChild(widget.node);
            widget.update();
            MessageLoop.flush();
        });
        widgets.push(widget);
        return widget;
    }

    function click(widget: DesktopDomainModelWidget, selector: string, index = 0): void {
        React.act(() => {
            (widget.node.querySelectorAll(selector)[index] as HTMLElement).click();
            MessageLoop.flush();
        });
    }

    const text = (widget: DesktopDomainModelWidget, selector: string) => widget.node.querySelector(selector)?.textContent ?? '';

    it('shows the document in front first: its findings, and what the model reads in it', () => {
        const widget = mount(createController(ready()));
        expect(text(widget, '[data-testid="domain-model-document"]')).toContain('docs/orders.md · read at abc12345 · 2 fact(s)');
        expect(widget.node.querySelectorAll('[data-testid="domain-model-finding"]')).toHaveLength(1);
        expect(text(widget, '[data-testid="domain-model-document"]')).toContain('An order has a total.');
        expect(text(widget, '[data-testid="domain-model-document"]')).not.toContain('A customer signs in.');
        expect(text(widget, '[data-testid="domain-model-tab-document"]')).toBe('This document (1)');
        expect(text(widget, '[data-testid="domain-model-build"]')).toBe('Built 1 document(s), checked 0 candidate(s)');
    });

    it('says a side edited here since the model read it', () => {
        const widget = mount(createController(ready()));
        expect(widget.node.querySelectorAll('[data-testid="domain-model-gone"]')).toHaveLength(1);
    });

    it('opens a passage, decides a finding, and builds the model or the document again', () => {
        const controller = createController(ready());
        const widget = mount(controller);
        click(widget, '[data-testid="domain-model-side"]', 1);
        expect(controller.openSide).toHaveBeenCalledWith(FINDING.sides[1]);
        click(widget, '[data-testid="domain-model-dismiss"]');
        expect(controller.decide).toHaveBeenCalledWith(FINDING, 'dismissed');
        click(widget, '[data-testid="domain-model-read-document"]');
        expect(controller.build).toHaveBeenCalledWith('docs/orders.md');
        click(widget, '[data-testid="domain-model-build-button"]');
        expect(controller.build).toHaveBeenLastCalledWith();
    });

    it('cannot decide a finding twice the same way, nor build while a build runs', () => {
        const widget = mount(createController(ready({
            findings: [{ ...FINDING, decision: 'confirmed' }],
            model: { ...MODEL, build: { ...MODEL.build, running: true } },
        })));
        expect((widget.node.querySelector('[data-testid="domain-model-confirm"]') as HTMLButtonElement).disabled).toBe(true);
        expect((widget.node.querySelector('[data-testid="domain-model-build-button"]') as HTMLButtonElement).disabled).toBe(true);
        expect(text(widget, '[data-testid="domain-model-build-button"]')).toBe('Building…');
    });

    it('says when the document in front is not one the model has read', () => {
        const widget = mount(createController(ready({ current: { uri: 'file:///w/notes.md', label: 'notes.md' } })));
        expect(text(widget, '[data-testid="domain-model-not-read"]')).toMatch(/has not read notes\.md/);
        expect(widget.node.querySelector('[data-testid="domain-model-read-document"]')).toBeNull();
    });

    it('lists every finding under To resolve, and the entities with their facts', () => {
        const widget = mount(createController(ready({ current: undefined })));
        click(widget, '[data-testid="domain-model-tab-resolve"]');
        expect(text(widget, '[data-testid="domain-model-findings"]')).toContain('How many customers may an order have?');
        click(widget, '[data-testid="domain-model-tab-entities"]');
        expect([...widget.node.querySelectorAll('[data-testid="domain-model-entity"]')].map(e => e.textContent)).toEqual([
            'Customer 1 fact(s) in 1 document(s)',
            'Order 1 fact(s) in 1 document(s)',
        ]);
        click(widget, '[data-testid="domain-model-entity"]');
        expect(text(widget, '[data-testid="domain-model-entities"]')).toContain('A customer signs in.');
        expect(text(widget, '[data-testid="domain-model-entities"]')).toContain('deferred');
    });

    it('shows the glossary', () => {
        const widget = mount(createController(ready({
            glossary: [{ key: 'customer', name: 'Customer', chosen: true, spellings: ['Customer', 'customers'], aliases: [{ key: 'client', name: 'Client' }], facts: 3, documents: 2 }],
        })));
        click(widget, '[data-testid="domain-model-tab-glossary"]');
        expect(text(widget, '[data-testid="domain-model-glossary"]')).toContain('Client, customers');
    });

    it('says when no project is open, or what failed', () => {
        expect(text(mount(createController({ status: 'no-project', findings: [], glossary: [] })), '[data-testid="domain-model-no-project"]'))
            .toMatch(/Open a Constructor Studio project/);
        expect(widgets[widgets.length - 1].node.querySelector('[data-testid="domain-model-build-button"]')).toBeNull();
        expect(text(mount(createController({ status: 'error', error: 'Sign in first.', findings: [], glossary: [] })), '[data-testid="domain-model-error"]'))
            .toBe('Sign in first.');
    });

    it('follows the controller', () => {
        const controller = createController({ status: 'loading', findings: [], glossary: [] });
        const widget = mount(controller);
        React.act(() => { controller.setState(ready()); MessageLoop.flush(); });
        expect(widget.node.querySelector('[data-testid="domain-model-document"]')).not.toBeNull();
    });
});
