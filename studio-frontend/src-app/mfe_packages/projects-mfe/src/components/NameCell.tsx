import React from 'react';
import styles from './NameCell.module.css';

interface NameCellProps {
  name: string;
  icon?: React.ReactNode;
  /** A name that opens something is a button; without it, plain text. */
  onOpen?: () => void;
}

/** The name column of the Artifacts and Specs tables: an icon and a name that wraps rather than truncates. */
export const NameCell: React.FC<NameCellProps> = ({ name, icon, onOpen }) => {
  const content = (
    <>
      {icon && (
        <span className={styles.icon} aria-hidden="true">
          {icon}
        </span>
      )}
      <span className={styles.name}>{name}</span>
    </>
  );
  if (!onOpen) return <span className={styles.cell}>{content}</span>;
  return (
    <button type="button" className={`${styles.cell} ${styles.button}`} onClick={onOpen}>
      {content}
    </button>
  );
};

NameCell.displayName = 'NameCell';
