import * as React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { remoteGearCatalogueChanged } from './gearbox-remote-catalogue';
import {
    ADD_GEAR_COMMAND,
    ComponentsReference,
    ReferenceEntry,
    activityText,
    addableGears,
    countText,
    demandText,
    emptyMessage,
    filterEntries,
    kindCounts,
    loadComponentsReference,
    monthText,
    planWarning,
    profilePercent,
    releaseText,
    scheduleText,
    sourceText,
    stageTone,
} from './components-reference-model';

/*
 * The components reference: every component Studio knows, in the IDE.
 *
 * The portal's Components page and the IDE's Gearbox catalogue showed the
 * same gears twice — one as crates with releases and activity, the other as
 * `gear.gdl` descriptors with extension points. This view shows them once,
 * from the backend's join, and lets a person put a gear into the product from
 * where they read about it. "Add to product" is gearbox-studio's own command;
 * this view only calls it.
 *
 * Host-agnostic: the data comes through `StudioApi.fetch`, which the portal's
 * session and the desktop both answer.
 */

type State =
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; reference: ComponentsReference };

@injectable()
export class ComponentsReferenceWidget extends ReactWidget {
    static readonly ID = 'studio:components-reference';
    static readonly LABEL = 'Components';

    @inject(CommandRegistry)
    protected readonly commands: CommandRegistry;

    protected state: State = { kind: 'loading' };
    protected query = '';
    protected kinds = new Set<string>();
    protected addableOnly = false;
    protected selected: string | undefined;
    /** The last "Add to product" outcome, per engine gear id. */
    protected addNotes = new Map<string, string>();

