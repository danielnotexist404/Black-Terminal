import { Check, FlaskConical, X } from "lucide-react";
import type { CodeSuggestion } from "../types/ai.types";

type CodeSuggestionsPanelProps = {
  suggestions: CodeSuggestion[];
  onChange: (suggestions: CodeSuggestion[]) => void;
};

export function CodeSuggestionsPanel({ suggestions, onChange }: CodeSuggestionsPanelProps) {
  const updateStatus = (id: string, status: CodeSuggestion["status"]) => {
    onChange(suggestions.map((suggestion) => suggestion.id === id ? { ...suggestion, status } : suggestion));
  };

  return (
    <div className="strategy-panel code-suggestions-panel">
      <div className="strategy-panel-head">
        <span>CODE SUGGESTIONS</span>
        <b>{suggestions.length}</b>
      </div>
      <div className="code-suggestion-list">
        {suggestions.length === 0 ? (
          <div className="strategy-empty-state">RUN AI REVIEW</div>
        ) : suggestions.map((suggestion) => (
          <div className={`code-suggestion ${suggestion.status}`} key={suggestion.id}>
            <div className="code-suggestion-head">
              <div>
                <strong>{suggestion.title}</strong>
                <span>{suggestion.patchType.toUpperCase()} / {(suggestion.confidence * 100).toFixed(0)}%</span>
              </div>
              <b>{suggestion.status}</b>
            </div>
            <p>{suggestion.reason}</p>
            <p>{suggestion.expectedImpact}</p>
            <em>{suggestion.risk}</em>
            <pre>{suggestion.pseudoCode}</pre>
            <div className="code-suggestion-actions">
              <button type="button" onClick={() => updateStatus(suggestion.id, "accepted")}><Check size={13} /> Apply</button>
              <button type="button" onClick={() => updateStatus(suggestion.id, "rejected")}><X size={13} /> Reject</button>
              <button type="button" onClick={() => updateStatus(suggestion.id, "queued-test")}><FlaskConical size={13} /> Test</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
