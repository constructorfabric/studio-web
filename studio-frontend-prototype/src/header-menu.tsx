/* The "⋯" of a PageHeader (ui-standard.tsx): what a screen can do besides its
 * one primary action, in a menu that closes once an item is picked. */

import type { ReactNode } from "react";

import "./org-screens.css";

export function HeaderMenu({ label = "⋯", title = "More", children }: { label?: ReactNode; title?: string; children: ReactNode }) {
  return (
    <details className="org-menu" data-header-menu>
      <summary aria-label={title} title={title}>
        {label}
      </summary>
      <div
        className="org-menu-list"
        role="menu"
        onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).removeAttribute("open")}
      >
        {children}
      </div>
    </details>
  );
}
