import { test, expect, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';

const PROJECT_ROOT = join(__dirname, '..', '..');
const HOST = '127.0.0.1';
const PORT = 3210;
const BRANCH = 'main';
const DOCUMENT_PATH = 'docs/guide.md';
const INITIAL_DOCUMENT = '# Guide\n\nInitial paragraph.\n';
const UPDATED_DOCUMENT = '# Guide\n\nInitial paragraph.\n\nSaved from Playwright.\n';
const RETRY_DOCUMENT = '# Guide\n\nInitial paragraph.\n\nSaved from Playwright.\n\nRecovered after retry.\n';

test.describe('Studio save and push', () => {
    test('saves markdown and pushes to a local bare remote through Studio UI', async ({ page }) => {
        const fixture = createFixture();
        const studio = new StudioServer(fixture.workspaceDir, fixture.runtimeDir);

        try {
            studio.start();
            await studio.waitUntilReady();

            await page.clock.setFixedTime(new Date('2026-07-28T09:00:00.000Z'));
            await page.goto(`http://localhost:${PORT}`);
            await page.waitForLoadState('networkidle');
            await acceptWorkspaceTrust(page);

            await expect(page.getByTestId('workspace-graph-widget')).toBeVisible();
            await expect(page.getByTestId('git-operations-widget')).toBeAttached();
            await expect(page.getByTestId('audit-widget')).toBeAttached();

            await waitForGraphReady(page);
            await openGuideFromGraph(page);
            // A standalone IDE has no portal handshake and no desktop sign-in,
            // so it knows no Studio project: the panel says so rather than
            // inventing numbers, and offers no run.
            await openStudioView(page, 'Analyze', 'analyze-widget');
            await expect(page.getByTestId('analyze-message')).toContainText('not connected to a Studio project');
            await expect(page.getByTestId('analyze-run')).toBeDisabled();

            const editor = page.getByLabel('editable markdown');
            await appendPlainParagraph(page, 'Saved from Playwright.');
            await editor.click();
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');

            await waitForFileContents(fixture.documentPath, UPDATED_DOCUMENT);
            await openStudioView(page, 'Git Operations', 'git-operations-widget');

            const operationRow = page.locator('[data-testid^="git-operation-row-"]').filter({
                hasText: 'guide.md'
            }).first();
            await expect(operationRow).toBeVisible();
            await expect(operationRow.locator('[data-testid^="git-operation-state-"]')).toHaveText('pushed');

            await openStudioView(page, 'Audit', 'audit-widget');
            await expect(page.getByTestId('audit-badge-committed')).not.toHaveText('0');
            await expect(page.getByTestId('audit-badge-pushed')).not.toHaveText('0');
            await expect(page.getByTestId('audit-list')).toContainText('guide.md');
            await expect(page.getByTestId('audit-list')).toContainText('Committed');
            await expect(page.getByTestId('audit-list')).toContainText('Pushed');

            await expect(page.getByTestId('audit-filter-failed')).toBeVisible();
            await expect(page.getByTestId('audit-filter-blocked')).toBeVisible();
            await expect(page.getByTestId('audit-badge-failed')).toHaveText('0');
            await expect(page.getByTestId('audit-badge-blocked')).toHaveText('0');

            const headSha = git(['rev-parse', 'HEAD'], fixture.workspaceDir);
            expect(headSha).toMatch(/^[0-9a-f]{40}$/);
            expect(git(['rev-parse', `${BRANCH}@{upstream}`], fixture.workspaceDir)).toBe(headSha);
            expect(git(['--git-dir', fixture.remoteDir, 'rev-parse', `refs/heads/${BRANCH}`], PROJECT_ROOT)).toBe(headSha);
            expect(git(['show', `HEAD:${DOCUMENT_PATH}`], fixture.workspaceDir)).toBe(UPDATED_DOCUMENT.trimEnd());
            expect(git(['--git-dir', fixture.remoteDir, 'show', `${BRANCH}:${DOCUMENT_PATH}`], PROJECT_ROOT)).toBe(UPDATED_DOCUMENT.trimEnd());

            fixture.disconnectRemote();

            await appendPlainParagraph(page, 'Recovered after retry.');
            await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');

            await waitForFileContents(fixture.documentPath, RETRY_DOCUMENT);
            await openStudioView(page, 'Git Operations', 'git-operations-widget');

            const retryRow = page.locator('[data-testid^="git-operation-row-"]').filter({
                hasText: 'guide.md'
            }).first();
            await expect(retryRow.locator('[data-testid^="git-operation-state-"]')).toHaveText('push-pending');
            await openStudioView(page, 'Audit', 'audit-widget');
            await expect(page.getByTestId('audit-badge-pending')).not.toHaveText('0');
            await page.getByTestId('audit-filter-pending').click();
            await expect(page.getByTestId('audit-list')).toContainText('guide.md');
            await expect(page.getByTestId('audit-list')).toContainText('Pending');

            fixture.reconnectRemote();
            await openStudioView(page, 'Git Operations', 'git-operations-widget');
            await retryRow.locator('[data-testid^="git-operation-retry-"]').click();
            await expect(retryRow.locator('[data-testid^="git-operation-state-"]')).toHaveText('pushed');
            await openStudioView(page, 'Audit', 'audit-widget');
            await page.getByTestId('audit-filter-all').click();
            await expect(page.getByTestId('audit-list')).toContainText('Pushed');
            await expect(page.getByTestId('audit-filter-failed')).toBeVisible();
            await expect(page.getByTestId('audit-filter-blocked')).toBeVisible();
            await expect(page.getByTestId('audit-badge-failed')).toHaveText('0');
            await expect(page.getByTestId('audit-badge-blocked')).toHaveText('0');

            await page.reload();
            await page.waitForLoadState('networkidle');

            await expect(page.getByTestId('workspace-graph-widget')).toBeAttached();
            await expect(page.getByTestId('git-operations-widget')).toBeAttached();
            await expect(page.getByTestId('audit-widget')).toBeAttached();
            await openStudioView(page, 'Audit', 'audit-widget');
            await expect(page.getByTestId('audit-badge-pushed')).not.toHaveText('0');
            await expect(page.locator('[data-testid^="git-operation-row-"]').filter({ hasText: 'guide.md' }).first()).toContainText('pushed');
            expect(git(['show', `HEAD:${DOCUMENT_PATH}`], fixture.workspaceDir)).toBe(RETRY_DOCUMENT.trimEnd());
            expect(git(['--git-dir', fixture.remoteDir, 'show', `${BRANCH}:${DOCUMENT_PATH}`], PROJECT_ROOT)).toBe(RETRY_DOCUMENT.trimEnd());
        } finally {
            await studio.stop();
            fixture.dispose();
        }
    });
});

async function acceptWorkspaceTrust(page: Page): Promise<void> {
    const trustButton = page.getByRole('button', { name: /Yes, (?:I )?trust the authors/ });
    try {
        await trustButton.waitFor({ state: 'visible', timeout: 5_000 });
        await trustButton.click();
    } catch {
        // Theia remembers trust for an already accepted workspace.
    }
}

async function openStudioView(page: Page, commandLabel: string, testId: string): Promise<void> {
    const widget = page.getByTestId(testId);
    if (await widget.isVisible()) {
        return;
    }
    const existingTab = page.locator('li.p-TabBar-tab').filter({ hasText: commandLabel }).last();
    if (await existingTab.isVisible()) {
        await existingTab.click();
    } else {
        await executeStudioCommand(page, commandLabel);
    }
    await expect(widget).toBeVisible();
}

async function executeStudioCommand(page: Page, commandLabel: string): Promise<void> {
    await page.keyboard.press('F1');
    await page.keyboard.type(commandLabel);
    await page.keyboard.press('Enter');
}

async function waitForGraphReady(page: Page): Promise<void> {
    await expect
        .poll(async () => ({
            statusText: await page.getByTestId('workspace-graph-status').textContent() ?? '',
            nodeCount: await page.getByTestId('graph-flow-node').count()
        }), {
            timeout: 30_000,
            message: 'Workspace graph did not become ready'
        })
        .toMatchObject({
            statusText: expect.not.stringContaining('failed'),
            nodeCount: expect.any(Number)
        });
    await expect(page.getByTestId('graph-flow-node').first()).toBeVisible();
}

async function openGuideFromGraph(page: Page): Promise<void> {
    const fileNode = page.getByTestId('graph-flow-node').filter({ hasText: 'guide.md' }).first();
    await expect(fileNode).toBeVisible();
    await fileNode.click();
    await expect
        .poll(async () => page.getByTestId('workspace-graph-status').textContent() ?? '', {
            timeout: 10_000,
            message: 'Workspace graph did not reflect the guide.md selection'
        })
        .toContain('guide.md');
    await page.keyboard.press('Enter');
    const editor = page.getByLabel('editable markdown');
    await expect(editor).toBeVisible();
    await editor.click();
    await expect(editor).toBeFocused();
}

async function appendPlainParagraph(page: Page, text: string): Promise<void> {
    const editor = page.getByLabel('editable markdown');
    await expect(editor).toBeVisible();
    await editor.evaluate(element => {
        const selection = window.getSelection();
        const range = document.createRange();
        (element as HTMLElement).focus();
        range.selectNodeContents(element);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);
    });
    await expect(editor).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.insertText(text);
}

