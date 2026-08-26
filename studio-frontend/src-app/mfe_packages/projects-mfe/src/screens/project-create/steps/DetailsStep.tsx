/**
 * Step 1 — name, goal, owner, starting point.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-owner:p1
import React from 'react';
import { FileText, Files } from 'lucide-react';
import {
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from '@gears-frontx/ui-kit';
import { useAppDispatch, useAppSelector } from '@gears-frontx/react';
import { useProjectCreateText } from '../../../i18n';
import { CREATE_SLICE_KEY, editDraft } from '../../../slices/createSlice';
import { useBridge } from '../../../shared/bridge';
import { useCurrentUser } from '../../../shared/useCurrentUser';
import type { ProjectMode } from '../../../api/types.ts';
import type { User } from '../../../api/types';
import styles from '../NewProjectWizard.module.css';

/** Two letters at most, like the mockup's avatar. */
function initials(user: User): string {
  const source = user.display_name?.trim() || user.username;
  const parts = source.split(/\s+/).filter(Boolean).slice(0, 2);
  return parts.map((p) => p[0]!.toUpperCase()).join('') || '?';
}

function fullName(user: User): string {
  return user.display_name?.trim() || user.username;
}

const UserRow: React.FC<{ user: User }> = ({ user }) => (
  <span className={styles.owner}>
    <span className={styles.ownerAvatar} aria-hidden="true">
      {initials(user)}
    </span>
    <span className={styles.ownerText}>
      <span className={styles.ownerName}>{fullName(user)}</span>
      {user.email ? <span className={styles.ownerEmail}>{user.email}</span> : null}
    </span>
  </span>
);

UserRow.displayName = 'UserRow';

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
  const bridge = useBridge();
  const { asUser: me } = useCurrentUser(bridge);

  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{t('field_owner')}</span>
      {me ? <UserRow user={me} /> : null}
    </div>
  );
};

OwnerField.displayName = 'OwnerField';

export const DetailsStep: React.FC = () => {
  const t = useProjectCreateText();
  const dispatch = useAppDispatch();
  const draft = useAppSelector((state) => state[CREATE_SLICE_KEY].draft);

  return (
    <>
      <div className={styles.field}>
        <Label className={styles.fieldLabel} htmlFor="np-name">
          {t('field_name')}
        </Label>
        <Input
          id="np-name"
          value={draft.name}
          onChange={(event) => dispatch(editDraft({ name: event.target.value }))}
          autoFocus
        />
      </div>

      <div className={styles.field}>
        <Label className={styles.fieldLabel} htmlFor="np-goal">
          {t('field_goal')}
        </Label>
        <Textarea
          id="np-goal"
          className={styles.goal}
          rows={3}
          value={draft.goal}
          onChange={(event) => dispatch(editDraft({ goal: event.target.value }))}
        />
      </div>

      <OwnerField />

      <div className={styles.field}>
        <Label className={styles.fieldLabel}>{t('field_starting_point')}</Label>
        <RadioGroup
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
      </div>
    </>
  );
};

DetailsStep.displayName = 'DetailsStep';
