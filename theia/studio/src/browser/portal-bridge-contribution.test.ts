import 'reflect-metadata';

// The collaborators pull the editor, the workspace service and the markdown
// editor's whole widget tree behind them, none of which this is about: the
// question here is purely WHEN the bridge runs an open, not what an open does.
jest.mock('./open-in-editor-controller', () => ({
    OpenInEditorFrontendController: class OpenInEditorFrontendController {}
}));
jest.mock('./studio-document-opener', () => ({
    StudioDocumentOpener: class StudioDocumentOpener {}
}));
jest.mock('./artifact-graph-contribution', () => ({
    ArtifactGraphCommand: { id: 'studio.artifactGraph' }
}));

import * as fs from 'fs';
import * as path from 'path';
import { CommandService } from '@theia/core/lib/common';
import type { NotifyEditorFrontendController } from './notify-editor-controller';
import {
    GEARBOX_OPEN_GEAR_COMMAND_ID,
    GEARBOX_OPEN_PRODUCT_COMMAND_ID,
    IDENTITY_VIEWER_COMMAND_ID,
    OPEN_COMPONENT_IN_PORTAL_COMMAND_ID,
    PortalBridgeContribution,
    PortalViewer
} from './portal-bridge-contribution';

/**
 * The hand-off and the shell layout race, and the layout wins.
 *
 * Theia starts its contributions first and restores the layout second, and the
 * restore re-activates whichever tab was active when the session was last used.
 * The portal's message arrives during the first half, so a file opened there
 * opens correctly and is then buried under the restored view — a tab that is
 * present but not in front, which reads as "the hand-off did nothing".
 */
class TestBridge extends PortalBridgeContribution {
    requestOpen(open: () => void): void {
        this.openWhenLayoutReady(open);
    }

    notify(request: Parameters<NotifyEditorFrontendController['onNotifyEditor']>[0]): void {
        void this.notifier.onNotifyEditor(request);
    }

    adopt(viewer: PortalViewer | undefined): void {
        this.adoptPortalViewer(viewer);
    }

    useCommands(commands: CommandService): void {
        (this as unknown as { commands: CommandService }).commands = commands;
    }

    openFile(relativePath: string): Promise<void> {
        return this.openFileInMode(relativePath);
    }

    openProduct(relativePath: string, branch?: string): Promise<void> {
        return this.openProductInMode(relativePath, branch);
    }

    openComponent(name: string | undefined): boolean {
        return this.openComponentInPortal(name);
    }
}

describe('PortalBridgeContribution layout gating', () => {
    it('holds an open requested before the layout is restored, then runs it', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.requestOpen(() => opened.push('document'));
        expect(opened).toEqual([]); // the restore would bury it

        bridge.onDidInitializeLayout();
        expect(opened).toEqual(['document']);
    });

    it('keeps the portal’s order, so the last thing asked for ends up on top', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.requestOpen(() => opened.push('graph'));
        bridge.requestOpen(() => opened.push('file'));
        bridge.onDidInitializeLayout();

        expect(opened).toEqual(['graph', 'file']);
    });

    it('opens immediately once the layout is up — the common case is not delayed', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.onDidInitializeLayout();
        bridge.requestOpen(() => opened.push('file'));

        expect(opened).toEqual(['file']);
    });

    it('does not replay an open on a second layout initialization', () => {
        const bridge = new TestBridge();
        const opened: string[] = [];

        bridge.requestOpen(() => opened.push('file'));
        bridge.onDidInitializeLayout();
        bridge.onDidInitializeLayout();

        expect(opened).toEqual(['file']);
    });
});

describe('PortalBridgeContribution notifications', () => {
    it('shows a portal notification without waiting for the layout', () => {
        // The opens are held until the shell has restored, because the restore
        // would bury them. A notification moves nothing and steals no focus,
        // and holding it back would only make it arrive after the thing it is
        // about has gone stale.
        const bridge = new TestBridge();
        const shown: unknown[] = [];
        Object.defineProperty(bridge, 'notifier', {
            value: { onNotifyEditor: (request: unknown) => void shown.push(request) },
        });

        bridge.notify({ level: 'info', message: 'finished', source: 'Artifact ingest' });

        expect(shown).toEqual([
            expect.objectContaining({ message: 'finished', source: 'Artifact ingest' }),
        ]);
    });
});

/**
 * Who the session attributes writing to.
 *
 * The IDE has no login of its own and one session container is shared by
 * everybody who opens the workspace, so the portal stating the viewer is the
 * only thing that tells two authors apart. What the identity is then keyed by
 * belongs to `product-ext/test/identity.test.js`; what is here is the one thing
 * this side owns — when the hand-off happens, and when it must not.
 */
