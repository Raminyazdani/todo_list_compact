"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { AlertCircle, ArrowUpRight, LoaderCircle, Plus, X } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
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
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className={`dialog ${wide ? "wide" : ""}`}
          aria-describedby={undefined}
        >
          <div className="dialog-heading">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="icon-button" aria-label="Close / بستن">
              <X size={19} />
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
  return (
    <label className="field">
      <span>{label}</span>
      {children}
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
      <div className="empty-icon">
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
        <AlertCircle size={20} />
        <span>{error}</span>
        <Button onClick={retry}>تلاش دوباره / Retry</Button>
      </div>
    );
  if (loading)
    return (
      <div className="loading-state" role="status">
        <LoaderCircle className="spin" size={22} />
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
export function Progress({ value, max }: { value: number; max: number }) {
  return (
    <div
      className="progress"
      role="progressbar"
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
