// A button that opens a small menu under it: the row menu's look
// (`.prowmenu`, data-table.tsx) for anything else that offers a few actions
// behind one control. Closes on a pointer down outside and on Escape; the
// arrow keys move between the items.

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

export interface MenuItem {
  label: ReactNode;
  /** An icon drawn before the label. */
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Said on hover: why it is disabled, or what it does. */
  title?: string;
  danger?: boolean;
}

export function MenuButton({
  trigger,
  label,
  items,
  className,
  buttonClassName,
  heading,
}: {
  /** What the button shows. */
  trigger: ReactNode;
  /** Its accessible name and tooltip. */
  label: string;
  items: (MenuItem | null | false | undefined)[];
  className?: string;
  buttonClassName?: string;
  /** A line above the items. */
  heading?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const shown = items.filter((i): i is MenuItem => !!i);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const all = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const at = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <div className={["prowmenu", className].filter(Boolean).join(" ")} ref={root}>
      <button
        ref={button}
        type="button"
        className={buttonClassName}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div className="prowmenu-list menu-list" role="menu" id={menuId} onKeyDown={onMenuKey}>
          {heading && <div className="menu-heading">{heading}</div>}
          {shown.map((item, i) => (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon && (
                <span className="menu-ico" aria-hidden>
                  {item.icon}
                </span>
              )}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
