import type { AIStrategyReview } from "../types/ai.types";

type AIReviewPanelProps = {
  review?: AIStrategyReview;
};

function ListBlock({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="ai-review-block">
      <strong>{title}</strong>
      {items.length === 0 ? <span>-</span> : items.map((item) => <span key={item}>{item}</span>)}
    </div>
  );
}

export function AIReviewPanel({ review }: AIReviewPanelProps) {
  if (!review) {
    return (
      <div className="strategy-panel ai-review-panel">
        <div className="strategy-panel-head"><span>AI REVIEW</span><b>WAITING</b></div>
        <div className="strategy-empty-state">RUN A BACKTEST</div>
      </div>
    );
  }

  return (
    <div className="strategy-panel ai-review-panel">
      <div className="strategy-panel-head">
        <span>AI REVIEW</span>
        <b>{review.ratings.liveReadiness}</b>
      </div>
      <div className="ai-summary">{review.summary}</div>
      <div className="ai-rating-grid">
        {Object.entries(review.ratings).map(([key, value]) => (
          <div key={key}>
            <span>{key}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="ai-review-grid">
        <ListBlock title="Strengths" items={review.strengths} />
        <ListBlock title="Weaknesses" items={review.weaknesses} />
        <ListBlock title="Failure Patterns" items={review.failurePatterns} />
        <ListBlock title="Filters" items={review.filterSuggestions} />
        <ListBlock title="Risk Warnings" items={review.riskWarnings} />
        <div className="ai-review-block">
          <strong>Parameter Suggestions</strong>
          {review.parameterSuggestions.length === 0 ? <span>-</span> : review.parameterSuggestions.map((item) => (
            <span key={`${item.parameter}-${item.suggestedValue}`}>{item.parameter}: {String(item.suggestedValue)} / {(item.confidence * 100).toFixed(0)}%</span>
          ))}
        </div>
      </div>
    </div>
  );
}
