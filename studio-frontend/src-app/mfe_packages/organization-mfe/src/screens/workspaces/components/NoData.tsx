import React from "react";
import styles from "../WorkspacesScreen.module.css";

/**
 * Muted placeholder for a cell with nothing to show. The label says which kind
 * of nothing, as a title rather than text, so the cell stays one dash wide.
 *
 * TODO: byte-identical to projects-mfe's `NoData` but for the styles import.
 * Lift both into `@constructor-studio/mfe-shared` once that package carries CSS
 * — today it is TS only, and one dash is not worth being the first stylesheet.
 */
export const NoData: React.FC<{ label: string }> = ({ label }) => (
  <span className={styles.noData} title={label}>
    —
  </span>
);

NoData.displayName = "NoData";
