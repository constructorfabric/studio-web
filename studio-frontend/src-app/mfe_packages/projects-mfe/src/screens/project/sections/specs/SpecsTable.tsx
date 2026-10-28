import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector, useMfeBridge } from '@gears-frontx/react';
import {
  Alert,
  AlertDescription,
  Button,
  DataGrid,
  DataGridEmptyStatePlugin,
  DataGridOrderPlugin,
  DataGridPaginationPlugin,
  DataGridTextSearchPlugin,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  useDataGrid,
  type DataGridTextSearchPluginApi,
} from '@gears-frontx/ui-kit';
import { FileText, Plug } from 'lucide-react';
import { useSpecsText } from '../../../../i18n';
import { requestOpenSpec } from '../../../../actions/artifactActions';
import { openSourcesConnect } from '../../../../actions/sourcesConnectActions';
import { specsFooter } from '../../../../model/specRows';
import { useSpecsLoad } from '../../../../shared/useSpecsLoad';
import { useThemedRoot } from '../../../../shared/useThemedRoot';
import { specsShown } from '../../../../slices/specsCheckSlice';
import { SPECS_FILTER_SLICE_KEY, setSpecsSearch } from '../../../../slices/specsFilterSlice';
import { UploadDocumentsButton } from '../../upload/UploadDocumentsButton';
import { UploadPanel } from '../../upload/UploadPanel';
import { SpecsCellsContext, specsColumns, type SpecsCells } from './specsColumns';
import styles from './SpecsTable.module.css';

const PAGE_LIMITS = [25, 50, 100];

/**
 * The search starts from #683's slice, so Sources can open the list on one
 * repository (#686), and writes every change back, so it survives a switch of
 * section. The kit's search takes no initial value: seeding it is a second load.
 * That load waits for the first good read and answers from memory: a load the
 * search starts that fails escapes the kit as an unhandled rejection. Until the
 * seed is in, nothing is written back, so a Retry starts from it again.
 */
const SearchFromSlice: React.FC<{ read: boolean }> = ({ read }) => {
  const search = useDataGrid().getPlugin<DataGridTextSearchPluginApi>('textSearch');
  if (!search) throw new Error('SearchFromSlice must come after DataGridTextSearchPlugin');
  const dispatch = useAppDispatch();
  const [seed] = useState(useAppSelector((state) => state[SPECS_FILTER_SLICE_KEY].search));
  const seeding = useRef(Boolean(seed));
  const query = search.useQuery();
  useEffect(() => {
    if (!read || !seeding.current) return;
    seeding.current = false;
    search.setSearch(seed);
  }, [read, search, seed]);
  useEffect(() => {
    if (!seeding.current) dispatch(setSpecsSearch(query));
  }, [dispatch, query]);
  return null;
};

const SpecsEmpty: React.FC = () => {
  const t = useSpecsText();
  const bridge = useMfeBridge();
  const cells = useContext(SpecsCellsContext);
  const searching = useDataGrid().useStore((state) => state.hasActiveFilters);
  if (searching) {
    return (
      <Empty className={styles.empty}>
        <EmptyHeader>
          <EmptyDescription>{t('no_matches')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Empty className={styles.empty}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText />
        </EmptyMedia>
        <EmptyTitle>{t('empty_title')}</EmptyTitle>
        <EmptyDescription>{t('empty_note')}</EmptyDescription>
      </EmptyHeader>
      <EmptyActions>
        {cells && <UploadDocumentsButton projectId={cells.projectId} />}
        <Button size="sm" icon={<Plug />} onClick={() => openSourcesConnect(bridge)}>
          {t('empty_connect')}
        </Button>
      </EmptyActions>
    </Empty>
  );
};

interface SpecsTableProps {
  projectId: string;
  projectName: string;
  workspaceId: string;
  /** Starts the table over: a new grid and a new read. */
  onRetry: () => void;
}

/** The Specs list (#692) on the kit's DataGrid, over #689's `load`. */
export const SpecsTable: React.FC<SpecsTableProps> = ({
  projectId,
  projectName,
  workspaceId,
  onRetry,
}) => {
  const t = useSpecsText();
  const bridge = useMfeBridge();
  const dispatch = useAppDispatch();
  const [container, findThemedRoot] = useThemedRoot();
  const { load, snapshot, reloadBridge } = useSpecsLoad(projectId, workspaceId);
  const columns = useMemo(() => specsColumns(t), [t]);

  // Check (#691) takes the rows the search shows; it stays hidden until the first load writes them.
  // A failed read shows none, so Check cannot send rows the table no longer shows.
  useEffect(() => {
    if (snapshot) dispatch(specsShown(snapshot.shown));
  }, [dispatch, snapshot]);

  const types = snapshot?.types;
  const cells = useMemo<SpecsCells>(
    () => ({
      projectId,
      workspaceId,
      types: types ?? [],
      container,
      open: (row) => requestOpenSpec(bridge, projectId, row),
    }),
    [projectId, workspaceId, types, container, bridge]
  );

  // The kit's own error view is English and has no retry, and a failed reload has none at all.
  if (snapshot?.failed) {
    return (
      <div className={styles.failed}>
        <p className={styles.error} role="alert">
          {t('read_failed')}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const footer = snapshot && specsFooter(snapshot.rows, snapshot.sources.reviews_known);
  return (
    <div ref={findThemedRoot} className={styles.section}>
      <UploadPanel projectId={projectId} projectName={projectName} />
      {snapshot && !snapshot.sources.files_known && (
        <Alert className={styles.notice}>
          <AlertDescription>{t('files_unknown')}</AlertDescription>
        </Alert>
      )}
      <SpecsCellsContext.Provider value={cells}>
        <DataGrid name="specs" persistent="memory" columns={columns} load={load}>
          <DataGridTextSearchPlugin placeholder={t('search')} />
          <SearchFromSlice read={snapshot !== null && !snapshot.failed} />
          <DataGridOrderPlugin />
          <DataGridPaginationPlugin defaultLimit={PAGE_LIMITS[0]} limits={PAGE_LIMITS} />
          <DataGridEmptyStatePlugin component={SpecsEmpty} />
          {reloadBridge}
        </DataGrid>
      </SpecsCellsContext.Provider>
      {snapshot && footer && footer.total > 0 && (
        <p className={styles.footer}>
          {[
            t.count('footer_of', footer.total, { shown: snapshot.shown.length }),
            footer.findings !== null && t.count('footer_findings', footer.findings),
            projectName,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
    </div>
  );
};

SpecsTable.displayName = 'SpecsTable';
