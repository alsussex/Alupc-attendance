export default function DashboardPage() {
  return (
    <div className="page-stack">
      <div className="page-heading">
        <p className="eyebrow">Overview</p>
        <h1>Ready for the next service</h1>
        <p>Use Services to create a gathering, then select each person who attended.</p>
      </div>
      <section className="empty-panel">
        <span className="empty-icon" aria-hidden="true">✓</span>
        <h2>A simple start</h2>
        <p>Stage one focuses on people, services, and dependable offline attendance entry.</p>
        <a className="button primary" href="/services">Open services</a>
      </section>
    </div>
  );
}
