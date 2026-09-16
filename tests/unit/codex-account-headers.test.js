import { describe, it, expect, beforeEach } from "vitest";
import { CodexExecutor } from "../../open-sse/executors/codex.js";
import codexImageProvider from "../../open-sse/handlers/imageProviders/codex.js";

// ============================================================================
// CODEX-05: Codex account headers precedence & isolation
// Precedence: workspaceId > chatgptAccountId > accountId
// Account header isolation: no header / capacity state leak across accounts / retries.
// ============================================================================

describe("CODEX-05: Codex account headers precedence & isolation", () => {
  let executor;

  beforeEach(() => {
    executor = new CodexExecutor();
  });

  describe("Executor buildHeaders precedence", () => {
    it("uses accountId when only accountId is provided", () => {
      const creds = {
        accessToken: "tok-1",
        providerSpecificData: {
          accountId: "acc-only-1",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("acc-only-1");
    });

    it("uses chatgptAccountId when only chatgptAccountId is provided", () => {
      const creds = {
        accessToken: "tok-2",
        providerSpecificData: {
          chatgptAccountId: "cgt-only-2",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("cgt-only-2");
    });

    it("uses workspaceId when only workspaceId is provided", () => {
      const creds = {
        accessToken: "tok-3",
        providerSpecificData: {
          workspaceId: "ws-only-3",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("ws-only-3");
    });

    it("prefers workspaceId over chatgptAccountId", () => {
      const creds = {
        accessToken: "tok-4",
        providerSpecificData: {
          workspaceId: "ws-winner",
          chatgptAccountId: "cgt-loser",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("ws-winner");
    });

    it("prefers workspaceId over accountId", () => {
      const creds = {
        accessToken: "tok-5",
        providerSpecificData: {
          workspaceId: "ws-winner-5",
          accountId: "acc-loser-5",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("ws-winner-5");
    });

    it("prefers chatgptAccountId over accountId", () => {
      const creds = {
        accessToken: "tok-6",
        providerSpecificData: {
          chatgptAccountId: "cgt-winner-6",
          accountId: "acc-loser-6",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("cgt-winner-6");
    });

    it("prefers workspaceId when all three workspaceId, chatgptAccountId, and accountId are present", () => {
      const creds = {
        accessToken: "tok-7",
        providerSpecificData: {
          workspaceId: "ws-top-7",
          chatgptAccountId: "cgt-mid-7",
          accountId: "acc-low-7",
        },
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBe("ws-top-7");
    });

    it("does not attach ChatGPT-Account-ID when no account identifiers are provided", () => {
      const creds = {
        accessToken: "tok-8",
        providerSpecificData: {},
      };
      const headers = executor.buildHeaders(creds);
      expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
    });
    it("does not attach ChatGPT-Account-ID when credentials object is empty", () => {
      const headers = executor.buildHeaders({});
      expect(headers["ChatGPT-Account-ID"]).toBeUndefined();
    });
  });

  describe("Executor account header isolation across consecutive calls", () => {
    it("does not leak account header or session state across different accounts", () => {
      const accountA = {
        accessToken: "tok-A",
        connectionId: "conn-A",
        providerSpecificData: { workspaceId: "ws-account-A" },
      };
      const accountB = {
        accessToken: "tok-B",
        connectionId: "conn-B",
        providerSpecificData: { chatgptAccountId: "cgt-account-B" },
      };
      const accountC = {
        accessToken: "tok-C",
        connectionId: "conn-C",
        providerSpecificData: {},
      };

      // Call 1 with Account A
      const headersA = executor.buildHeaders(accountA);
      expect(headersA["ChatGPT-Account-ID"]).toBe("ws-account-A");
      expect(headersA.session_id).toBe("conn-A");

      // Call 2 with Account B on same executor instance
      const headersB = executor.buildHeaders(accountB);
      expect(headersB["ChatGPT-Account-ID"]).toBe("cgt-account-B");
      expect(headersB.session_id).toBe("conn-B");

      // Call 3 with Account C (no account ID)
      const headersC = executor.buildHeaders(accountC);
      expect(headersC["ChatGPT-Account-ID"]).toBeUndefined();
      expect(headersC.session_id).toBe("conn-C");

      // Call 4 back to Account A
      const headersA2 = executor.buildHeaders(accountA);
      expect(headersA2["ChatGPT-Account-ID"]).toBe("ws-account-A");
    });
  });

  describe("Image Provider buildHeaders precedence", () => {
    it("follows workspaceId > chatgptAccountId > accountId precedence", () => {
      // 1. workspaceId takes highest precedence
      const headers1 = codexImageProvider.buildHeaders({
        accessToken: "tok-img-1",
        providerSpecificData: {
          workspaceId: "ws-img-1",
          chatgptAccountId: "cgt-img-1",
          accountId: "acc-img-1",
        },
      });
      expect(headers1["chatgpt-account-id"]).toBe("ws-img-1");

      // 2. chatgptAccountId takes precedence over accountId
      const headers2 = codexImageProvider.buildHeaders({
        accessToken: "tok-img-2",
        providerSpecificData: {
          chatgptAccountId: "cgt-img-2",
          accountId: "acc-img-2",
        },
      });
      expect(headers2["chatgpt-account-id"]).toBe("cgt-img-2");

      // 3. accountId is used when only accountId is present
      const headers3 = codexImageProvider.buildHeaders({
        accessToken: "tok-img-3",
        providerSpecificData: {
          accountId: "acc-img-3",
        },
      });
      expect(headers3["chatgpt-account-id"]).toBe("acc-img-3");

      // 4. empty string when none present
      const headers4 = codexImageProvider.buildHeaders({
        accessToken: "tok-img-4",
        providerSpecificData: {},
      });
      expect(headers4["chatgpt-account-id"]).toBe("");
    });
  });
});
