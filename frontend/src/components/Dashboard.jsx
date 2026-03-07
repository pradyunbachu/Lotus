import { useMemo } from "react";

const NODE_TYPE_COLORS = {
  current: "#e8548e",
  future: "#eab308",
  high_cost: "#9d174d",
  intervention: "#22c55e",
};

const NODE_TYPE_LABELS = {
  current: "Current",
  future: "Future Risk",
  high_cost: "High Cost",
  intervention: "Intervention",
};

function CostChart({ data }) {
  const W = 480, H = 180, PL = 58, PR = 16, PT = 16, PB = 32;
  const cw = W - PL - PR, ch = H - PT - PB;
  const max = Math.max(...data, 1);
  const step = cw / (data.length - 1);

  const points = data.map((v, i) => ({
    x: PL + i * step,
    y: PT + ch - (v / max) * ch,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
  const areaPath = `${linePath} L${points[points.length - 1].x},${PT + ch} L${points[0].x},${PT + ch} Z`;

  // Y-axis ticks
  const ticks = 4;
  const yLabels = Array.from({ length: ticks + 1 }, (_, i) => Math.round((max / ticks) * i));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="cost-chart" preserveAspectRatio="xMidYMid meet">
      {/* Grid lines */}
      {yLabels.map((val) => {
        const y = PT + ch - (val / max) * ch;
        return (
          <g key={val}>
            <line x1={PL} y1={y} x2={W - PR} y2={y} stroke="#f3f4f6" strokeWidth="1" />
            <text x={PL - 8} y={y + 3.5} textAnchor="end" fill="#9ca3af" fontSize="9" fontFamily="inherit">
              ${val >= 1000 ? `${(val / 1000).toFixed(1)}k` : val}
            </text>
          </g>
        );
      })}

      {/* Area fill */}
      <path d={areaPath} fill="url(#oopGradient)" />
      <defs>
        <linearGradient id="oopGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8548e" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#e8548e" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Line */}
      <path d={linePath} fill="none" stroke="#e8548e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

      {/* Data points + labels */}
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="4" fill="#ffffff" stroke="#e8548e" strokeWidth="2" />
          <text x={p.x} y={p.y - 10} textAnchor="middle" fill="#e8548e" fontSize="9" fontWeight="600" fontFamily="inherit">
            ${data[i] >= 1000 ? `${(data[i] / 1000).toFixed(1)}k` : Math.round(data[i])}
          </text>
          <text x={p.x} y={H - 8} textAnchor="middle" fill="#6b7280" fontSize="9.5" fontWeight="500" fontFamily="inherit">
            Year {i + 1}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function Dashboard({ graph, comparisonGraph, onNodeSelect }) {
  const {
    totalCost,
    totalOop,
    currentNodes,
    futureNodes,
    highCostNodes,
    riskNodes,
    highestRisk,
    costBreakdown,
    timeline,
    yearlyOop,
  } = useMemo(() => {
    if (!graph || !graph.nodes) {
      return {
        totalCost: 0,
        totalOop: 0,
        currentNodes: [],
        futureNodes: [],
        highCostNodes: [],
        riskNodes: [],
        highestRisk: null,
        costBreakdown: { current: 0, future: 0 },
        timeline: {},
        yearlyOop: [0, 0, 0, 0, 0],
      };
    }

    const current = graph.nodes.filter((n) => n.node_type === "current");
    const future = graph.nodes.filter((n) => n.node_type === "future");
    const highCost = graph.nodes.filter((n) => n.node_type === "high_cost");

    // All risk nodes (future + high_cost), sorted by probability descending
    const risks = [...future, ...highCost].sort(
      (a, b) => (b.probability || 0) - (a.probability || 0)
    );

    // Highest risk condition
    const highest = risks.length > 0 ? risks[0] : null;

    // Cost breakdown
    const currentCost = current.reduce((s, n) => s + (n.annual_cost || 0), 0) * 5;
    const futureCost = risks.reduce(
      (s, n) => s + (n.annual_cost || 0) * (n.probability || 0),
      0
    ) * 5;

    // Timeline grouped by year
    const tl = {};
    for (const n of graph.nodes) {
      if (n.node_type === "intervention") continue;
      const y = n.year || 0;
      if (!tl[y]) tl[y] = [];
      tl[y].push(n);
    }

    // Year-by-year OOP projection (years 1-5)
    const baseOop = current.reduce((s, n) => s + (n.oop_estimate || 0), 0);
    const oop = [0, 0, 0, 0, 0];
    for (let yr = 1; yr <= 5; yr++) {
      oop[yr - 1] = baseOop;
      for (const n of risks) {
        if ((n.year || 1) <= yr) {
          oop[yr - 1] += (n.oop_estimate || 0) * (n.probability || 0);
        }
      }
    }

    return {
      totalCost: graph.total_5yr_cost || 0,
      totalOop: graph.total_5yr_oop || 0,
      currentNodes: current,
      futureNodes: future,
      highCostNodes: highCost,
      riskNodes: risks,
      highestRisk: highest,
      costBreakdown: { current: currentCost, future: futureCost },
      timeline: tl,
      yearlyOop: oop,
    };
  }, [graph]);

  if (!graph || !graph.nodes || graph.nodes.length === 0) {
    return (
      <div className="graph-placeholder">
        <p>Speak or type your health profile to generate your care pathway.</p>
      </div>
    );
  }

  const costTotal = costBreakdown.current + costBreakdown.future;
  const currentPct = costTotal > 0 ? (costBreakdown.current / costTotal) * 100 : 0;
  const futurePct = costTotal > 0 ? (costBreakdown.future / costTotal) * 100 : 0;
  const timelineYears = Object.keys(timeline)
    .map(Number)
    .sort((a, b) => a - b);

  const handleNodeClick = (node) => {
    if (onNodeSelect) {
      onNodeSelect({
        id: node.id,
        label: node.label,
        nodeType: node.node_type,
        probability: node.probability,
        annualCost: node.annual_cost,
        oopEstimate: node.oop_estimate,
        year: node.year,
      });
    }
  };

  return (
    <div className="dashboard">
      {/* Summary Cards */}
      <div className="dashboard-summary">
        <div className="dashboard-card">
          <span className="dashboard-card-value">
            ${Math.round(totalCost).toLocaleString()}
          </span>
          <span className="dashboard-card-label">5-Year Total Cost</span>
        </div>
        <div className="dashboard-card">
          <span className="dashboard-card-value oop">
            ${Math.round(totalOop).toLocaleString()}
          </span>
          <span className="dashboard-card-label">5-Year Out-of-Pocket</span>
        </div>
        <div className="dashboard-card">
          <span className="dashboard-card-value">
            {futureNodes.length + highCostNodes.length}
          </span>
          <span className="dashboard-card-label">Risk Conditions</span>
        </div>
        <div className="dashboard-card">
          {highestRisk ? (
            <>
              <span className="dashboard-card-value risk">
                {(highestRisk.probability * 100).toFixed(0)}%
              </span>
              <span className="dashboard-card-label">
                {highestRisk.label?.split("\n")[0]}
              </span>
            </>
          ) : (
            <>
              <span className="dashboard-card-value">--</span>
              <span className="dashboard-card-label">No Risks Found</span>
            </>
          )}
        </div>
      </div>

      {/* Top Risks */}
      {riskNodes.length > 0 && (
        <div className="dashboard-section">
          <div className="dashboard-section-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <span>Top Risks</span>
          </div>
          <div className="dashboard-risks">
            {riskNodes.map((node) => {
              const prob = (node.probability || 0) * 100;
              const color = NODE_TYPE_COLORS[node.node_type] || "#eab308";
              return (
                <div
                  key={node.id}
                  className="dashboard-risk-row"
                  onClick={() => handleNodeClick(node)}
                >
                  <div className="dashboard-risk-info">
                    <span
                      className="dashboard-risk-dot"
                      style={{ background: color }}
                    />
                    <span className="dashboard-risk-name">
                      {node.label?.split("\n")[0]}
                    </span>
                    <span className="dashboard-risk-badge" style={{ background: color }}>
                      {NODE_TYPE_LABELS[node.node_type] || "Risk"}
                    </span>
                  </div>
                  <div className="dashboard-risk-bar-wrap">
                    <div className="likelihood-bar-track">
                      <div
                        className="likelihood-bar-fill"
                        style={{
                          width: `${Math.min(prob, 100)}%`,
                          background: color,
                        }}
                      />
                    </div>
                  </div>
                  <div className="dashboard-risk-meta">
                    <span className="dashboard-risk-prob">{prob.toFixed(0)}%</span>
                    <span className="dashboard-risk-cost">
                      ${Math.round(node.annual_cost || 0).toLocaleString()}/yr
                    </span>
                    {node.year > 0 && (
                      <span className="dashboard-risk-year">Year {node.year}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cost Breakdown */}
      {costTotal > 0 && (
        <div className="dashboard-section">
          <div className="dashboard-section-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="1" x2="12" y2="23" />
              <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
            <span>Cost Breakdown</span>
          </div>
          <div className="dashboard-cost-bar-container">
            <div className="dashboard-cost-bar">
              <div
                className="dashboard-cost-bar-segment current"
                style={{ width: `${currentPct}%` }}
                title={`Current: $${Math.round(costBreakdown.current).toLocaleString()}`}
              />
              <div
                className="dashboard-cost-bar-segment future"
                style={{ width: `${futurePct}%` }}
                title={`Future: $${Math.round(costBreakdown.future).toLocaleString()}`}
              />
            </div>
            <div className="dashboard-cost-legend">
              <div className="dashboard-cost-legend-item">
                <span className="dashboard-cost-dot current" />
                <span>Current Conditions</span>
                <span className="dashboard-cost-legend-value">
                  ${Math.round(costBreakdown.current).toLocaleString()}
                </span>
              </div>
              <div className="dashboard-cost-legend-item">
                <span className="dashboard-cost-dot future" />
                <span>Future Risks</span>
                <span className="dashboard-cost-legend-value">
                  ${Math.round(costBreakdown.future).toLocaleString()}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cost Over Time */}
      {yearlyOop.some((v) => v > 0) && (
        <div className="dashboard-section">
          <div className="dashboard-section-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
            <span>Projected Annual Out-of-Pocket</span>
          </div>
          <CostChart data={yearlyOop} />
        </div>
      )}

      {/* Timeline */}
      {timelineYears.length > 0 && (
        <div className="dashboard-section">
          <div className="dashboard-section-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <span>Timeline</span>
          </div>
          <div className="dashboard-timeline">
            {timelineYears.map((year) => (
              <div key={year} className="dashboard-timeline-col">
                <div className="dashboard-timeline-header">
                  {year === 0 ? "Now" : `Year ${year}`}
                </div>
                <div className="dashboard-timeline-chips">
                  {timeline[year].map((node) => {
                    const prob = (node.probability || 0) * 100;
                    const color = NODE_TYPE_COLORS[node.node_type] || "#94a3b8";
                    return (
                      <div
                        key={node.id}
                        className="dashboard-timeline-chip"
                        style={{ borderLeftColor: color }}
                        onClick={() => handleNodeClick(node)}
                      >
                        <span className="dashboard-chip-name">
                          {node.label?.split("\n")[0]}
                        </span>
                        {node.node_type !== "current" && (
                          <span className="dashboard-chip-prob">
                            {prob.toFixed(0)}%
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
