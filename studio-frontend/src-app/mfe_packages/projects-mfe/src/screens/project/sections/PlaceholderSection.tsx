import React from 'react';
import styles from '../ProjectScreen.module.css';

export const PlaceholderSection: React.FC<{ title: string; note: string }> = ({ title, note }) => (
  <section className={styles.placeholder}>
    <p className={styles.placeholderTitle}>{title}</p>
    <p className={styles.emptyNote}>{note}</p>
  </section>
);

PlaceholderSection.displayName = 'PlaceholderSection';
