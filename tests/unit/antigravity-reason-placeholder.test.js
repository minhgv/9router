// The `reason` placeholder is a wire-only workaround for Antigravity VALIDATED
// mode (which rejects object schemas with no properties). translateRequest must
// still inject it upstream, but it must never reach the client: the recorded
// path map is threaded to the response translators, which strip it back out of
// emitted tool-call args. See open-sse/utils/reasonPlaceholder.js.
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";
import { openaiToAntigravityRequest } from "../../open-sse/translator/request/openai-to-gemini.js";
import { geminiToOpenAIResponse } from "../../open-sse/translator/response/gemini-to-openai.js";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import {
  stripReasonPlaceholders,
  takeReasonPlaceholderMap,
} from "../../open-sse/utils/reasonPlaceholder.js";

const MODEL = "gemini-3.8-flash-tiered";

function tool(name, parameters) {
  return { type: "function", function: { name, description: `${name} tool`, parameters } };
}

function requestWith(tools) {
  return {
    model: MODEL,
    messages: [{ role: "user", content: "call the tool" }],
    tools,
    stream: true,
  };
}

function functionCallChunk(name, args) {
  return {
    response: {
      responseId: "r1",
      candidates: [{
        content: { role: "model", parts: [{ functionCall: { id: `call_${name}`, name, args } }] },
      }],
    },
  };
}

function emittedArgs(name, args, map) {
  const state = { model: MODEL, sessionId: null, toolNameMap: null, reasonPlaceholderMap: map };
  const out = geminiToOpenAIResponse(functionCallChunk(name, args), state);
  expect(Array.isArray(out)).toBe(true);
  const tc = out.find(c => c?.choices?.[0]?.delta?.tool_calls?.length)?.choices[0].delta.tool_calls[0];
  expect(tc).toBeTruthy();
  return JSON.parse(tc.function.arguments);
}

describe("cleanJSONSchemaForAntigravity placeholder collection", () => {
  it("reports the args root for a strict empty object schema", () => {
    const paths = [];
    const cleaned = cleanJSONSchemaForAntigravity({ type: "object", properties: {} }, p => paths.push(p));
    expect(cleaned.required).toEqual(["reason"]);
    expect(cleaned.properties.reason.type).toBe("string");
    expect(paths).toEqual([[]]);
  });

  it("reports nested args-space paths for free-form objects", () => {
    const paths = [];
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        question: { type: "string" },
        answers: { type: "object", additionalProperties: { type: "string" } },
        rows: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    }, p => paths.push(p));
    expect(paths).toEqual([["answers"], ["rows", "*"]]);
    // Wire schema still carries the placeholder, upstream side unchanged.
    expect(cleaned.properties.answers.required).toEqual(["reason"]);
    expect(cleaned.properties.rows.items.required).toEqual(["reason"]);
  });

  it("collects nothing when every object has declared properties", () => {
    const paths = [];
    const cleaned = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: { reason: { type: "string" }, query: { type: "string" } },
    }, p => paths.push(p));
    expect(paths).toEqual([]);
    expect(cleaned.properties.reason.type).toBe("string");
  });
});

describe("openaiToAntigravityRequest records injection sites", () => {
  it("records root path for an empty-param tool and keeps the placeholder on the wire", () => {
    const env = openaiToAntigravityRequest(MODEL, requestWith([tool("TodoRead", { type: "object", properties: {} })]), true);
    const decl = env.request.tools[0].functionDeclarations.find(d => d.name === "TodoRead");
    expect(decl.parameters.required).toEqual(["reason"]);

    const map = takeReasonPlaceholderMap(env);
    expect(map).toBeInstanceOf(Map);
    expect(map.get("TodoRead")).toEqual([[]]);
  });

  it("records nested paths on the Claude model path", () => {
    const env = openaiToAntigravityRequest("claude-opus-4-6-thinking", requestWith([
      tool("AskUserQuestion", {
        type: "object",
        properties: {
          question: { type: "string" },
          annotations: { type: "object", additionalProperties: { type: "string" } },
        },
      }),
    ]), true);
    const map = takeReasonPlaceholderMap(env);
    expect(map.get("AskUserQuestion")).toEqual([["annotations"]]);
  });
});

describe("response-side stripping", () => {
  it("strips injected reason from streamed tool-call args", () => {
    const map = new Map([["TodoRead", [[]]]]);
    expect(emittedArgs("TodoRead", { reason: "checking progress" }, map)).toEqual({});
  });

  it("strips nested placeholders, keeps sibling dynamic keys", () => {
    const map = new Map([["AskUserQuestion", [["annotations"]]]]);
    const args = { question: "pick one", annotations: { reason: "x", a: "1", b: "2" } };
    expect(emittedArgs("AskUserQuestion", args, map)).toEqual({
      question: "pick one",
      annotations: { a: "1", b: "2" },
    });
  });

  it("strips inside array elements via items paths", () => {
    const map = new Map([["SaveWorkflow", [["rows", "*"]]]]);
    const args = { rows: [{ reason: "x", v: 1 }, { v: 2 }] };
    expect(emittedArgs("SaveWorkflow", args, map)).toEqual({ rows: [{ v: 1 }, { v: 2 }] });
  });

  it("never strips a reason that the client schema legitimately declares", () => {
    // Tool whose schema declares reason → no recorded paths → untouched.
    const map = new Map();
    const args = { reason: "user asked", query: "x" };
    expect(emittedArgs("Search", args, map)).toEqual(args);
  });

  it("leaves args untouched without a map or for unknown tools", () => {
    expect(emittedArgs("TodoRead", { reason: "x" }, null)).toEqual({ reason: "x" });
    const map = new Map([["Other", [[]]]]);
    expect(emittedArgs("TodoRead", { reason: "x" }, map)).toEqual({ reason: "x" });
  });

  it("stripReasonPlaceholders does not mutate its input", () => {
    const args = { reason: "x", nested: { reason: "y", keep: true } };
    stripReasonPlaceholders("T", args, new Map([["T", [[], ["nested"]]]]));
    expect(args.reason).toBe("x");
    expect(args.nested.reason).toBe("y");
  });
});

describe("executor transformRequest", () => {
  const executor = new AntigravityExecutor();

  it("merges translator-recorded paths on the same body object", () => {
    const env = openaiToAntigravityRequest(MODEL, requestWith([
      tool("TodoRead", { type: "object", properties: {} }),
      tool("Bash", { type: "object", properties: { command: { type: "string" } } }),
    ]), true);
    executor.transformRequest(MODEL, env, true, { projectId: "p" });
    const map = takeReasonPlaceholderMap(env);
    expect(map.get("TodoRead")).toEqual([[]]);
    expect(map.has("Bash")).toBe(false);
  });

  it("records the missing-parameters fallback path", () => {
    const env = { request: { contents: [{ role: "user", parts: [{ text: "hi" }] }], tools: [{ functionDeclarations: [{ name: "TodoRead", description: "x" }] }] } };
    const out = executor.transformRequest(MODEL, env, true, { projectId: "p" });
    const decl = out.request.tools[0].functionDeclarations[0];
    expect(decl.parameters.required).toEqual(["reason"]);
    expect(takeReasonPlaceholderMap(env).get("TodoRead")).toEqual([[]]);
  });
});
