import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { injectable } from '@theia/core/shared/inversify';

import { CfsCommand, cfsCommand, cfsEnvironment } from './cfs-command';
import { RepositoryRegistry } from './repository-registry';
import type { StudioKitInstallRequest, StudioKitInstallResult } from '../common/studio-protocol';

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/**
 * The kits this runner will install, and where each lives.
 *
 * The slug names a KIT, not a repository: `studio-kits-pm` is a multi-kit
 * repository whose root manifest carries one `[[kits]]` entry per kit, and
 * `cfs` needs `--kit` to know which of them to install. A single-kit repository
 * needs no selector, so `kit` is absent for it rather than guessed.
 *
 * It stays an allow-list either way -- the request names a slug, never a
 * repository or a shell fragment.
 */
interface OfficialKit {
    readonly repo: string;
    readonly kit?: string;
}

const OFFICIAL_KITS: Readonly<Record<string, OfficialKit>> = Object.freeze({
    sdlc: Object.freeze({ repo: 'constructorfabric/studio-kit-sdlc' }),
    compete: Object.freeze({ repo: 'constructorfabric/studio-kits-pm', kit: 'compete' })
});
const SAFE_GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u;

export const KitInstaller = Symbol('KitInstaller');

interface CommandResult {
    readonly stdout: string;
    readonly stderr: string;
}

@injectable()
export class KitInstallerImpl {
    protected readonly activeRepositories = new Set<string>();

    async install(
        request: StudioKitInstallRequest,
        repositories: RepositoryRegistry
    ): Promise<StudioKitInstallResult> {
        const official = OFFICIAL_KITS[request.kitSlug];
        if (!official) {
            throw new Error(`Kit is not allow-listed: ${request.kitSlug}`);
        }
        const version = request.version.trim();
        if (!isSafeGitRef(version)) {
            throw new Error('Kit version is not a safe Git ref');
        }
        const repository = request.repositoryId
            ? repositories.requireRepository(request.repositoryId)
            : requireDefaultRepository(repositories);
        if (this.activeRepositories.has(repository.descriptor.repositoryId)) {
            throw new Error(`A kit operation is already running for ${repository.descriptor.label}`);
        }

        this.activeRepositories.add(repository.descriptor.repositoryId);
        try {
            // One command for the whole operation, so init, install and
            // generation run the same cfs.
            const command = cfsCommand();
            const initialized = await this.initializeRepository(repository.canonicalRoot, command);
            const installed = await this.run(
                // `cfs init` installs the default SDLC kit. The registry request
                // is authoritative for its version, so materialization must
                // replace that default (and supports an explicit reinstall).
                [
                    'kit',
                    'install',
                    official.repo,
                    ...(official.kit ? ['--kit', official.kit] : []),
                    '--version',
                    version,
                    '--force'
                ],
                repository.canonicalRoot,
                command
            );
            const generated = await this.run(['generate-agents'], repository.canonicalRoot, command);
            return {
                kitSlug: request.kitSlug,
                version,
                repositoryId: repository.descriptor.repositoryId,
                repositoryLabel: repository.descriptor.label,
                output: joinOutput(...(initialized ? [initialized] : []), installed, generated)
            };
        } finally {
            this.activeRepositories.delete(repository.descriptor.repositoryId);
        }
    }

    /**
     * `cfs kit install` deliberately assumes a repository has already been
     * prepared by `cfs init`. A Studio Web project can be connected to an
     * existing Git repository, though, so its first kit request is also the
     * first time anyone has prepared that checkout. Bootstrap exactly once;
     * subsequent kit updates must not rewrite an existing Studio setup.
     *
     * A command pinned to an engine names it: without `--version`, `cfs init`
     * first updates its cache to the latest engine on GitHub.
     */
    protected async initializeRepository(cwd: string, command: CfsCommand = cfsCommand()): Promise<CommandResult | undefined> {
        try {
            await fs.access(path.join(cwd, '.cf-studio'));
            return undefined;
        } catch (error) {
            if (!isMissingPath(error)) {
                throw error;
            }
        }

        return this.run([
            'init',
            '--yes',
            '--migrate-from-cypilot=no',
            '--update-legacy-studio=no',
            ...(command.engine ? ['--version', command.engine] : [])
        ], cwd, command);
    }

