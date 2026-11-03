"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, ArrowUpRight, LoaderCircle, Plus, X } from "lucide-react";
import {
  Children,
  cloneElement,
  isValidElement,
  useCallback,
  useId,
  useRef,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

function subscribeToDialogHost(notify: () => void) {
  const observer = new MutationObserver(notify);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-hidden", "data-state"],
  });
  return () => observer.disconnect();
}
function dialogHost() {
  return (
    document.querySelector<HTMLElement>(
      '[role="dialog"][data-state="open"]:not([aria-hidden="true"])',
    ) ?? document.body
  );
}
export function ToastPortal({ children }: { children: ReactNode }) {
  const host = useSyncExternalStore(
    subscribeToDialogHost,
    dialogHost,
    () => null,
  );
  return host ? createPortal(children, host) : null;
}

export function Button({
  children,
  variant = "",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string }) {
  return (
    <button className={`button ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Modal({
  title,
  open,
  onOpenChange,
  children,
  wide = false,
}: {
  title: string;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  const openerRecorded = useRef(false);
  const content = useRef<HTMLDivElement | null>(null);
  // Overlay commits before Content's autoFocus children. Keep this capture
  // through ref detach/re-attach and interrupted exits until the real close.
  const recordOpener = useCallback((node: HTMLDivElement | null) => {
    if (!node || openerRecorded.current) return;
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    openerRecorded.current = true;
  }, []);
  const available = (element: HTMLElement | null): element is HTMLElement =>
    !!element?.isConnected &&
    element.getClientRects().length > 0 &&
    !element.closest(
      '[inert],[aria-hidden="true"],[role="dialog"][data-state="closed"]',
    ) &&
    !element.matches(":disabled") &&
    !["hidden", "collapse"].includes(getComputedStyle(element).visibility);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay ref={recordOpener} className="dialog-overlay" />
        <Dialog.Content
          ref={content}
          className={`dialog ${wide ? "wide" : ""}`}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // There is no Dialog.Trigger in this controlled wrapper, so the
            // default Radix trigger restoration cannot restore an opener.
            event.preventDefault();
            if (
              content.current?.isConnected &&
              content.current.dataset.state === "open"
            )
              return;
            const target = available(opener.current)
              ? opener.current
              : [
                  ...document.querySelectorAll<HTMLElement>(
                    "[data-dialog-focus-fallback]",
                  ),
                  ...document.querySelectorAll<HTMLElement>(
                    'main[tabindex="-1"]',
                  ),
                ].find(available);
            opener.current = null;
            openerRecorded.current = false;
            const remainingDialog = [
              ...document.querySelectorAll<HTMLElement>(
                '[role="dialog"][data-state="open"]',
              ),
            ]
              .filter(available)
              .at(-1);
            if (
              remainingDialog &&
              (!target || !remainingDialog.contains(target))
            )
              return;
            target?.focus();
          }}
        >
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close / بستن">
              <X size={19} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const labelId = useId();
  return (
    <label className="field">
      <span id={labelId}>{label}</span>
      {Children.map(children, (child) =>
        isValidElement(child) &&
        typeof child.type === "string" &&
        ["input", "textarea", "select"].includes(child.type) &&
        (child.props as Record<string, unknown>)["aria-label"] === undefined &&
        (child.props as Record<string, unknown>)["aria-labelledby"] ===
          undefined
          ? cloneElement(child as ReactElement<Record<string, unknown>>, {
              "aria-labelledby":
                (child.props as Record<string, unknown>)["aria-labelledby"] ??
                labelId,
            })
          : child,
      )}
    </label>
  );
}
export function Empty({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden="true">
        <ArrowUpRight size={24} />
      </div>
      <h3>{title}</h3>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
export function QueryState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  if (error)
    return (
      <div className="error-state" role="alert">
        <AlertCircle size={20} aria-hidden="true" />
        <span>{error}</span>
        <Button onClick={retry}>تلاش دوباره / Retry</Button>
      </div>
    );
  if (loading)
    return (
      <div className="loading-state" role="status" aria-busy="true">
        <LoaderCircle className="spin" size={22} aria-hidden="true" />
        <span>در حال دریافت / Loading</span>
      </div>
    );
  return null;
}
export function SectionHeading({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-heading">
      <div>
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
export function AddButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <Button variant="primary" onClick={onClick}>
      <Plus size={16} />
      {children}
    </Button>
  );
}
export function Progress({
  value,
  max,
  label,
}: {
  value: number;
  max: number;
  label: string;
}) {
  return (
    <div
      className="progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max || 1}
      aria-valuenow={value}
    >
      <span
        style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }}
      />
    </div>
  );
}
