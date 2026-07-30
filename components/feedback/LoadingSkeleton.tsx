export function LoadingSkeleton({
  label,
  rows = 3,
}: {
  label: string;
  rows?: number;
}) {
  return (
    <div className="loading-skeleton" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="skeleton-line skeleton-heading" aria-hidden="true" />
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" aria-hidden="true" key={index}>
          <div className="skeleton-avatar" />
          <div className="skeleton-copy">
            <div className="skeleton-line" />
            <div className="skeleton-line short" />
          </div>
        </div>
      ))}
    </div>
  );
}
