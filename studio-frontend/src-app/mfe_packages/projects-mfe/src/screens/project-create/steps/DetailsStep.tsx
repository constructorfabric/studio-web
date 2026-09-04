/** Step 1 — name, goal, owner, starting point. */

// @cpt-dod:cpt-studiofrontend-dod-project-create-owner:p1
import React, { useId } from 'react';
import { FileText, Files } from 'lucide-react';
import {
  Field,
  FieldLabel,
  Input,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Textarea,
} from '@gears-frontx/ui-kit';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { useProjectCreateText } from '../../../i18n';
import { CREATE_SLICE_KEY, editDraft } from '../../../slices/createSlice';
import { useCurrentUser } from '../../../shared/useCurrentUser';
import { displayName } from '../../../model/project';
import type { ProjectMode } from '../../../api/types.ts';
import type { User } from '../../../api/types';
import styles from '../NewProjectWizard.module.css';

/** Two letters at most, like the mockup's avatar. */
function initials(user: User): string {
  const parts = displayName(user).split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]!.toUpperCase()).join('') || '?';
}

const UserRow: React.FC<{ user: User }> = ({ user }) => (
  <>
    <span className={styles.ownerAvatar} aria-hidden="true">
      {initials(user)}
    </span>
    <span className={styles.ownerText}>
      <span className={styles.ownerName}>{displayName(user)}</span>
      {user.email ? <span className={styles.ownerEmail}>{user.email}</span> : null}
    </span>
  </>
);

UserRow.displayName = 'UserRow';

const UserRowPlaceholder: React.FC = () => (
  <>
    <Skeleton className={styles.ownerAvatarSkeleton} />
    <span className={styles.ownerText}>
      <Skeleton className={styles.ownerNameSkeleton} />
      <Skeleton className={styles.ownerEmailSkeleton} />
    </span>
  </>
);

UserRowPlaceholder.displayName = 'UserRowPlaceholder';

const MODES: readonly { value: ProjectMode; icon: React.ReactNode; titleKey: string; hintKey: string }[] = [
  {
    value: 'greenfield',
    icon: <FileText size={18} strokeWidth={1.5} />,
    titleKey: 'mode_scratch',
    hintKey: 'mode_scratch_hint',
  },
  {
    value: 'modernize',
    icon: <Files size={18} strokeWidth={1.5} />,
    titleKey: 'mode_import',
    hintKey: 'mode_import_hint',
  },
];

/**
 * The owner, shown and not chosen: whoever creates the project owns it.
 */
const OwnerField: React.FC = () => {
  const t = useProjectCreateText();
  const { asUser: me } = useCurrentUser();

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{t('field_owner')}</span>
      <span className={styles.owner}>
        {me ? <UserRow user={me} /> : <UserRowPlaceholder />}
      </span>
    </div>
  );
};

OwnerField.displayName = 'OwnerField';

export const DetailsStep: React.FC = () => {
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state[CREATE_SLICE_KEY].draft);
  const ids = { name: useId(), goal: useId(), modeLabel: useId() };

  return (
    <>
      <Field>
        <FieldLabel className={styles.fieldLabel} htmlFor={ids.name}>
          {t('field_name')}
        </FieldLabel>
        <Input
          id={ids.name}
          value={draft.name}
          onChange={(event) => dispatch(editDraft({ name: event.target.value }))}
          autoFocus
        />
      </Field>

      <Field>
        <FieldLabel className={styles.fieldLabel} htmlFor={ids.goal}>
          {t('field_goal')}
        </FieldLabel>
        <Textarea
          id={ids.goal}
          className={styles.goal}
          rows={3}
          value={draft.goal}
          onChange={(event) => dispatch(editDraft({ goal: event.target.value }))}
        />
      </Field>

      <OwnerField />

      <Field>
        <FieldLabel className={styles.fieldLabel} id={ids.modeLabel}>
          {t('field_starting_point')}
        </FieldLabel>
        <RadioGroup
          aria-labelledby={ids.modeLabel}
          className={styles.modes}
          value={draft.mode ?? ''}
          onValueChange={(value: string) => dispatch(editDraft({ mode: value as ProjectMode }))}
        >
          {MODES.map((mode) => (
            <label
              key={mode.value}
              className={styles.modeCard}
              data-selected={draft.mode === mode.value ? '' : undefined}
            >
              <RadioGroupItem className={styles.modeInput} value={mode.value} />
              <span className={styles.modeHead}>
                {mode.icon}
                <span className={styles.modeTitle}>{t(mode.titleKey)}</span>
              </span>
              <span className={styles.modeHint}>{t(mode.hintKey)}</span>
            </label>
          ))}
        </RadioGroup>
      </Field>
    </>
  );
};

DetailsStep.displayName = 'DetailsStep';
