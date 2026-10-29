import { desktopLink, environmentFor, isCurrent, parseDesktopLink } from './desktop-link';
import { DesktopEnvironment } from './desktop-environments';

const dev: DesktopEnvironment = {
    id: 'dev',
    label: 'Dev',
    studioUrl: 'https://studio-dev.cfabric.org',
    issuer: 'https://studio-dev.cfabric.org/auth/realms/studio',
};
const local: DesktopEnvironment = {
    id: 'local',
    label: 'Local',
    studioUrl: 'http://127.0.0.1:8090',
    issuer: 'http://127.0.0.1:8088/realms/studio',
};
const PROJECT = 'd5e76267-60e3-4153-8e60-d4d8753ed01e';

describe('the desktop link', () => {
    it('reads what the portal writes', () => {
        const link = { project: PROJECT, name: 'Studioweb', studioUrl: dev.studioUrl, issuer: dev.issuer };
        expect(parseDesktopLink(desktopLink(link))).toEqual(link);
    });

    it('carries the product the portal composed, and the branch it saved it on', () => {
        const link = { project: PROJECT, name: 'Studioweb', studioUrl: dev.studioUrl, issuer: dev.issuer, product: 'product.gdl', branch: 'product/studio-web-1a2b3c4d' };
        expect(parseDesktopLink(desktopLink(link))).toEqual(link);
    });

    it('asks to build the product only with build=1, and only with a product', () => {
        const link = { project: PROJECT, product: 'product.gdl', build: true };
        expect(parseDesktopLink(desktopLink(link))).toEqual(link);
        expect(parseDesktopLink(`cfstudio://open?project=${PROJECT}&product=product.gdl&build=true`)?.build).toBeUndefined();
        expect(parseDesktopLink(`cfstudio://open?project=${PROJECT}&build=1`)?.build).toBeUndefined();
        expect(desktopLink({ project: PROJECT, build: true })).not.toContain('build');
    });

    it('drops a product path that leaves the repository, and a branch that is not one', () => {
        for (const product of ['/etc/passwd', '../product.gdl', 'a/../../b.gdl', 'a//b.gdl', 'C:\\x.gdl', 'p d.gdl']) {
            const raw = `cfstudio://open?project=${PROJECT}&product=${encodeURIComponent(product)}`;
            expect(parseDesktopLink(raw)?.product).toBeUndefined();
        }
        for (const branch of ['--upload-pack=x', 'a..b', 'with space']) {
            const raw = `cfstudio://open?project=${PROJECT}&product=product.gdl&branch=${encodeURIComponent(branch)}`;
            expect(parseDesktopLink(raw)).toMatchObject({ product: 'product.gdl', branch: undefined });
        }
    });

    it('takes the action as the host or as the path', () => {
        expect(parseDesktopLink(`cfstudio://open?project=${PROJECT}`)?.project).toBe(PROJECT);
        expect(parseDesktopLink(`cfstudio:open?project=${PROJECT}`)?.project).toBe(PROJECT);
    });

    it('acts on nothing but its own scheme, action and a project id', () => {
        expect(parseDesktopLink(`https://open?project=${PROJECT}`)).toBeUndefined();
        expect(parseDesktopLink(`cfstudio://delete?project=${PROJECT}`)).toBeUndefined();
        expect(parseDesktopLink('cfstudio://open')).toBeUndefined();
        expect(parseDesktopLink('cfstudio://open?project=../../etc')).toBeUndefined();
        expect(parseDesktopLink('not a url')).toBeUndefined();
    });

    it('drops a Studio address that is not the web', () => {
        const link = parseDesktopLink(`cfstudio://open?project=${PROJECT}&studio=file:///c:/x&issuer=javascript:alert(1)`);
        expect(link).toEqual({ project: PROJECT, name: undefined, studioUrl: undefined, issuer: undefined });
    });

    it('matches the Studio by its realm before its address', () => {
        // The portal a person clicked on is not the address the desktop signs
        // in to; the realm is the same.
        const fromPrototype = { project: PROJECT, studioUrl: 'https://studio-dev-poc.cfabric.org', issuer: `${dev.issuer}/` };
        expect(environmentFor(fromPrototype, [local, dev])).toBe(dev);
        expect(environmentFor({ project: PROJECT, studioUrl: 'http://127.0.0.1:8090/' }, [dev, local])).toBe(local);
        expect(environmentFor({ project: PROJECT, studioUrl: 'https://elsewhere.example' }, [dev, local])).toBeUndefined();
    });

    it('knows a local stand reached on another port, or as localhost', () => {
        // The portal on :8081 signing in at https://localhost:8443 is the same
        // stand as the desktop's Local, whose gateway is :8090 and realm :8088.
        const fromLocalPortal = { project: PROJECT, studioUrl: 'http://127.0.0.1:8081', issuer: 'https://localhost:8443/realms/studio' };
        expect(environmentFor(fromLocalPortal, [dev, local])).toBe(local);
        expect(isCurrent(fromLocalPortal, local)).toBe(true);
        expect(isCurrent(fromLocalPortal, dev)).toBe(false);
    });

    it('knows when the link is about the Studio in use', () => {
        expect(isCurrent({ project: PROJECT, issuer: dev.issuer }, dev)).toBe(true);
        expect(isCurrent({ project: PROJECT, issuer: dev.issuer }, local)).toBe(false);
        expect(isCurrent({ project: PROJECT }, local)).toBe(true);
        expect(isCurrent({ project: PROJECT }, undefined)).toBe(false);
    });
});
