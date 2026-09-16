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

  it("strips all unsupported schema constraints according to Antigravity rules", () => {
    const input = {
      type: "object",
      title: "FileOperation",
      $schema: "http://json-schema.org/draft-07/schema#",
      $comment: "Internal schema",
      properties: {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          format: "uri",
          default: "untitled",
          examples: ["file.txt"],
        },
        count: {
          type: "integer",
          minimum: 0,
          exclusiveMinimum: 0,
          maximum: 100,
          exclusiveMaximum: 100,
          multipleOf: 5,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
          contains: { type: "string" },
        },
        tuple: {
          type: "array",
          prefixItems: [{ type: "string" }, { type: "number" }],
          additionalItems: false,
        },
        metadata: {
          type: "object",
          unevaluatedProperties: false,
          contentSchema: { type: "string" },
        },
      },
      required: ["name"],
    };

    const out = cleanJSONSchemaForAntigravity(input);

    // Unsupported root/property fields are stripped
    expect(out.$schema).toBeUndefined();
    expect(out.$comment).toBeUndefined();

    expect(out.properties.name.minLength).toBeUndefined();
    expect(out.properties.name.maxLength).toBeUndefined();
    expect(out.properties.name.format).toBeUndefined();
    expect(out.properties.name.default).toBeUndefined();
    expect(out.properties.name.examples).toBeUndefined();

    expect(out.properties.count.exclusiveMinimum).toBeUndefined();
    expect(out.properties.count.exclusiveMaximum).toBeUndefined();
    expect(out.properties.count.multipleOf).toBeUndefined();

    expect(out.properties.tags.minItems).toBeUndefined();
    expect(out.properties.tags.maxItems).toBeUndefined();
    expect(out.properties.tags.uniqueItems).toBeUndefined();
    expect(out.properties.tags.contains).toBeUndefined();

    expect(out.properties.tuple.prefixItems).toBeUndefined();
    expect(out.properties.tuple.additionalItems).toBeUndefined();
    expect(out.properties.tuple.items).toEqual({ type: "string" });

    expect(out.properties.metadata.unevaluatedProperties).toBeUndefined();
    expect(out.properties.metadata.contentSchema).toBeUndefined();

    // Core type and properties remain valid
    expect(out.properties.name.type).toBe("string");
    expect(out.properties.count.type).toBe("integer");
    expect(out.properties.tags.type).toBe("array");
    expect(out.required).toEqual(["name"]);
  });

  it("merges allOf into a unified properties object", () => {
    const input = {
      type: "object",
      allOf: [
        {
          properties: {
            id: { type: "string" },
            created: { type: "integer" },
          },
          required: ["id"],
        },
        {
          properties: {
            name: { type: "string" },
          },
          required: ["name"],
        },
      ],
    };

    const out = cleanJSONSchemaForAntigravity(input);

    expect(out.allOf).toBeUndefined();
    expect(out.properties.id).toEqual({ type: "string" });
    expect(out.properties.created).toEqual({ type: "integer" });
    expect(out.properties.name).toEqual({ type: "string" });
    expect(out.required).toEqual(["id", "name"]);
  });

  it("flattens anyOf and oneOf by selecting the best non-null concrete schema", () => {
    // anyOf with object schema and null
    const inputAnyOf = {
      type: "object",
      properties: {
        config: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              properties: { timeout: { type: "number" } },
              required: ["timeout"],
            },
          ],
        },
      },
    };

    const outAnyOf = cleanJSONSchemaForAntigravity(inputAnyOf);
    expect(outAnyOf.properties.config.anyOf).toBeUndefined();
    expect(outAnyOf.properties.config.type).toBe("object");
    expect(outAnyOf.properties.config.properties.timeout).toEqual({ type: "number" });

    // oneOf with primitive vs array
    const inputOneOf = {
      type: "object",
      properties: {
        values: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    };

    const outOneOf = cleanJSONSchemaForAntigravity(inputOneOf);
    expect(outOneOf.properties.values.oneOf).toBeUndefined();
    expect(outOneOf.properties.values.type).toBe("array");
    expect(outOneOf.properties.values.items).toEqual({ type: "string" });
  });

  it("cleans up invalid or empty required fields", () => {
    const input = {
      type: "object",
      properties: {
        realProp: { type: "string" },
      },
      required: ["realProp", "ghostProp"],
    };

    const out = cleanJSONSchemaForAntigravity(input);
    expect(out.required).toEqual(["realProp"]);

    const inputAllGhost = {
      type: "object",
      properties: {
        realProp: { type: "string" },
      },
      required: ["ghostProp"],
    };

    const outAllGhost = cleanJSONSchemaForAntigravity(inputAllGhost);
    expect(outAllGhost.required).toBeUndefined();
  });

  it("injects placeholder for empty object schemas as required by Antigravity", () => {
    const input = {
      type: "object",
      properties: {},
    };

    const out = cleanJSONSchemaForAntigravity(input);
    expect(out.properties.reason).toEqual({
      type: "string",
      description: "Brief explanation of why you are calling this tool",
    });
    expect(out.required).toEqual(["reason"]);
  });
});

