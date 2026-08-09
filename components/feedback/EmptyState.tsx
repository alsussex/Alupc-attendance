import type { ReactNode } from "react";

export function EmptyState({
  title,
  message,
  icon = "○",
  action,
  compact = false,
}: {
  title: string;
  message: string;
  icon?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "empty-state compact" : "empty-state"}>
      <span className="empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <h2>{title}</h2>
      <p>{message}</p>
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}
