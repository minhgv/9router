// Clients append `[1m]` to a model id to select an extended-context variant.
// It is request metadata, not part of the upstream model identifier; preserve it
// separately for capability selection, then strip it before model dispatch.
// Claude additionally carries the capability in anthropic-beta, subject to the
// existing credential-aware policy gate.

const CONTEXT_MARKER = /\[1m\](?=-review$|$)/i;

// Returns { model, contextMarker } — contextMarker is null when there is none.
export function stripModelContextMarker(modelStr) {
  if (typeof modelStr !== "string") return { model: modelStr, contextMarker: null };
  const trimmed = modelStr.trim();
  const match = trimmed.match(CONTEXT_MARKER);
  if (!match) return { model: modelStr, contextMarker: null };
  return { model: trimmed.replace(CONTEXT_MARKER, "").trim(), contextMarker: match[0].slice(1, -1).toLowerCase() };
}
