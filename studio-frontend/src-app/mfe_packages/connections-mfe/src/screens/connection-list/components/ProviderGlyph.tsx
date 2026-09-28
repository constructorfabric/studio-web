import React from 'react';
import { iconFor } from '../../../model/connection';
import styles from '../ConnectionListScreen.module.css';

/**
 * The provider's mark. `title` rather than a label: the name is already in the
 * cell beside it, and repeating it to a screen reader is noise.
 */
export const ProviderGlyph: React.FC<{ code: string; label: string }> = ({ code, label }) => {
  const Icon = iconFor(code);
  return (
    <span className={styles.rowGlyph} title={label} aria-hidden>
      {/* eslint-disable-next-line react-hooks/static-components -- iconFor hands back a module-level lucide icon, the same one per code */}
      <Icon size={16} strokeWidth={1.3} />
    </span>
  );
};

ProviderGlyph.displayName = 'ProviderGlyph';