    @postConstruct()
    protected init(): void {
        this.id = ComponentsReferenceWidget.ID;
        this.title.label = ComponentsReferenceWidget.LABEL;
        this.title.caption = 'Components reference';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-book';
        this.addClass('studio-components-reference');
        this.node.tabIndex = 0;
        // Signing in on the desktop is when a first, refused read can succeed.
        this.toDispose.push(remoteGearCatalogueChanged.event(() => void this.reload()));
        void this.reload();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    async reload(): Promise<void> {
        this.state = { kind: 'loading' };
        this.update();
        const load = await loadComponentsReference();
        this.state = load.kind === 'ok'
            ? { kind: 'ready', reference: load.reference }
            : { kind: 'error', message: load.message };
        this.update();
    }

    protected async addToProduct(gearId: string): Promise<void> {
        this.addNotes.set(gearId, 'Adding…');
        this.update();
        try {
            await this.commands.executeCommand(ADD_GEAR_COMMAND, { gearId });
            this.addNotes.set(gearId, 'Sent to the product.');
        } catch (e) {
            this.addNotes.set(gearId, `Could not add: ${e instanceof Error ? e.message : String(e)}`);
        }
        this.update();
    }

    protected render(): React.ReactNode {
        if (this.state.kind === 'loading') {
            return <div className='scr-state'>Reading the components from Studio…</div>;
        }
        if (this.state.kind === 'error') {
            return (
                <div className='scr-state scr-error'>
                    <p>{this.state.message}</p>
                    <button className='theia-button' onClick={() => void this.reload()}>Reload</button>
                </div>
            );
        }
        const reference = this.state.reference;
        const shown = filterEntries(reference.items, { query: this.query, kinds: this.kinds, addableOnly: this.addableOnly });
        const selected = shown.find(e => e.name === this.selected) ?? reference.items.find(e => e.name === this.selected);
        const empty = emptyMessage(reference.items.length, shown.length);
        return (
            <div className='scr-root'>
                <div className='scr-list'>
                    <div className='scr-toolbar'>
                        <input
                            className='theia-input scr-search'
                            type='search'
                            placeholder='Search components, gears, purposes'
                            value={this.query}
                            onChange={e => { this.query = e.currentTarget.value; this.update(); }}
                            aria-label='Search components'
                        />
                        <button className='theia-button secondary scr-reload' title='Read the list again' onClick={() => void this.reload()}>
                            <span className='codicon codicon-refresh' />
                        </button>
                    </div>
                    <div className='scr-chips' role='group' aria-label='Filter by type'>
                        {kindCounts(reference.items).map(({ kind, count }) => (
                            <button
                                key={kind}
                                className={`scr-chip${this.kinds.has(kind) ? ' on' : ''}`}
                                aria-pressed={this.kinds.has(kind)}
                                onClick={() => { this.toggleKind(kind); }}
                            >
                                {kind} <span className='scr-count'>{count}</span>
                            </button>
                        ))}
                        <label className='scr-addable'>
                            <input
                                type='checkbox'
                                checked={this.addableOnly}
                                onChange={e => { this.addableOnly = e.currentTarget.checked; this.update(); }}
                            />
                            only gears the engine can add
                        </label>
                    </div>
                    <div className='scr-notes'>
                        {reference.sources.gearbox_corpus
                            ? <span>Engine facts from {reference.sources.gearbox_corpus}</span>
                            : <span className='scr-warn'>No engine facts: {reference.sources.gearbox_problem ?? 'Gearbox did not answer'}</span>}
                        {reference.sources.activity_days === null && reference.sources.activity_problem &&
                            <span className='scr-warn'>Activity not measured: {reference.sources.activity_problem}</span>}
                        {reference.truncated && <span className='scr-warn'>The catalogue is longer than one answer; this is its first part.</span>}
                    </div>
                    {empty
                        ? <div className='scr-state'>{empty}</div>
                        : (
                            <ul className='scr-rows' role='listbox' aria-label='Components'>
                                {shown.map(e => this.renderRow(e, reference))}
                            </ul>
                        )}
                    <div className='scr-foot'>{shown.length} of {reference.items.length} components</div>
                </div>
                <div className='scr-detail'>
                    {selected ? this.renderDetail(selected, reference) : <div className='scr-state'>Pick a component to read about it.</div>}
                </div>
            </div>
        );
    }

    protected toggleKind(kind: string): void {
        if (this.kinds.has(kind)) {
            this.kinds.delete(kind);
        } else {
            this.kinds.add(kind);
        }
        this.update();
    }

    protected renderRow(e: ReferenceEntry, reference: ComponentsReference): React.ReactNode {
        const pct = profilePercent(e);
        const release = releaseText(e);
        const activity = activityText(e, reference.sources);
        return (
            <li
                key={e.name}
                role='option'
                aria-selected={e.name === this.selected}
                className={`scr-row${e.name === this.selected ? ' selected' : ''}`}
                onClick={() => { this.selected = e.name; this.update(); }}
                title={e.name}
            >
                <div className='scr-row-head'>
                    <span className='scr-name'>{e.title ?? e.name}</span>
                    <span className='scr-kind'>{e.kind}</span>
                    {e.engine.length > 0 && <span className='scr-engine' title='The Gearbox engine describes it'>gear.gdl</span>}
                    {e.readiness?.stage && (
                        <span className={`scr-stage ${stageTone(e.readiness)}`}>
                            <span className='scr-dot' />{e.readiness.stage}
                        </span>
                    )}
                </div>
                {e.title && <div className='scr-sub'>{e.name}</div>}
                {e.description && <div className='scr-purpose'>{e.description}</div>}
                {this.renderPlanLine(e)}
                <div className='scr-meta'>
                    {release && <span>{release}</span>}
                    {typeof e.downloads === 'number' && <span>{countText(e.downloads)} downloads</span>}
                    {activity && <span>{activity}</span>}
                    {pct !== null && <span>profile {pct}%</span>}
                </div>
            </li>
        );
    }

    protected renderDetail(e: ReferenceEntry, reference: ComponentsReference): React.ReactNode {
        const pct = profilePercent(e);
        const canAdd = this.commands.getCommand(ADD_GEAR_COMMAND) !== undefined;
        const release = releaseText(e);
        const activity = activityText(e, reference.sources);
        const source = sourceText(e);
        return (
            <div className='scr-page'>
                <h2 className='scr-title'>{e.title ?? e.name}</h2>
                {e.title && <div className='scr-sub'>{e.name}</div>}
                {e.description && <p className='scr-purpose'>{e.description}</p>}
                {this.renderReadiness(e)}
                <dl className='scr-facts'>
                    <dt>Type</dt><dd>{e.kind}{e.category ? ` · ${e.category}` : ''}</dd>
                    {e.status && <><dt>Status</dt><dd>{e.status}</dd></>}
                    {release && <><dt>Release</dt><dd>{release}</dd></>}
                    {typeof e.downloads === 'number' && <>
                        <dt>Downloads</dt>
                        <dd>{countText(e.downloads)}{typeof e.recent_downloads === 'number' ? ` (${countText(e.recent_downloads)} recent)` : ''}</dd>
                    </>}
                    {activity && <>
                        <dt>Activity</dt>
                        <dd>{activity}{e.activity ? ` · ${e.activity.files_changed} files` : ''}</dd>
                    </>}
                    {pct !== null && <><dt>Profile</dt><dd>{`${pct}% (${e.profile_filled} of ${e.profile_fields} fields answered)`}</dd></>}
                    {e.updated_at && <><dt>Last change</dt><dd>{e.updated_at.slice(0, 10)}</dd></>}
                    {source && <>
                        <dt>Source</dt>
                        <dd>{e.repository
                            ? <a href={e.repository} target='_blank' rel='noreferrer'>{source}</a>
                            : source}</dd>
                    </>}
                    {e.sources.length > 0 && <><dt>Facts from</dt><dd>{e.sources.join(', ')}</dd></>}
                </dl>

                <h3>Engine</h3>
                {e.engine.length === 0
                    ? (
                        <p className='scr-muted'>
                            {reference.sources.gearbox_corpus
                                ? 'The Gearbox engine describes no gear for this component, so it cannot be added to a product from here.'
                                : `No engine facts: ${reference.sources.gearbox_problem ?? 'Gearbox did not answer'}.`}
                        </p>
                    )
                    : addableGears(e).map(g => (
                        <div key={g.id} className='scr-gear'>
                            <div className='scr-gear-head'>
                                <code>{g.id}</code>
                                <span className='scr-kind'>{g.role}</span>
                                <button
                                    className='theia-button scr-add'
                                    disabled={!canAdd}
                                    title={canAdd ? `Put ${g.id} into the product` : 'Gearbox is not loaded in this IDE'}
                                    onClick={() => void this.addToProduct(g.id)}
                                >
                                    Add to product
                                </button>
                            </div>
                            {this.addNotes.get(g.id) && <div className='scr-note'>{this.addNotes.get(g.id)}</div>}
                            <dl className='scr-facts'>
                                {g.category && <><dt>Category</dt><dd>{g.category}</dd></>}
                                <dt>Runtime</dt><dd>{g.runtime_caps.join(', ') || '—'}</dd>
                                <dt>Extension points</dt>
                                <dd>{g.extension_points.length === 0
                                    ? 'none declared'
                                    : g.extension_points.map(p => <div key={p.spec}>{p.interface ?? p.spec}</div>)}</dd>
                                {g.fills && <><dt>Fills</dt><dd>{g.fills}</dd></>}
                                {g.role === 'plugin' && <><dt>Hosts</dt><dd>{g.hosts.join(', ') || 'no gear in the corpus hosts it'}</dd></>}
                                {g.plugins.length > 0 && <><dt>Plugins</dt><dd>{g.plugins.join(', ')}</dd></>}
                                {g.colocated_deps.length > 0 && <><dt>Runs with</dt><dd>{g.colocated_deps.join(', ')}</dd></>}
                                {g.gdl_path && <><dt>Descriptor</dt><dd><code>{g.gdl_path}</code></dd></>}
                            </dl>
                        </div>
                    ))}

                {e.related.length > 0 && <h3>Related crates</h3>}
                {e.related.length > 0 && (
                        <ul className='scr-related'>
                            {e.related.map(r => (
                                <li key={r.name}>
                                    {r.in_catalogue
                                        ? <a href='#' onClick={ev => { ev.preventDefault(); this.selected = r.name; this.update(); }}>{r.name}</a>
                                        : <span>{r.name}</span>}
                                    <span className='scr-kind'>{r.role}</span>
                                    {!r.in_catalogue && <span className='scr-muted'> not in the catalogue</span>}
                                </li>
                            ))}
                        </ul>
                    )}
            </div>
        );
    }

    /**
     * Stage, due date and whether the plan holds, in one line under the
     * purpose; the plan's warning, when it has one, above everything else.
     * Nothing at all for a component the roadmap does not plan.
     */
    protected renderPlanLine(e: ReferenceEntry): React.ReactNode {
        const r = e.readiness;
        const schedule = scheduleText(r);
        const due = monthText(r?.due);
        const demand = demandText(r);
        const warning = planWarning(r);
        if (!schedule && !demand && !warning) {
            return undefined;
        }
        return (
            <div className='scr-plan'>
                {(schedule || due) && (
                    <div className='scr-plan-line'>
                        {r?.committed !== null && r?.committed !== undefined && (
                            <span className='scr-pill'>{r.committed ? 'Committed' : 'Planned'}</span>
                        )}
                        {schedule && <span className={`scr-sched ${schedule.lamp}`}><span className='scr-dot' />{schedule.text}</span>}
                        {due && <span className='scr-due'>due {due}</span>}
                    </div>
                )}
                {demand && <div className='scr-demand'>{demand}</div>}
                {warning && <div className={`scr-warning ${warning.lamp}`}>⚠ {warning.text}</div>}
            </div>
        );
    }

    /** The page's readiness block: every answered part of it, nothing else. */
    protected renderReadiness(e: ReferenceEntry): React.ReactNode {
        const r = e.readiness;
        if (!r) {
            return undefined;
        }
        const schedule = scheduleText(r);
        const demand = demandText(r);
        return (
            <section className='scr-readiness'>
                <h3>Readiness</h3>
                {r.plan_reasons.length > 0 && (
                    <ul className={`scr-reasons ${r.plan_lamp ?? ''}`}>
                        {r.plan_reasons.map(reason => <li key={reason}>{reason}</li>)}
                    </ul>
                )}
                <dl className='scr-facts'>
                    {r.stage && <>
                        <dt>Stage</dt>
                        <dd>
                            <span className={`scr-stage ${stageTone(r)}`}><span className='scr-dot' />{r.stage}</span>
                            {typeof r.stage_at === 'number' && typeof r.stage_of === 'number' ? ` (${r.stage_at} of ${r.stage_of})` : ''}
                        </dd>
                    </>}
                    {schedule && <>
                        <dt>Plan</dt>
                        <dd><span className={`scr-sched ${schedule.lamp}`}><span className='scr-dot' />{schedule.text}</span>{r.plan ? ` · ${r.plan}` : ''}</dd>
                    </>}
                    {r.milestone && <>
                        <dt>Milestone</dt>
                        <dd>{r.milestone}{r.due ? ` · due ${r.due}` : ''}{r.committed === null ? '' : r.committed ? ' · committed' : ' · not a commitment'}</dd>
                    </>}
                    {r.progress.length > 0 && <>
                        <dt>Progress</dt>
                        <dd className='scr-axes'>
                            {r.progress.map(a => (
                                <span key={a.label} className={`scr-axis ${a.pct === 100 ? 'full' : a.pct === null ? 'na' : 'part'}`}>
                                    <span className='scr-dot' />{a.label} {a.value}
                                </span>
                            ))}
                        </dd>
                    </>}
                    {demand && <><dt>Needed by</dt><dd>{demand}</dd></>}
                    {r.lifecycle && <><dt>In the repository</dt><dd>{r.lifecycle}</dd></>}
                    {r.last_release && <><dt>Last release</dt><dd>{r.last_release}{r.released_on ? ` · ${r.released_on}` : ''}</dd></>}
                    {typeof r.used_by === 'number' && <><dt>Used by</dt><dd>{r.used_by} component{r.used_by === 1 ? '' : 's'}</dd></>}
                    {r.roadmap_item && <><dt>Roadmap item</dt><dd><a href={r.roadmap_item} target='_blank' rel='noreferrer'>{r.roadmap_item.replace(/^https?:\/\/github\.com\//, '')}</a></dd></>}
                </dl>
            </section>
        );
    }
}
