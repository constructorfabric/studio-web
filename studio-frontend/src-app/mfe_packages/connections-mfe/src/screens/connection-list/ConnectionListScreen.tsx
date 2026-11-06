import React, { useState } from 'react';
import { Network, Search } from 'lucide-react';
import {
  Button,
  Empty,
  EmptyActions,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Input,
  Skeleton,
} from '@gears-frontx/ui-kit';
import { useMfeBridge } from '@gears-frontx/react';
import { SectionHeader } from '@constructor-studio/mfe-shared';
import { useConnectionListScreenTranslations, useConnectionListText } from '../../i18n';
import { useConnectionList } from '../../shared/useConnectionList';
import { openConnectDialog } from '../../actions/connectActions';
import { ConnectionsTable } from './components/ConnectionsTable';
import styles from './ConnectionListScreen.module.css';

export const ConnectionListScreen: React.FC = () => {
  const { isLoaded, error: translationsFailed } = useConnectionListScreenTranslations();
  const t = useConnectionListText();
  const bridge = useMfeBridge();
  const [query, setQuery] = useState('');

  const { rows, loading, failed, org, total } = useConnectionList(query);
  const busy = (!isLoaded && !translationsFailed) || loading;

  return (
    <div className={styles.screen}>
      <SectionHeader
        title={t('title')}
        busy={busy}
        actions={
          <Button size="sm" onClick={() => openConnectDialog(bridge)}>
            {t('connect_source')}
          </Button>
        }
      />

      <section className={styles.body}>
        {/* TODO: DataGrid's text search replaces this row. */}
        <div className={styles.searchRow}>
          <div className={styles.searchBox}>
            <Input
              className={styles.search}
              type="search"
              value={query}
              icon={<Search size={16} strokeWidth={1.3} />}
              placeholder={t('search_placeholder')}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t('search_placeholder')}
            />
          </div>
        </div>

        {busy ? (
          <div className={styles.rowsSkeleton}>
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
            <Skeleton className={styles.rowSkeleton} />
          </div>
        ) : failed || translationsFailed ? (
          <p className={styles.state}>
            {translationsFailed ? 'Could not load this screen.' : t('error_title')}
          </p>
        ) : (
          <ConnectionsTable
            rows={rows}
            tenantId={org?.id ?? ''}
            empty={
              total > 0 ? (
                <Empty className={styles.empty}>
                  <EmptyHeader>
                    <EmptyDescription>{t('empty_no_match')}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyActions>
                    <Button variant="link" onClick={() => setQuery('')}>
                      {t('clear_search')}
                    </Button>
                  </EmptyActions>
                </Empty>
              ) : (
                <Empty className={styles.empty}>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Network />
                    </EmptyMedia>
                    <EmptyTitle>{t('empty_title')}</EmptyTitle>
                    <EmptyDescription>{org ? t('empty_hint') : t('empty_no_org')}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )
            }
          />
        )}
        {!busy && !failed && !translationsFailed && rows.length > 0 ? (
          <footer className={styles.footer}>
            {t.count('count', rows.length)}
          </footer>
        ) : null}
      </section>
    </div>
  );
};

ConnectionListScreen.displayName = 'ConnectionListScreen';
