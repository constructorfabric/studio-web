import React, { useEffect, useRef } from 'react';
import { Upload } from 'lucide-react';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { Button } from '@gears-frontx/ui-kit';
import { useEverLoaded, useWorkspace } from '@constructor-studio/mfe-shared';
import { useUploadText, useUploadTranslations } from '../../../i18n';
import {
  UPLOAD_ACCEPT,
  batchProblem,
  decodeUploadText,
  isUploadSection,
  pickedEntry,
  type UploadRead,
} from '../../../model/documentUpload';
import { useProjectDocuments } from '../../../shared/useProjectDocuments';
import {
  DOCUMENT_UPLOAD_SLICE_KEY,
  uploadPicked,
  uploadRead,
} from '../../../slices/documentUploadSlice';
import { NAV_SLICE_KEY } from '../../../slices/navSlice';

function readFile(file: File): Promise<UploadRead> {
  return file.arrayBuffer().then(
    (bytes) => decodeUploadText(bytes, file.size),
    (): UploadRead => ({ problem: 'read' })
  );
}

export const UploadDocumentsButton: React.FC<{ projectId: string }> = ({ projectId }) => {
  const { isLoaded } = useUploadTranslations();
  const everLoaded = useEverLoaded(isLoaded);
  const t = useUploadText();
  const { workspace } = useWorkspace();
  const dispatch = useAppDispatch();
  const entries = useAppSelector((state) => state[DOCUMENT_UPLOAD_SLICE_KEY].entries);
  const section = useAppSelector((state) => state[NAV_SLICE_KEY].section);
  const { documents } = useProjectDocuments(workspace?.id ?? null, projectId);
  const input = useRef<HTMLInputElement>(null);

  const titles = useRef<string[]>([]);
  useEffect(() => {
    titles.current = documents.map((document) => document.title);
  }, [documents]);

  if (!everLoaded || !workspace || !isUploadSection(section)) return null;

  const pick = (files: File[]): void => {
    if (files.length === 0) return;
    const refused = batchProblem(
      entries.filter((entry) => entry.section === section),
      files
    );
    if (refused) {
      dispatch(uploadPicked({ section, entries: [], batchError: refused }));
      return;
    }
    const picked = files.map((file) => ({
      file,
      entry: pickedEntry(crypto.randomUUID(), section, file),
    }));
    dispatch(uploadPicked({ section, entries: picked.map(({ entry }) => entry), batchError: null }));
    for (const { file, entry } of picked) {
      if (entry.status !== 'reading') continue;
      void readFile(file).then((read) =>
        dispatch(uploadRead({ id: entry.id, read, existingTitles: titles.current }))
      );
    }
  };

  const onFilesChosen = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? []);
    // The same file picked again is a change too.
    event.target.value = '';
    pick(files);
  };

  return (
    <>
      <Button variant="outline" size="sm" icon={<Upload />} onClick={() => input.current?.click()}>
        {t('button')}
      </Button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={UPLOAD_ACCEPT}
        onChange={onFilesChosen}
      />
    </>
  );
};

UploadDocumentsButton.displayName = 'UploadDocumentsButton';
