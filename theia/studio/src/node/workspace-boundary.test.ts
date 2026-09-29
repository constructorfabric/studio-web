import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import URI from '@theia/core/lib/common/uri';
import { WorkspaceBoundary } from './workspace-boundary';
import { type StudioRuntimeConfig } from './studio-runtime-config';

describe('workspace boundary', () => {
    let tempDir: string;
    let repoRoot: string;
    let config: StudioRuntimeConfig;
    let boundary: WorkspaceBoundary;

    beforeEach(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-boundary-'));
        repoRoot = path.join(tempDir, 'repo');
        await fs.mkdir(repoRoot);
        await fs.mkdir(path.join(repoRoot, 'nested'));
        await fs.writeFile(path.join(repoRoot, 'nested', 'file.txt'), 'ok');
        config = {
            actorId: 'actor-1',
            workspaceId: 'workspace-1',
            workspaceRoot: repoRoot,
            repositoryRoot: repoRoot,
            dataDir: path.join(tempDir, 'studio-data'),
            allowedOriginsMode: 'same-origin',
            allowedOrigins: [],
            git: { mode: 'disabled' },
            secrets: {}
        };
        boundary = new WorkspaceBoundary();
        await boundary.initialize(config);
    });

    afterEach(async () => {
        await fs.rm(tempDir, { recursive: true, force: true });
    });

    it('rejects absolute paths', async () => {
        await expect(boundary.resolveWorkspacePath({
            relativePath: path.join(repoRoot, 'nested', 'file.txt'),
            requireExists: true
        })).rejects.toThrow('Absolute workspace paths');
    });

    it('rejects traversal outside the root', async () => {
        await expect(boundary.resolveWorkspacePath({
            relativePath: '../outside.txt',
            requireExists: false
        })).rejects.toThrow('Path traversal');
    });

    it('rejects symlink escapes', async () => {
        const outside = path.join(tempDir, 'outside');
        await fs.mkdir(outside);
        await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
        await fs.symlink(outside, path.join(repoRoot, 'nested', 'escape'));

        await expect(boundary.resolveWorkspacePath({
            relativePath: 'nested/escape/secret.txt',
            requireExists: true
        })).rejects.toThrow('escapes the configured workspace root');
    });

    it('rejects fixed-workspace mismatch in backend-only context checks', () => {
        expect(() => boundary.assertWorkspaceId('workspace-2')).toThrow('Workspace mismatch');
    });

    it('returns a workspace-relative DTO for in-root files', async () => {
        await expect(boundary.resolveWorkspacePath({
            relativePath: 'nested/file.txt',
            requireExists: true
        })).resolves.toEqual({
            workspaceId: 'workspace-1',
            relativePath: 'nested/file.txt',
            repositoryRelativePath: 'nested/file.txt',
            exists: true,
            isDirectory: false
        });
    });

    it('canonicalizes an in-root file resource URI before deriving its workspace-relative path', async () => {
        await expect(boundary.resolveWorkspacePath({
            resourceUri: URI.fromFilePath(path.join(repoRoot, 'nested', 'file.txt')).toString(),
            requireExists: true
        })).resolves.toEqual({
            workspaceId: 'workspace-1',
            relativePath: 'nested/file.txt',
            repositoryRelativePath: 'nested/file.txt',
            exists: true,
            isDirectory: false
        });
    });

    it('rejects resource URIs outside the fixed workspace', async () => {
        const outside = path.join(tempDir, 'outside.txt');
        await fs.writeFile(outside, 'outside');

        await expect(boundary.resolveWorkspacePath({
            resourceUri: URI.fromFilePath(outside).toString(),
            requireExists: true
        })).rejects.toThrow('escapes the configured workspace root');
    });

    it('resolves the workspace root directory as a valid repository-relative root', async () => {
        await expect(boundary.resolveWorkspacePath({
            relativePath: '.',
            requireExists: true
        })).resolves.toEqual({
            workspaceId: 'workspace-1',
            relativePath: '.',
            repositoryRelativePath: '.',
            exists: true,
            isDirectory: true
        });
    });

    it('converts workspace-relative paths to repository-relative paths for nested workspaces', async () => {
        const nestedBoundary = new WorkspaceBoundary();
        await nestedBoundary.initialize({
            ...config,
            workspaceRoot: path.join(repoRoot, 'nested')
        });

        await expect(nestedBoundary.resolveWorkspacePath({
            relativePath: 'file.txt',
            requireExists: true
        })).resolves.toEqual({
            workspaceId: 'workspace-1',
            relativePath: 'file.txt',
            repositoryRelativePath: 'nested/file.txt',
            exists: true,
            isDirectory: false
        });
    });

    it('rejects a workspace root outside the repository root', async () => {
        const outside = path.join(tempDir, 'outside-workspace');
        await fs.mkdir(outside);
        const invalidBoundary = new WorkspaceBoundary();

        await expect(invalidBoundary.initialize({
            ...config,
            workspaceRoot: outside
        })).rejects.toThrow('workspace root must be inside');
    });
});
