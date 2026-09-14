import { describe, expect, it } from "vitest";
import { cleanJSONSchemaForAntigravity } from "../../open-sse/translator/formats/gemini.js";

describe("Antigravity tool schema $ref dereference", () => {
  it("resolves root $defs refs and keeps the real parameter shape", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        target: { $ref: "#/$defs/Path" },
        mode: { type: "string", enum: ["read", "write"] },
      },
      required: ["target"],
      $defs: { Path: { type: "string", description: "Absolute file path" } },
    });

    expect(out.properties.target).toEqual({ type: "string", description: "Absolute file path" });
    expect(out.required).toEqual(["target"]);
    expect(out.$defs).toBeUndefined();
  });

  it("resolves legacy definitions refs and nested refs inside properties", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        item: { $ref: "#/definitions/Item" },
      },
      definitions: {
        Item: {
          type: "object",
          properties: { child: { $ref: "#/definitions/Child" } },
        },
        Child: { type: "string" },
      },
    });

    expect(out.properties.item.properties.child).toEqual({ type: "string" });
  });

  it("sibling keys win over the resolved target", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: {
        a: { $ref: "#/$defs/A", description: "local override" },
      },
      $defs: { A: { type: "string", description: "from defs" } },
    });

    expect(out.properties.a.type).toBe("string");
    expect(out.properties.a.description).toBe("local override");
  });

  it("survives $ref cycles without hanging", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: { a: { $ref: "#/$defs/A" } },
      $defs: { A: { type: "object", properties: { b: { $ref: "#/$defs/A" } } } },
    });
    expect(out.properties.a.type).toBe("object");
  });

  it("leaves external/unresolvable refs to the existing empty-schema placeholder path", () => {
    const out = cleanJSONSchemaForAntigravity({
      type: "object",
      properties: { a: { $ref: "https://example.com/schema.json" } },
    });
    // Unresolvable ref is stripped and the empty node gets the reason placeholder.
    expect(out.properties.a.$ref).toBeUndefined();
    expect(out.properties.a.properties.reason.type).toBe("string");
  });
});
