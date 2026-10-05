import URI from '@theia/core/lib/common/uri';
import { decodeMarkdownDiffUri, encodeMarkdownDiffUri, isMarkdownUri, sideLabel, toGitUri } from './markdown-diff-uri';

describe('markdown diff uri', () => {
    it('round-trips a comparison through its uri, string form included', () => {
        const input = {
            title: 'spec.md (HEAD ↔ Working Tree)',
            left: { uri: 'git:/w/docs/spec.md?{"path":"/w/docs/spec.md","ref":"HEAD"}', label: 'HEAD' },
            right: { uri: 'file:///w/docs/spec.md', label: 'Working Tree' },
            base: 'file:///w/docs/spec.md',
        };
        const uri = encodeMarkdownDiffUri(input);
        expect(uri.scheme).toBe('studio-md-diff');
        expect(decodeMarkdownDiffUri(new URI(uri.toString()))).toEqual(input);
    });

    it('refuses a uri of another scheme', () => {
        expect(() => decodeMarkdownDiffUri(new URI('file:///a.md'))).toThrow();
    });

    it('addresses a revision the way vscode.git does, in the backend\'s own path syntax', () => {
        const linux = toGitUri(new URI('file:///workspace/docs/spec.md'), 'HEAD', false);
        expect(linux.scheme).toBe('git');
        expect(linux.path.toString()).toBe('/workspace/docs/spec.md');
        expect(JSON.parse(linux.query)).toEqual({ path: '/workspace/docs/spec.md', ref: 'HEAD' });
        // A desktop on Windows: vscode-uri's fsPath, drive letter lowered.
        const windows = toGitUri(new URI('file:///C:/Users/me/docs/spec.md'), '~', true);
        expect(JSON.parse(windows.query)).toEqual({ path: 'c:\\Users\\me\\docs\\spec.md', ref: '~' });
        // A share.
        expect(JSON.parse(toGitUri(new URI('file://server/share/a.md'), 'HEAD', true).query).path).toBe('\\\\server\\share\\a.md');
    });

    it('names a column after what it reads', () => {
        const file = new URI('file:///w/spec.md');
        expect(sideLabel(toGitUri(file, 'HEAD'))).toBe('HEAD');
        expect(sideLabel(toGitUri(file, '~'))).toBe('Index');
        expect(sideLabel(toGitUri(file, '0123456789abcdef0123456789abcdef01234567'))).toBe('0123456');
        expect(sideLabel(file)).toBe('Working Tree');
        expect(sideLabel(new URI('memory://x/1/disk.md'))).toBe('disk.md');
    });

    it('knows markdown by extension', () => {
        expect(isMarkdownUri(new URI('file:///a/B.MD'))).toBe(true);
        expect(isMarkdownUri(new URI('file:///a/b.markdown'))).toBe(true);
        expect(isMarkdownUri(new URI('file:///a/b.txt'))).toBe(false);
    });
});