describe('PortalBridgeContribution viewer hand-off', () => {

    function bridgeWith(): { bridge: TestBridge; calls: [string, unknown[]][] } {
        const calls: [string, unknown[]][] = [];
        const bridge = new TestBridge();
        bridge.useCommands({
            executeCommand: (id: string, ...args: unknown[]) => {
                calls.push([id, args]);
                return Promise.resolve(undefined);
            }
        } as unknown as CommandService);
        return { bridge, calls };
    }

    it('forwards the viewer to the identity command', () => {
        const { bridge, calls } = bridgeWith();
        const viewer = { sub: 'sub-42', name: 'Roma', kind: 'person' };

        bridge.adopt(viewer);

        expect(calls).toEqual([[IDENTITY_VIEWER_COMMAND_ID, [viewer]]]);
    });

    it('drops a viewer with no subject rather than signing the session out', () => {
        // `studio.token` is posted on every silent renew whether or not anybody
        // is signed in. Forwarding a subject-less viewer would replace a
        // verified identity with an anonymous one mid-session.
        const { bridge, calls } = bridgeWith();

        bridge.adopt(undefined);
        bridge.adopt({});
        bridge.adopt({ name: 'Roma' });

        expect(calls).toEqual([]);
    });

    it('survives a build composed without the product extension', async () => {
        const bridge = new TestBridge();
        bridge.useCommands({
            executeCommand: () => Promise.reject(new Error('unknown command'))
        } as unknown as CommandService);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => { /* quiet */ });

        expect(() => bridge.adopt({ sub: 'sub-42' })).not.toThrow();
        await Promise.resolve(); // let the rejection settle inside the catch

        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('names the command the product extension actually registers', () => {
        // The two sides are different Theia extensions with no dependency
        // between them, so the id is a literal in each. Renaming one alone is
        // a sign-in that silently stops arriving, with nothing to compile
        // against — which is what this reads the other file for.
        const registrar = fs.readFileSync(
            path.resolve(__dirname, '../../../product-ext/src/browser/product-frontend-module.js'),
            'utf8'
        );
        expect(registrar).toContain(`id: '${IDENTITY_VIEWER_COMMAND_ID}'`);
        expect(registrar).toContain('identity.adopt(viewer)');
    });
});

describe('PortalBridgeContribution file hand-off', () => {

    function bridgeWith(active: string) {
        const bridge = new TestBridge();
        const switchPerspective = jest.fn(async () => undefined);
        const onOpenInEditor = jest.fn(async () => undefined);
        Object.assign(bridge, {
            perspectives: { getActivePerspectiveId: () => active, switchPerspective },
            opener: { onOpenInEditor }
        });
        return { bridge, switchPerspective, onOpenInEditor };
    }

    /*
     * Two editors claim a `.md` file and the ACTIVE PERSPECTIVE decides between
     * them — the studio editor at 600 in the workbench and 400 in documents,
     * the product's rich surface at 500. So the same document arrived in a
     * different editor depending on a mode the person never chose, and from
     * the portal they had no way to choose it. Asking to edit a document is
     * the request for the documents mode; `studio.openDocument` has always
     * read it that way, and this is the same sentence for a file on disk.
     */
    it('a markdown hand-off asks for the documents mode first', async () => {
        const { bridge, switchPerspective, onOpenInEditor } = bridgeWith('workbench');

        await bridge.openFile('docs/prd.md');

        expect(switchPerspective).toHaveBeenCalledWith('studio.documents');
        expect(onOpenInEditor).toHaveBeenCalledWith({ relativePath: 'docs/prd.md' });
    });

    it('leaves source code where it is', async () => {
        // Switching perspective for a `.rs` file would rearrange the workbench
        // under somebody who came to read code — and nothing arbitrates on
        // perspective for it anyway.
        const { bridge, switchPerspective, onOpenInEditor } = bridgeWith('workbench');

        await bridge.openFile('src/main.rs');

        expect(switchPerspective).not.toHaveBeenCalled();
        expect(onOpenInEditor).toHaveBeenCalledWith({ relativePath: 'src/main.rs' });
    });

    it('does not switch a mode that is already the right one', async () => {
        const { bridge, switchPerspective } = bridgeWith('studio.documents');

        await bridge.openFile('docs/prd.md');

        expect(switchPerspective).not.toHaveBeenCalled();
    });

    it('still opens the file when the perspective refuses to switch', async () => {
        // A mode that will not change is not a reason to withhold the document.
        const { bridge, onOpenInEditor } = bridgeWith('workbench');
        Object.assign(bridge, {
            perspectives: {
                getActivePerspectiveId: () => 'workbench',
                switchPerspective: jest.fn(async () => { throw new Error('no'); })
            }
        });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        await bridge.openFile('docs/prd.md');

        expect(onOpenInEditor).toHaveBeenCalled();
        warn.mockRestore();
    });
});

/**
 * A product from the portal's Components tab lands in the Gearbox perspective,
 * opened through Gearbox — or, in a build without gearbox-studio, as the file
 * it is, which is what the portal asked for before the message existed.
 */
describe('PortalBridgeContribution product hand-off', () => {
    it('asks gearbox-studio to open the product in its perspective', async () => {
        const bridge = new TestBridge();
        const calls: [string, unknown[]][] = [];
        bridge.useCommands({
            executeCommand: (id: string, ...args: unknown[]) => {
                calls.push([id, args]);
                return Promise.resolve(true);
            }
        } as unknown as CommandService);
        const onOpenInEditor = jest.fn(async () => undefined);
        Object.assign(bridge, { opener: { onOpenInEditor } });

        await bridge.openProduct('product.gdl');

        expect(calls).toEqual([[GEARBOX_OPEN_PRODUCT_COMMAND_ID, ['product.gdl', undefined]]]);
        expect(onOpenInEditor).not.toHaveBeenCalled();
    });

    it('passes on the branch the portal saved the description onto', async () => {
        const bridge = new TestBridge();
        const calls: [string, unknown[]][] = [];
        bridge.useCommands({
            executeCommand: (id: string, ...args: unknown[]) => {
                calls.push([id, args]);
                return Promise.resolve(true);
            }
        } as unknown as CommandService);

        await bridge.openProduct('product.gdl', 'product/studioweb-77a0da49');

        expect(calls).toEqual([[GEARBOX_OPEN_PRODUCT_COMMAND_ID, ['product.gdl', 'product/studioweb-77a0da49']]]);
    });

    it('opens the description as a file when gearbox-studio is not in the build', async () => {
        const bridge = new TestBridge();
        bridge.useCommands({
            executeCommand: () => Promise.reject(new Error('unknown command'))
        } as unknown as CommandService);
        const onOpenInEditor = jest.fn(async () => undefined);
        Object.assign(bridge, {
            perspectives: { getActivePerspectiveId: () => 'studio.workbench', switchPerspective: jest.fn() },
            opener: { onOpenInEditor }
        });

        await bridge.openProduct('product.gdl');

        expect(onOpenInEditor).toHaveBeenCalledWith(expect.objectContaining({ relativePath: 'product.gdl' }));
    });

    it('names the command gearbox-studio actually registers', () => {
        const registrar = fs.readFileSync(
            path.resolve(__dirname, '../../../gearbox-studio/src/browser/shell/studio-gearbox-perspective.ts'),
            'utf8'
        );
        expect(registrar).toContain(`id: "${GEARBOX_OPEN_PRODUCT_COMMAND_ID}"`);
    });

    it('names the gear command gearbox-studio actually registers, and the portal sends its message', () => {
        const registrar = fs.readFileSync(
            path.resolve(__dirname, '../../../gearbox-studio/src/browser/shell/studio-gearbox-perspective.ts'),
            'utf8'
        );
        expect(registrar).toContain(`id: "${GEARBOX_OPEN_GEAR_COMMAND_ID}"`);
        const portal = fs.readFileSync(
            path.resolve(__dirname, '../../../../studio-frontend-prototype/src/App.tsx'),
            'utf8'
        );
        expect(portal).toContain('type: "studio.openGear"');
    });
});

/**
 * From a gear in the IDE to its page in the portal's component catalogue. The
 * message goes to the origin the handshake established and nowhere else.
 */
describe('PortalBridgeContribution component link', () => {
    const embedded = (post: jest.Mock) => {
        const parent = { postMessage: post };
        Object.defineProperty(window, 'parent', { value: parent, configurable: true });
    };
    afterEach(() => {
        Object.defineProperty(window, 'parent', { value: window, configurable: true });
    });

    it('asks the portal for the component, at the portal origin', () => {
        const post = jest.fn();
        embedded(post);
        const bridge = new TestBridge();
        Object.assign(bridge, { portalOrigin: 'https://studio.example' });

        expect(bridge.openComponent('cf-gears-api-gateway')).toBe(true);
        expect(post).toHaveBeenCalledWith(
            { type: 'studio.openComponent', name: 'cf-gears-api-gateway' },
            'https://studio.example'
        );
    });

    it('says nothing before the handshake, or without a name', () => {
        const post = jest.fn();
        embedded(post);
        const bridge = new TestBridge();

        expect(bridge.openComponent('cf-gears-api-gateway')).toBe(false);
        Object.assign(bridge, { portalOrigin: 'https://studio.example' });
        expect(bridge.openComponent(undefined)).toBe(false);
        expect(post).not.toHaveBeenCalled();
    });

    it('names the command gearbox-studio actually calls', () => {
        const caller = fs.readFileSync(
            path.resolve(__dirname, '../../../gearbox-studio/src/browser/shell/portal-link.ts'),
            'utf8'
        );
        expect(caller).toContain(`"${OPEN_COMPONENT_IN_PORTAL_COMMAND_ID}"`);
    });
});

/**
 * The editor trusts only the portal the session names (#324): its own origin,
 * or the listed ones. The first portal it talks to is the only one for the
 * life of the frame, and it listens to nobody before it knows the list.
 */
describe('PortalBridgeContribution portal origins', () => {
    const OWN = window.location.origin;
    const PORTAL = 'http://localhost:5173';
    const listed = { allowedOriginsMode: 'allowlist' as const, allowedOrigins: [PORTAL, 'http://localhost:8080'] };
    const sameOrigin = { allowedOriginsMode: 'same-origin' as const, allowedOrigins: [] };

    let post: jest.Mock;
    let parent: { postMessage: jest.Mock };
    let listener: ((event: Partial<MessageEvent>) => void) | undefined;
    let shown: string[];

    beforeEach(() => {
        post = jest.fn();
        parent = { postMessage: post };
        Object.defineProperty(window, 'parent', { value: parent, configurable: true });
        listener = undefined;
        jest.spyOn(window, 'addEventListener').mockImplementation(((type: string, handler: EventListener) => {
            if (type === 'message') {
                listener = handler as unknown as typeof listener;
            }
        }) as typeof window.addEventListener);
        jest.spyOn(global, 'setInterval').mockReturnValue(0 as unknown as ReturnType<typeof setInterval>);
        shown = [];
    });
    afterEach(() => {
        Object.defineProperty(window, 'parent', { value: window, configurable: true });
        jest.restoreAllMocks();
    });

    const start = async (getSession: () => Promise<unknown>): Promise<TestBridge> => {
        const bridge = new TestBridge();
        Object.assign(bridge, {
            runtime: { getSession },
            documentResources: { onDidSaveDocument: () => ({ dispose: () => undefined }) },
            shell: { widgets: [] },
            notifier: { onNotifyEditor: (request: { message: string }) => void shown.push(request.message) },
        });
        bridge.onStart();
        await new Promise(resolve => setTimeout(resolve, 0));
        return bridge;
    };
    const send = (origin: string, data: unknown, source: unknown = parent): void =>
        listener?.({ source: source as MessageEventSource, origin, data });
    const notify = (message: string) => ({ type: 'studio.notify', message });

    it('accepts a listed portal and answers it at its own origin, never `*`', async () => {
        await start(async () => listed);
        send(PORTAL, { type: 'studio.init' });

        expect(post).toHaveBeenCalledWith({ type: 'studio.status', dirty: 0 }, PORTAL);
        expect(post.mock.calls.every(([, target]) => target === PORTAL)).toBe(true);
    });

    it('drops a message from an origin outside the list, and from `null`', async () => {
        await start(async () => listed);
        send('https://evil.example', notify('evil'));
        send('null', notify('opaque'));
        send(OWN, notify('own origin is not on the list'));

        expect(shown).toEqual([]);
        expect(post).not.toHaveBeenCalled();
    });

    it('pins the first portal: a second origin is dropped even when listed', async () => {
        await start(async () => listed);
        send(PORTAL, notify('first'));
        send('http://localhost:8080', notify('second'));

        expect(shown).toEqual(['first']);
    });

    it('drops a message from any window but the embedding one', async () => {
        await start(async () => listed);
        send(PORTAL, notify('another window'), {});

        expect(shown).toEqual([]);
    });

    it('in same-origin mode accepts only the session’s own origin', async () => {
        await start(async () => sameOrigin);
        send(PORTAL, notify('cross-origin'));
        send(OWN, notify('own'));

        expect(shown).toEqual(['own']);
    });

    it('does not listen before the list has arrived', async () => {
        let arrive: (session: unknown) => void = () => undefined;
        await start(() => new Promise(resolve => { arrive = resolve; }));
        expect(listener).toBeUndefined();

        arrive(listed);
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(listener).toBeDefined();
    });

    it('does not listen at all when the list never arrives, and says so', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        await start(async () => { throw new Error('runtime unreachable'); });

        expect(listener).toBeUndefined();
        expect(warn).toHaveBeenCalledWith('[studio] portal bridge disabled: session unavailable', expect.any(Error));
    });
});
