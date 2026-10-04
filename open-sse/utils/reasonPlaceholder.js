// Registry + helpers for the `reason` schema placeholder.
//
// Why this exists: Antigravity/Gemini VALIDATED tool calling rejects object
// schemas with no `properties`, so the request translators inject a synthetic
// `{reason: string, required:["reason"]}` (see cleanJSONSchemaForAntigravity in
// translator/formats/gemini.js and executors/antigravity.js). The injected
// field is a wire-only workaround — the client's own validator does not know
// about it and rejects `reason` as an unexpected parameter (and for free-form
// map objects the placeholder also blocks real dynamic keys). Both sides of the
// workaround must therefore live inside the gateway:
//
//   request side  → inject `reason` into the declared schema so upstream
//                   accepts the tool
//   response side → strip `reason` back out of functionCall.args before the
//                   tool_call reaches the client
//
// This module carries the injection locations from request to response:
//   WeakMap<body, Map<sanitizedToolName, path[][]>>
// where each path is expressed in args space (`"items"` → "*", which matches
// every element of an array or every key of a plain object).

const reasonPlaceholderRegistry = new WeakMap();

// Canonical injected-property template (single source for both injectors).
export const REASON_PLACEHOLDER_PROP = {
  type: "string",
  description: "Brief explanation of why you are calling this tool"
};

// Hidden carrier on intermediate translator objects (gemini base → envelope).
// Non-enumerable so it never serializes onto the wire.
export const REASON_PLACEHOLDER_KEY = "_reasonPlaceholderMap";

function hideOn(obj, map) {
  Object.defineProperty(obj, REASON_PLACEHOLDER_KEY, { value: map, enumerable: false, configurable: true, writable: true });
}

const pathKey = path => path.join("");

// Merge paths for one tool into an accumulating Map, deduping identical paths.
export function recordPlaceholderPaths(map, toolName, paths) {
  if (!toolName || !paths?.length) return;
  let list = map.get(toolName);
  if (!list) {
    list = [];
    map.set(toolName, list);
  }
  const seen = new Set(list.map(pathKey));
  for (const p of paths) {
    const k = pathKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      list.push(p);
    }
  }
}

// Merge a placeholder-path map onto the request body that executor.execute
// receives. `body` must be the same object reference chatCore hands to the
// executor (translateRequest's return value). Later calls merge, so the
// translator (schema cleaning) and the executor (missing-parameters fallback)
// can both contribute.
export function registerReasonPlaceholders(body, map) {
  if (!body || typeof body !== "object" || !map?.size) return;
  const existing = takeReasonPlaceholderMap(body) || new Map();
  for (const [name, paths] of map) recordPlaceholderPaths(existing, name, paths);
  reasonPlaceholderRegistry.set(body, existing);
}

// Read the map for a request body. Called by chatCore after executor.execute
// and threaded into response state.
export function takeReasonPlaceholderMap(body) {
  if (!body || typeof body !== "object") return null;
  const hidden = body[REASON_PLACEHOLDER_KEY];
  if (hidden instanceof Map && hidden.size > 0) return hidden;
  return reasonPlaceholderRegistry.get(body) || null;
}


// Internal: let wrappers stash a collected map on an intermediate object that
// is not itself the final request body (envelopes re-read it and re-register).
export function attachReasonPlaceholderMap(intermediate, map) {
  if (!intermediate || typeof intermediate !== "object" || !map?.size) return;
  hideOn(intermediate, map);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out;
  }
  return value;
}

// Remove `reason` at one recorded path inside `node`. The path identifies the
// injected object itself; once every segment is consumed, `reason` is deleted
// on the node we land on. "*" matches every element of an array and every
// value of a plain object (items-space paths).
function stripAt(node, path, depth) {
  if (!node || typeof node !== "object") return;
  if (depth === path.length) {
    if (!Array.isArray(node) && "reason" in node) delete node.reason;
    return;
  }
  const seg = path[depth];
  if (seg === "*") {
    const targets = Array.isArray(node) ? node : Object.values(node);
    for (const child of targets) stripAt(child, path, depth + 1);
    return;
  }
  stripAt(node[seg], path, depth + 1);
}

// Strip injected `reason` placeholders from a tool_call's parsed arguments.
// `toolName` must be the wire (possibly sanitized) name — the same key the
// request side recorded under. Returns a new args object; input is untouched.
// Unknown tools / unrecorded tools / missing map return the args unchanged.
export function stripReasonPlaceholders(toolName, args, map) {
  if (!map || typeof map.get !== "function" || !args || typeof args !== "object" || Array.isArray(args)) return args;
  const paths = map.get(toolName);
  if (!paths || paths.length === 0) return args;

  const out = deepClone(args);
  for (const path of paths) stripAt(out, path, 0);
  return out;
}