describe("normalizeGeminiContents (Antigravity message normalization)", () => {
  it("merges adjacent same-role messages and strips empty parts", async () => {
    const { normalizeGeminiContents } = await import("../../open-sse/translator/formats/gemini.js");

    const input = [
      { role: "user", parts: [{ text: "part 1" }] },
      { role: "user", parts: [{ text: "part 2" }, {}] },
      { role: "model", parts: [{ text: "response 1" }] },
      { role: "model", parts: [{ text: "response 2" }] },
    ];

    const out = normalizeGeminiContents(input);

    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[0].parts).toEqual([{ text: "part 1" }, { text: "part 2" }]);
    expect(out[1].role).toBe("model");
    expect(out[1].parts).toEqual([{ text: "response 1" }, { text: "response 2" }]);
  });

  it("ensures initial turn is user turn if model starts first", async () => {
    const { normalizeGeminiContents } = await import("../../open-sse/translator/formats/gemini.js");

    const input = [
      { role: "model", parts: [{ text: "Hello! How can I help?" }] },
      { role: "user", parts: [{ text: "Need help with code" }] },
    ];

    const out = normalizeGeminiContents(input);

    expect(out[0].role).toBe("user");
    expect(out[0].parts).toEqual([{ text: "..." }]);
    expect(out[1].role).toBe("model");
    expect(out[2].role).toBe("user");
  });
});

describe("antigravityToOpenAIRequest tool/schema translation", () => {
  it("translates Antigravity request with uppercase types and tool declarations to OpenAI format", async () => {
    const { antigravityToOpenAIRequest } = await import(
      "../../open-sse/translator/request/antigravity-to-openai.js"
    );

    const antigravityBody = {
      project: "proj-123",
      model: "gemini-3.5-flash-low",
      request: {
        systemInstruction: { parts: [{ text: "You are a helpful assistant" }] },
        contents: [
          { role: "user", parts: [{ text: "Search for files" }] },
        ],
        tools: [
          {
            functionDeclarations: [
              {
                name: "search_files",
                description: "Search workspace for files",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    query: { type: "STRING", description: "Search query" },
                    limit: { type: "INTEGER", description: "Max results" },
                  },
                  required: ["query"],
                },
              },
            ],
          },
        ],
      },
    };

    const openAIReq = antigravityToOpenAIRequest("gpt-4o", antigravityBody, false);

    expect(openAIReq.model).toBe("gpt-4o");
    expect(openAIReq.stream).toBe(false);
    expect(openAIReq.messages[0]).toEqual({
      role: "system",
      content: "You are a helpful assistant",
    });
    expect(openAIReq.messages[1]).toEqual({
      role: "user",
      content: "Search for files",
    });

    expect(openAIReq.tools).toHaveLength(1);
    expect(openAIReq.tools[0].type).toBe("function");
    expect(openAIReq.tools[0].function.name).toBe("search_files");
    expect(openAIReq.tools[0].function.description).toBe("Search workspace for files");
    expect(openAIReq.tools[0].function.parameters.type).toBe("object");
    expect(openAIReq.tools[0].function.parameters.properties.query.type).toBe("string");
    expect(openAIReq.tools[0].function.parameters.properties.limit.type).toBe("integer");
  });
});
