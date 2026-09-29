// The question Studio asks once about adding projects to the member's Orca,
// and what each answer leaves behind (#497).

import {
    addProjectQuestion,
    applyAnswer,
    decideOnOpen,
    keptMessage,
    readAddProjectsPreference
} from './desktop-orca-projects';

describe('adding an opened project to Orca', () => {

    it('asks when the member has not answered and Orca does not know the project', () => {
        expect(decideOnOpen('ask', ['/p/web'], false)).toBe('ask');
    });

    it('does not ask again for a project the member said "not now" for', () => {
        expect(decideOnOpen('ask', ['/p/web'], true)).toBe('nothing');
    });

    it('adds without asking once the answer is "always"', () => {
        expect(decideOnOpen('always', ['/p/web'], false)).toBe('add');
        // "Not now" for one project does not outweigh a later "always".
        expect(decideOnOpen('always', ['/p/web'], true)).toBe('add');
    });

    it('never asks or adds after "never"', () => {
        expect(decideOnOpen('never', ['/p/web'], false)).toBe('nothing');
    });

    it('has nothing to do when Orca knows every repository, or the project has none', () => {
        expect(decideOnOpen('ask', [], false)).toBe('nothing');
        expect(decideOnOpen('always', [], false)).toBe('nothing');
    });
});

describe('the answers', () => {

    it('"always" is remembered and adds now', () => {
        expect(applyAnswer('always')).toEqual({ preference: 'always', add: true, dismiss: false });
    });

    it('"never" is remembered and adds nothing', () => {
        expect(applyAnswer('never')).toEqual({ preference: 'never', add: false, dismiss: true });
    });

    it('"not now" is not remembered, only this project is left alone', () => {
        expect(applyAnswer('notNow')).toEqual({ add: false, dismiss: true });
    });

    it('a prompt closed without an answer counts as "not now"', () => {
        expect(applyAnswer(undefined)).toEqual({ add: false, dismiss: true });
    });

    it('state machine: ask → not now → (reload) ask → always → add from then on', () => {
        let preference = readAddProjectsPreference(undefined);
        const dismissed = new Set<string>();
        const open = (root: string) => decideOnOpen(preference, [`${root}/repo`], dismissed.has(root));

        expect(open('/a')).toBe('ask');
        let effect = applyAnswer('notNow');
        if (effect.dismiss) {
            dismissed.add('/a');
        }
        expect(open('/a')).toBe('nothing');
        expect(open('/b')).toBe('ask');

        dismissed.clear(); // the window reloads
        expect(open('/a')).toBe('ask');
        effect = applyAnswer('always');
        preference = effect.preference ?? preference;
        expect(effect.add).toBe(true);
        expect(open('/b')).toBe('add');
        expect(open('/c')).toBe('add');
    });
});

describe('the words', () => {

    it('reads an unset or unknown preference as "ask"', () => {
        expect(readAddProjectsPreference(undefined)).toBe('ask');
        expect(readAddProjectsPreference('sometimes')).toBe('ask');
        expect(readAddProjectsPreference('never')).toBe('never');
    });

    it('names the repository, and where to change the answer', () => {
        const one = addProjectQuestion(['C:\\Users\\m\\ConstructorStudio\\workspaces\\p\\web']);
        expect(one).toContain('its repository web');
        expect(one).toContain('studio.orca.addOpenedProjects');
        expect(one).toContain('removes what it added');
        expect(addProjectQuestion(['/a', '/b'])).toContain('its 2 repositories');
    });

    it('says why a repository was left in Orca', () => {
        expect(keptMessage({ path: '/p/web', reason: 'claude is still running in fix/x' }))
            .toContain('web to Orca for a project that is closed now, and left it there: claude is still running in fix/x');
    });
});
