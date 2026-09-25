/**
 * Devin server-declared model families: collapse effort-tier siblings
 * (`swe-2-medium` / `swe-2-high` / `swe-2-max`, …) into one logical model that
 * carries an effort → sibling-wire-uid routing table. Port of oh-my-pi's
 * discovery lane collector (packages/catalog/src/discovery/devin.ts,
 * collectDevinFamilyLane + devinDynamicFamilies).
 *
 * A "lane" is one server-declared family slice: fast service and 1M context
 * split into separate logical models (`-fast` / `-1m` suffixes); reasoning
 * effort stays the lane's only selectable axis.
 */

/** Effort tokens in ladder order; `"off"` is the thinking-disabled route. */
export const DEVIN_EFFORT_LADDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Ladder without `"off"` — a lane must route at least one of these to collapse. */
const DEVIN_SELECTABLE_EFFORTS = DEVIN_EFFORT_LADDER.filter((effort) => effort !== "off");

/** `modelFamilyMetadata` entry keys that carry the family's effort axis. */
const DEVIN_FAMILY_EFFORT_KEYS = { effort: true, "reasoning effort": true };
/** `modelFamilyMetadata` entry key for the service-tier axis; order 1 is the fast lane. */
const DEVIN_FAMILY_FAST_KEY = "fast mode";
const DEVIN_FAMILY_FAST_ORDER = 1;
/** Boolean reasoning axis used by Claude families whose effort name alone is ambiguous. */
const DEVIN_FAMILY_THINKING_KEY = "thinking";
const DEVIN_FAMILY_THINKING_ORDER = 1;
/** Context-window axis; order 1 selects the separate 1M-context lane. */
const DEVIN_FAMILY_CONTEXT_1M_KEY = "1m context";
const DEVIN_FAMILY_CONTEXT_1M_ORDER = 1;

/** Effort-entry display names, normalized to a space-free token, mapped onto effort tokens. */
const DEVIN_FAMILY_EFFORT_BY_NAME = {
  none: "off",
  nothinking: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/**
 * File `config` under its server-declared family lane. Configs with no family
 * metadata, or whose family carries no effort axis, are left alone and stay
 * standalone specs.
 *
 * @param {Map<string, object>} lanes - lane accumulator keyed by logical id
 * @param {object} config - decoded ClientModelConfig
 * @param {string} uid - the config's wire modelUid
 */
export function collectDevinFamilyLane(lanes, config, uid) {
  const metadata = config?.modelFamilyMetadata;
  if (metadata === undefined) return;
  const label = String(metadata.modelFamilyLabel ?? "").trim();
  if (!label) return;

  let effort;
  let thinking;
  let fast = false;
  let oneMillionContext = false;
  for (const entry of metadata.entries ?? []) {
    const value = entry?.value;
    if (value === undefined) continue;
    // Keys collapse punctuation to spaces ("Reasoning Effort" -> "reasoning
    // effort"); effort names drop it entirely ("X High" and "XHigh" -> "xhigh").
    const key = String(entry.key ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (key === DEVIN_FAMILY_FAST_KEY) {
      fast = value.order === DEVIN_FAMILY_FAST_ORDER;
      continue;
    }
    if (key === DEVIN_FAMILY_THINKING_KEY) {
      thinking = value.order === DEVIN_FAMILY_THINKING_ORDER;
      continue;
    }
    if (key === DEVIN_FAMILY_CONTEXT_1M_KEY) {
      oneMillionContext = value.order === DEVIN_FAMILY_CONTEXT_1M_ORDER;
      continue;
    }
    if (DEVIN_FAMILY_EFFORT_KEYS[key]) {
      effort = DEVIN_FAMILY_EFFORT_BY_NAME[String(value.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "")];
    }
  }
  // Claude's paired non-thinking and thinking configs share the same "High"
  // effort label; its explicit Thinking axis decides whether the route is off.
  if (thinking === false) effort = "off";

  // Family label as a logical id: "GPT-5.6 Sol" -> "gpt-5-6-sol".
  const baseId = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!baseId) return;
  const laneId = `${baseId}${oneMillionContext ? "-1m" : ""}${fast ? "-fast" : ""}`;
  let lane = lanes.get(laneId);
  if (lane === undefined) {
    const name = `${label}${oneMillionContext ? " 1M" : ""}${fast ? " Fast" : ""}`;
    lane = { id: laneId, name, members: [], routing: {} };
    lanes.set(laneId, lane);
  }
  lane.members.push(uid);
  if (lane.defaultMember === undefined && (config.isDefaultModelInFamily || metadata.isDefaultModelInFamily)) {
    lane.defaultMember = uid;
  }
  if (effort !== undefined && lane.routing[effort] === undefined) {
    lane.routing[effort] = uid; // first claim wins on duplicate effort names
  }
}

/**
 * Collapse the lanes that declare an effort ladder into logical family
 * descriptors. The server-default wire uid is hoisted to the front of
 * `members` so collapsing adopts it as the logical model's default.
 *
 * A lane with no non-`off` effort route has nothing to route: its members stay
 * standalone rather than collapsing into a family with an empty effort list.
 *
 * @param {Iterable<object>} lanes - lanes from collectDevinFamilyLane
 *   (pass `map.values()` for a Map accumulator)
 * @returns {Array<object>} one descriptor per collapsed lane:
 *   `{ id, name, members, routing, defaultMember?, defaultLevel?, efforts, requiresEffort }`
 *   where `efforts` is the full routed ladder (including `"off"` when the
 *   family has a thinking-disabled twin).
 */
export function devinDynamicFamilies(lanes) {
  const families = [];
  for (const lane of lanes) {
    const selectable = DEVIN_SELECTABLE_EFFORTS.filter((effort) => lane.routing[effort] !== undefined);
    if (selectable.length === 0) continue;
    const defaultMember = lane.defaultMember;
    const members =
      defaultMember === undefined
        ? lane.members
        : [defaultMember, ...lane.members.filter((uid) => uid !== defaultMember)];
    // The tier the native client selects when the family is picked without an
    // explicit effort, recovered from whichever effort routes to the default
    // member. An `off`-only default has no effort to name.
    const defaultLevel =
      defaultMember === undefined ? undefined : selectable.find((effort) => lane.routing[effort] === defaultMember);
    families.push({
      id: lane.id,
      name: lane.name,
      members,
      routing: lane.routing,
      ...(defaultMember !== undefined ? { defaultMember } : {}),
      efforts: selectable,
      ...(defaultLevel !== undefined ? { defaultLevel } : {}),
      // No disabled tier upstream: there is no wire id that serves this
      // family with thinking disabled, so effort is mandatory.
      requiresEffort: lane.routing.off === undefined,
    });
  }
  return families;
}

