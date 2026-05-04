interface InspectorHeaderProps {
  filter: string;
  onFilterChange: (filter: string) => void;
}

export function InspectorHeader({ filter, onFilterChange }: InspectorHeaderProps) {
  const filters = ["all", "ls", "read", "grep", "agent"];

  return (
    <div className="rp-head">
      <div>
        <div className="rp-eyebrow">Inspector &middot; Split</div>
        <h2 className="rp-title">Tool trace</h2>
      </div>
      <div className="rp-head-right">
        <div className="seg">
          {filters.map(f => (
            <button 
              key={f}
              className={`seg-btn ${filter === f ? 'seg-btn-on' : ''}`}
              onClick={() => onFilterChange(f)}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
