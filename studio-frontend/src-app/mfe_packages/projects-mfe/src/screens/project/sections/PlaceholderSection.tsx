import React from 'react';
import styles from '../ProjectScreen.module.css';

/**
 * A rail entry whose data lives in a gear that does not exist yet. Named, so the
 * navigation matches the design, and honest about why it is empty.
 */
export const PlaceholderSection: React.FC<{ title: string; note: string }> = ({ title, note }) => (
  <div className={styles.placeholder}>
    <p className={styles.placeholderTitle}>{title}</p>
    <p className={styles.emptyNote}>{note}</p>
  </div>
);

PlaceholderSection.displayName = 'PlaceholderSection';
