import React, { useMemo } from 'react';
import { CircleAlert, FileText, X } from 'lucide-react';
import {
  apiRegistry,
  useApiQuery,
  useAppDispatch,
  useAppSelector,
  useMfeBridge,
} from '@gears-frontx/react';
import {
  Button,
  Input,
  Item,
  ItemActions,
  ItemContent,
  ItemFooter,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@gears-frontx/ui-kit';
import { useEverLoaded, useWorkspace } from '@constructor-studio/mfe-shared';
import { DocumentsApiService } from '../../../api/DocumentsApiService';
import type { DocumentTypeDto } from '../../../api/documentTypes';
import { requestOpenDocument } from '../../../actions/artifactActions';
import { requestDocumentsUpload } from '../../../actions/documentUploadActions';
import { useUploadText, useUploadTranslations } from '../../../i18n';
import {
  UPLOAD_LIMITS,
  addableIds,
  canSendAlone,
  isFileProblem,
  isNameProblem,
  isUploadSection,
  rowProblem,
  uploadSummary,
  type BatchProblem,
  type UploadEntry,
  type UploadProblem,
  type UploadSection,
} from '../../../model/documentUpload';
import { useProjectDocuments } from '../../../shared/useProjectDocuments';
import { useThemedRoot } from '../../../shared/useThemedRoot';
import {
  DOCUMENT_UPLOAD_SLICE_KEY,
  uploadDismissed,
  uploadRemoved,
  uploadRetitled,
  uploadTyped,
  uploadTypedAll,
} from '../../../slices/documentUploadSlice';
import { NAV_SLICE_KEY } from '../../../slices/navSlice';
import styles from './UploadPanel.module.css';

const PROBLEM_KEY: Record<UploadProblem, string> = {
  extension: 'problem_extension',
  size: 'problem_size',
  read: 'problem_read',
  changed: 'problem_changed',
  encoding: 'problem_encoding',
  binary: 'problem_binary',
  empty: 'problem_empty_name',
  too_long: 'problem_long_name',
  taken: 'problem_taken',
  refused: 'problem_refused',
};

const BATCH_KEY: Record<BatchProblem, string> = {
  too_many: 'batch_too_many',
  too_large: 'batch_too_large',
};

interface TypeSelectProps {
  value: string | null;
  types: readonly DocumentTypeDto[];
  label: string;
  placeholder: string;
  disabled?: boolean;
  container: HTMLElement | null;
  onChange: (typeKey: string) => void;
}

const TypeSelect: React.FC<TypeSelectProps> = ({
  value,
  types,
  label,
  placeholder,
  disabled,
  container,
  onChange,
}) => (
  <Select
    value={value}
    disabled={disabled}
    onValueChange={(next: string | null) => {
      if (next) onChange(next);
    }}
  >
    <SelectTrigger size="sm" className={styles.type} aria-label={label}>
      <SelectValue>
        {(selected: unknown) => (
          <span className={styles.truncate}>
            {selected == null
              ? placeholder
              : (types.find((type) => type.key === selected)?.name ?? String(selected))}
          </span>
        )}
      </SelectValue>
    </SelectTrigger>
    <SelectContent className={styles.options} container={container ?? undefined}>
      {types.map((type) => (
        <SelectItem key={type.key} value={type.key}>
          {type.name}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

TypeSelect.displayName = 'TypeSelect';

interface UploadRowProps {
  entry: UploadEntry;
  problem: UploadProblem | null;
  types: readonly DocumentTypeDto[];
  container: HTMLElement | null;
  onSend: (id: string) => void;
}

const UploadRow: React.FC<UploadRowProps> = ({ entry, problem, types, container, onSend }) => {
  const t = useUploadText();
  const dispatch = useAppDispatch();
  const fileOnly = isFileProblem(entry.problem);
  // Stopped by its name: the field stays while the name is fixed, whatever it says.
  const renaming = entry.status === 'error' && isNameProblem(entry.problem);
  const busy = entry.status === 'reading' || entry.status === 'adding';
  const typeSelect = (
    <TypeSelect
      value={entry.typeKey}
      types={types}
      label={t('type_label', { name: entry.fileName })}
      placeholder={t('type_placeholder')}
      disabled={entry.status === 'adding'}
      container={container}
      onChange={(typeKey) => dispatch(uploadTyped({ id: entry.id, typeKey }))}
    />
  );

  return (
    <Item size="sm" className={styles.row}>
      <ItemMedia variant="icon" className={styles.icon}>
        <FileText />
      </ItemMedia>
      <ItemContent className={styles.named}>
        <ItemTitle title={entry.title}>
          {entry.title}
        </ItemTitle>
        {!fileOnly && !renaming && typeSelect}
      </ItemContent>
      <ItemActions>
        {busy && <Spinner compact aria-label={t('adding')} />}
        {problem !== null && (
          <CircleAlert role="img" aria-label={t('attention')} className={styles.attention} />
        )}
        {entry.status !== 'adding' && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('remove', { name: entry.fileName })}
            icon={<X />}
            onClick={() => dispatch(uploadRemoved(entry.id))}
          />
        )}
      </ItemActions>
      {entry.status === 'error' && entry.problem !== null && (
        <ItemFooter className={styles.problem}>
          {problem !== null && (
            <p role="alert" className={styles.message}>
              {problem === 'refused' && entry.message ? entry.message : t(PROBLEM_KEY[problem])}
            </p>
          )}
          {!fileOnly && (
            <div className={styles.fix}>
              {renaming && (
                <Input
                  className={styles.rename}
                  aria-label={t('rename_label', { name: entry.fileName })}
                  value={entry.title}
                  maxLength={UPLOAD_LIMITS.titleChars}
                  onChange={(event) =>
                    dispatch(uploadRetitled({ id: entry.id, title: event.target.value }))
                  }
                />
              )}
              {renaming && typeSelect}
              <Button
                variant="outline"
                size="sm"
                disabled={!canSendAlone(entry, problem)}
                onClick={() => onSend(entry.id)}
              >
                {t(renaming ? 'add_with_name' : 'try_again')}
              </Button>
            </div>
          )}
        </ItemFooter>
      )}
    </Item>
  );
};

UploadRow.displayName = 'UploadRow';

interface PanelBodyProps {
  projectId: string;
  projectName: string;
  workspaceId: string;
  section: UploadSection;
  entries: readonly UploadEntry[];
  /** Every section's files: a name is checked against all of them. */
  held: readonly UploadEntry[];
  batchError: BatchProblem | null;
  className?: string;
}

const PanelBody: React.FC<PanelBodyProps> = ({
  projectId,
  projectName,
  workspaceId,
  section,
  entries,
  held,
  batchError,
  className,
}) => {
  const t = useUploadText();
  const dispatch = useAppDispatch();
  const bridge = useMfeBridge();
  const [container, findThemedRoot] = useThemedRoot();
  const types = useApiQuery(apiRegistry.getService(DocumentsApiService).types({ workspaceId }));
  const typeList = types.data?.items ?? [];
  const { documents } = useProjectDocuments(workspaceId, projectId);
  const titles = useMemo(() => documents.map((document) => document.title), [documents]);

  const summary = uploadSummary(entries);
  const ready = addableIds(entries);
  // The rows "Type for all files" fills.
  const typable = summary.pending.filter(
    (entry) => entry.status !== 'adding' && !isFileProblem(entry.problem)
  );
  const commonType =
    typable.length > 0 && typable.every((entry) => entry.typeKey === typable[0].typeKey)
      ? typable[0].typeKey
      : null;
  const send = (ids: string[]): void =>
    requestDocumentsUpload({ projectId, project: projectName, workspaceId, ids });

  const status = [
    summary.added > 0 && t.count('status_added', summary.added),
    summary.adding > 0 && t.count('status_adding', summary.adding),
    summary.attention && t('status_attention'),
    entries.length === 0 && t('status_not_started'),
  ]
    .filter(Boolean)
    .join(' · ');
  const dismissable = summary.pending.length === 0;
  const opened = summary.firstAdded;
  const openedId = opened?.documentId ?? null;

  return (
    <section
      ref={findThemedRoot}
      aria-label={t('panel_label')}
      className={className ? `${styles.panel} ${className}` : styles.panel}
    >
      {(status || dismissable) && (
        <div className={styles.head}>
          <p role="status" className={styles.status}>
            {status}
          </p>
          {dismissable && (
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('dismiss')}
              icon={<X />}
              onClick={() => dispatch(uploadDismissed(section))}
            />
          )}
        </div>
      )}
      {opened && openedId && (
        <Button
          variant="link"
          size="sm"
          className={styles.open}
          onClick={() => requestOpenDocument(bridge, projectId, { id: openedId, title: opened.title })}
        >
          {t('open_document', { title: opened.title })}
        </Button>
      )}
      {batchError && (
        <p role="alert" className={styles.error}>
          {t(BATCH_KEY[batchError])}
        </p>
      )}
      {types.isError && (
        <p role="alert" className={styles.error}>
          {t('types_failed')}
        </p>
      )}
      {summary.waiting && (
        <div className={styles.toolbar}>
          <TypeSelect
            value={commonType}
            types={typeList}
            label={t('type_for_all')}
            placeholder={t('type_for_all')}
            container={container}
            onChange={(typeKey) => dispatch(uploadTypedAll({ section, typeKey }))}
          />
          <p className={styles.note}>{t('type_fixed_note')}</p>
          <Button size="sm" disabled={ready.length === 0} onClick={() => send(ready)}>
            {t.count('add_count', ready.length)}
          </Button>
        </div>
      )}
      {summary.pending.length > 0 && (
        <ScrollArea className={styles.scroll}>
          <ItemGroup aria-label={t('list_label')} className={styles.list}>
            {summary.pending.map((entry, index) => (
              <React.Fragment key={entry.id}>
                {index > 0 && <ItemSeparator className={styles.separator} />}
                <UploadRow
                  entry={entry}
                  problem={rowProblem(entry, held, titles)}
                  types={typeList}
                  container={container}
                  onSend={(id) => send([id])}
                />
              </React.Fragment>
            ))}
          </ItemGroup>
        </ScrollArea>
      )}
    </section>
  );
};

PanelBody.displayName = 'UploadPanelBody';

export const UploadPanel: React.FC<{
  projectId: string;
  projectName: string;
  className?: string;
}> = ({ projectId, projectName, className }) => {
  const { isLoaded } = useUploadTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const { workspace } = useWorkspace();
  const section = useAppSelector((state) => state[NAV_SLICE_KEY].section);
  const { entries, batchErrors } = useAppSelector((state) => state[DOCUMENT_UPLOAD_SLICE_KEY]);
  const shown = useMemo(
    () => entries.filter((entry) => entry.section === section),
    [entries, section]
  );

  if (!everLoaded || !workspace || !isUploadSection(section)) return null;
  const batchError = batchErrors[section] ?? null;
  if (shown.length === 0 && batchError === null) return null;
  return (
    <PanelBody
      projectId={projectId}
      projectName={projectName}
      workspaceId={workspace.id}
      section={section}
      entries={shown}
      held={entries}
      batchError={batchError}
      className={className}
    />
  );
};

UploadPanel.displayName = 'UploadPanel';