function createFixture(): Fixture {
    const rootDir = mkdtempSync(join(tmpdir(), 'studio-save-push-'));
    const workspaceDir = join(rootDir, 'workspace');
    const remoteDir = join(rootDir, 'remote.git');
    const offlineRemoteDir = join(rootDir, 'remote.offline.git');
    const runtimeDir = join(rootDir, 'runtime');
    const documentPath = join(workspaceDir, DOCUMENT_PATH);

    mkdirSync(join(workspaceDir, 'docs'), { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(documentPath, INITIAL_DOCUMENT, 'utf8');

    git(['init', '--bare', remoteDir], PROJECT_ROOT);
    git(['init', '--initial-branch', BRANCH], workspaceDir);
    git(['config', 'user.name', 'Studio E2E'], workspaceDir);
    git(['config', 'user.email', 'studio-e2e@example.test'], workspaceDir);
    git(['remote', 'add', 'origin', remoteDir], workspaceDir);
    git(['add', '.'], workspaceDir);
    git(['commit', '-m', 'Initial content'], workspaceDir);
    git(['push', '--set-upstream', 'origin', BRANCH], workspaceDir);

    return {
        workspaceDir,
        remoteDir,
        offlineRemoteDir,
        runtimeDir,
        documentPath,
        disconnectRemote: () => renameSync(remoteDir, offlineRemoteDir),
        reconnectRemote: () => renameSync(offlineRemoteDir, remoteDir),
        dispose: () => rmSync(rootDir, { recursive: true, force: true })
    };
}

class StudioServer {
    protected process: ChildProcess | undefined;
    protected readonly bufferedLogs: string[] = [];

    constructor(
        protected readonly workspaceDir: string,
        protected readonly runtimeDir: string
    ) {}

    start(): void {
        if (this.process) {
            return;
        }
        const child = spawn(
            process.execPath,
            [
                'browser-app/scripts/start-browser.js',
                `--hostname=${HOST}`,
                `--port=${PORT}`,
                this.workspaceDir
            ],
            {
                cwd: PROJECT_ROOT,
                env: {
                    ...process.env,
                    STUDIO_ACTOR_ID: 'playwright-e2e',
                    STUDIO_WORKSPACE_ID: 'playwright-e2e-workspace',
                    STUDIO_DATA_DIR: this.runtimeDir,
                    STUDIO_GIT_MODE: 'push',
                    NODE_ENV: 'test',
                    STUDIO_TEST_ALLOW_LOCAL_GIT_TRANSPORT: '1',
                    THEIA_WEBVIEW_EXTERNAL_ENDPOINT: '{{uuid}}.webview.{{hostname}}'
                },
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        child.stdout?.on('data', chunk => this.captureLog(String(chunk)));
        child.stderr?.on('data', chunk => this.captureLog(String(chunk)));
        child.on('exit', code => {
            this.captureLog(`process exited with code ${code ?? -1}`);
        });
        this.process = child;
    }

    async waitUntilReady(): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < 60_000) {
            if (!this.process || this.process.exitCode !== null) {
                throw new Error(`Studio server exited early.\n${this.flushLogs()}`);
            }
            try {
                await httpGet(`http://localhost:${PORT}`);
                return;
            } catch {
                await delay(250);
            }
        }
        throw new Error(`Studio server did not become ready.\n${this.flushLogs()}`);
    }

    async stop(): Promise<void> {
        const child = this.process;
        this.process = undefined;
        if (!child || child.exitCode !== null) {
            return;
        }
        child.kill('SIGTERM');
        const start = Date.now();
        while (child.exitCode === null && Date.now() - start < 10_000) {
            await delay(100);
        }
        if (child.exitCode === null) {
            child.kill('SIGKILL');
        }
    }

    protected captureLog(message: string): void {
        const normalized = message
            .replaceAll(this.workspaceDir, '<workspace>')
            .replaceAll(this.runtimeDir, '<runtime>')
            .trim();
        if (!normalized) {
            return;
        }
        this.bufferedLogs.push(normalized);
        if (this.bufferedLogs.length > 40) {
            this.bufferedLogs.shift();
        }
    }

    protected flushLogs(): string {
        return this.bufferedLogs.join('\n');
    }
}

interface Fixture {
    readonly workspaceDir: string;
    readonly remoteDir: string;
    readonly offlineRemoteDir: string;
    readonly runtimeDir: string;
    readonly documentPath: string;
    readonly disconnectRemote: () => void;
    readonly reconnectRemote: () => void;
    readonly dispose: () => void;
}

function git(args: string[], cwd: string): string {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed with exit code ${result.status ?? -1}: ${(result.stderr || result.stdout).trim()}`);
    }
    return result.stdout.trimEnd();
}

async function waitForFileContents(targetPath: string, expectedContents: string): Promise<void> {
    await expect
        .poll(async () => {
            try {
                await access(targetPath);
                return await readFile(targetPath, 'utf8');
            } catch {
                return '';
            }
        }, {
            timeout: 15_000,
            message: `Timed out waiting for saved file contents at ${targetPath}`
        })
        .toBe(expectedContents);
}

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const request = httpRequest(url, response => {
            const chunks: Buffer[] = [];
            response.on('data', chunk => chunks.push(Buffer.from(chunk)));
            response.on('end', () => {
                if ((response.statusCode ?? 500) >= 400) {
                    reject(new Error(`HTTP ${response.statusCode ?? 500}`));
                    return;
                }
                resolve(Buffer.concat(chunks).toString('utf8'));
            });
        });
        request.on('error', reject);
        request.end();
    });
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
