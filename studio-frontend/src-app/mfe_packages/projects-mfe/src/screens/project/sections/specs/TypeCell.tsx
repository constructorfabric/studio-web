import React from 'react';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@gears-frontx/ui-kit';
import { useAppSelector, useFormatters } from '@gears-frontx/react';
import { ChevronDown } from 'lucide-react';
import type { DecideBindingDto, DocumentTypeDto } from '../../../../api/documentTypes';
import type { SpecRow } from '../../../../model/specRows';
import { requestTypeDecision } from '../../../../actions/typeDecisionActions';
import { TYPE_DECISION_SLICE_KEY } from '../../../../slices/typeDecisionSlice';
import { useSpecsText } from '../../../../i18n';
import styles from './TypeCell.module.css';

/** The radio values of the two states that are not a type. */
const UNKNOWN = '__unknown';
const REJECTED = '__rejected';

export interface TypeCellProps {
  row: SpecRow;
  /** What the menu offers: #689's `snapshot.types`. */
  types: readonly DocumentTypeDto[];
  projectId: string;
  workspaceId: string;
  /** The themed root the menu portals into. */
  container?: HTMLElement | null;
}

/** The Specs list's Type cell: the row's type, and the menu that decides it (#690). */
export const TypeCell: React.FC<TypeCellProps> = ({
  row,
  types,
  projectId,
  workspaceId,
  container,
}) => {
  const t = useSpecsText();
  const { formatPercent } = useFormatters();
  const pending = useAppSelector((state) =>
    state[TYPE_DECISION_SLICE_KEY].pending.includes(row.id)
  );

  if (row.origin === 'repository' && !row.typeEditable) {
    return <span className={styles.muted}>{t('type_not_scanned')}</span>;
  }

  const { type } = row;
  const label = !type ? (
    t('type_set')
  ) : (
    <>
      {type.name}
      {type.proposed && (
        <span className={styles.muted}>
          {' · '}
          {t('type_proposed')}
          {type.confidence !== null && ` ${formatPercent(type.confidence)}`}
        </span>
      )}
    </>
  );
  if (!row.typeEditable) return <span>{label}</span>;

  const decide = (decision: DecideBindingDto): void =>
    requestTypeDecision({ projectId, workspaceId, bindingId: row.id, name: row.name, decision });
  const current = row.state === 'not_a_document' ? REJECTED : (type?.key ?? UNKNOWN);
  // A radio item's click, not the group's change: picking the proposed type,
  // which is already marked, confirms it.
  const pick = (value: string): void => {
    if (type?.proposed && value === type.key) decide({ action: 'confirm' });
    else if (value === current) return;
    else if (value === UNKNOWN) decide({ action: 'reset' });
    else if (value === REJECTED) decide({ action: 'reject' });
    else decide({ action: 'set', type_key: value });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('type_change', { name: row.name })}
            loading={pending}
            end={<ChevronDown size={14} strokeWidth={1.5} />}
          >
            {label}
          </Button>
        }
      />
      <DropdownMenuContent align="start" container={container ?? undefined}>
        {type?.proposed && (
          <>
            <DropdownMenuItem onClick={() => decide({ action: 'confirm' })}>
              {t('type_confirm', { type: type.name })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuRadioGroup value={current}>
          {types.map((option) => (
            <DropdownMenuRadioItem
              closeOnClick
              key={option.key}
              value={option.key}
              onClick={() => pick(option.key)}
            >
              {option.name}
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem closeOnClick value={UNKNOWN} onClick={() => pick(UNKNOWN)}>
            {t('type_unknown')}
          </DropdownMenuRadioItem>
          {/* A rejected row leaves the default view; the *Not specifications* filter brings it back. */}
          <DropdownMenuRadioItem closeOnClick value={REJECTED} onClick={() => pick(REJECTED)}>
            {t('type_reject')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

TypeCell.displayName = 'TypeCell';
