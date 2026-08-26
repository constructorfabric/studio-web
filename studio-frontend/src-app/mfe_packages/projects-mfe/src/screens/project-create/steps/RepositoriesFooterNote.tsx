// @cpt-dod:cpt-studiofrontend-dod-project-create-many-sources:p1
import React from 'react';
import { useAppSelector } from '@gears-frontx/react';
import { useProjectCreateText } from '../../../i18n';
import { MAX_SOURCES } from '../../../model/projectDraft';
import { CREATE_SLICE_KEY } from '../../../slices/createSlice';

export const RepositoriesFooterNote: React.FC = () => {
  const t = useProjectCreateText();
  const count = useAppSelector((state) => state[CREATE_SLICE_KEY].draft.sources.length);

  if (count === 0) return <>{t('selected_none')}</>;
  if (count >= MAX_SOURCES) return <>{t('selected_max', { n: count })}</>;
  if (count === 1) return <>{t('selected_one')}</>;
  return <>{t('selected_many', { n: count })}</>;
};

RepositoriesFooterNote.displayName = 'RepositoriesFooterNote';