    protected run(arguments_: readonly string[], cwd: string, command: CfsCommand = cfsCommand()): Promise<CommandResult> {
        return new Promise((resolve, reject) => {
            execFile(command.executable, [...command.prefixArguments, ...arguments_], {
                cwd,
                env: cfsEnvironment(command),
                timeout: INSTALL_TIMEOUT_MS,
                maxBuffer: MAX_OUTPUT_BYTES,
                windowsHide: true,
                shell: false
            }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(
                        `cfs ${arguments_[0]} failed: ${failureDetail(error, stdout, stderr)}`
                    ));
                    return;
                }
                resolve({ stdout: String(stdout), stderr: String(stderr) });
            });
        });
    }
}

/*
 * The project repository is the default kit target. `.cf-studio-kit.toml` is a
 * project-level manifest and lives at the configured repository root -- the
 * single checkout in a classic workspace, an adopted root repository where
 * there is one. Source clones below it receive a kit only when the caller
 * names one explicitly.
 *
 * Resolved through `projectRepository`, never positionally: the registry is
 * ordered deepest-first (compareRepositoriesForDepth), so `repositories[0]` is
 * the deepest source clone and a positional default would silently install the
 * kit into the wrong tree. That getter also owns the single-repository
 * fallback, so the control API's `kind: 'project'` and this default are the
 * same answer rather than two that can disagree.
 *
 * Undefined is the honest answer for a workspace with several repositories and
 * no root repository to call the project: there is no safe guess, and the
 * caller has to name one.
 */
function requireDefaultRepository(repositories: RepositoryRegistry) {
    const project = repositories.projectRepository;
    if (project) {
        return project;
    }
    throw new Error(
        'repositoryId is required: the project repository is not registered '
        + 'and the workspace contains several repositories'
    );
}

/*
 * BOTH streams, not the first non-empty one.
 *
 * `cfs` is a proxy that narrates through stderr -- resolving the skill engine
 * alone writes a dozen lines there -- while the failure that actually stopped
 * the command can arrive on stdout. The previous `stderr || stdout` fallback
 * therefore reported the narration and hid the reason: two rounds of
 * "Constructor Studio skill engine not found" were read as the cause when they
 * were only the log of a download that had SUCCEEDED, and the real error was
 * never shown at all.
 *
 * stdout leads because that is where the reason usually is, and because both
 * consumers downstream truncate from the FRONT -- kit_registry keeps the first
 * 2000 chars of this string, and the Theia bridge's extract_upstream_detail the
 * first 2048. Putting the narration first would push the reason past both cuts.
 */
function failureDetail(error: Error, stdout: string, stderr: string): string {
    const streams: ReadonlyArray<readonly [string, string]> = [
        ['stdout', String(stdout).trim()],
        ['stderr', String(stderr).trim()]
    ];
    const present = streams.filter(([, text]) => text.length > 0);
    if (present.length === 0) {
        return error.message;
    }
    return present.map(([name, text]) => `${name}: ${lastLines(text)}`).join('\n');
}

/**
 * Keep the END of a stream: a command names what went wrong on its way out,
 * after whatever progress logging came before it.
 */
function lastLines(text: string, limit = 800): string {
    return text.length <= limit ? text : `...${text.slice(-limit)}`;
}

function isSafeGitRef(value: string): boolean {
    return SAFE_GIT_REF.test(value)
        && !value.includes('..')
        && !value.includes('@{')
        && !value.endsWith('/')
        && !value.endsWith('.lock');
}

function isMissingPath(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT';
}

function joinOutput(...results: readonly CommandResult[]): string {
    return results
        .flatMap(result => [result.stdout.trim(), result.stderr.trim()])
        .filter(Boolean)
        .join('\n')
        .slice(0, 16_384);
}
