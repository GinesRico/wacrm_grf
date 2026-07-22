import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as { table: string; payload?: unknown; filters: [string, string, unknown][] }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
  },
}));

function tableName(table: unknown): string {
  if (!table || typeof table !== "object") return "";
  const record = table as Record<PropertyKey, unknown>;
  return String(
    record[Symbol.for("drizzle:Name")] ??
      record[Symbol.for("drizzle:BaseName")] ??
      (record._ && typeof record._ === "object"
        ? (record._ as { name?: string }).name
        : ""),
  );
}

vi.mock("@/db/client", () => {
  const { state } = h;

  return {
    db: {
      select: () => ({
        from: (table: unknown) => {
          const name = tableName(table);
          state.fromCalls.push(name);
          const query = {
            where: () => query,
            orderBy: () => query,
            limit: async () => {
              if (name === "contacts") return state.owned ? [state.owned] : [];
              if (name === "custom_fields") return state.ownedCustomField ? [state.ownedCustomField] : [];
              return [];
            },
            then: (onF: (value: unknown) => unknown, onR?: (error: unknown) => unknown) => {
              let rows: unknown[] = [];
              if (name === "automations") rows = state.automations;
              if (name === "automation_steps") rows = state.steps;
              return Promise.resolve(rows).then(onF, onR);
            },
          };
          return query;
        },
      }),
      insert: (table: unknown) => {
        const name = tableName(table);
        state.fromCalls.push(name);
        const insert = {
          values: (payload: unknown) => {
            if (name === "contact_custom_values") {
              state.upsertCalls.push({ table: name, payload });
            }
            return insert;
          },
          onConflictDoUpdate: () => Promise.resolve(),
          returning: async () => (name === "automation_logs" ? [{ id: "log1" }] : []),
        };
        return insert;
      },
      update: (table: unknown) => {
        const name = tableName(table);
        state.fromCalls.push(name);
        const update = {
          set: (payload: unknown) => {
            state.updateCalls.push({ table: name, payload, filters: [] });
            return update;
          },
          where: async () => undefined,
        };
        return update;
      },
      execute: async () => undefined,
    },
  };
});
vi.mock("./meta-send", () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: "m1" })),
}));

import { runAutomationsForTrigger, triggerMatches } from "./engine";
import type { Automation } from "@/types";

const ACCOUNT = "acct-1";

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
});

describe("runAutomationsForTrigger — tenant isolation", () => {
  it("refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)", async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "victim-contact-uuid",
      context: { message_text: "manual trigger" },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain("contacts");
    expect(h.state.fromCalls).not.toContain("automations");
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it("proceeds past the guard when the contact belongs to the account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.fromCalls).toContain("automations");
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    const contactUpdates = h.state.updateCalls.filter(
      (call) => call.table === "contacts",
    );
    expect(contactUpdates).toHaveLength(1);
    expect(contactUpdates[0].payload).toMatchObject({
      company: "pwned-by-automation",
    });
  });
});

describe("update_contact_field — custom fields", () => {
  it("upserts contact_custom_values when the field is account-owned", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "Premium")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls.filter((call) => call.table === "contacts")).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contactId: "c1",
      customFieldId: "cf1",
      value: "Premium",
    });
  });

  it("interpolates {{ vars.* }} into the custom value", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = { id: "cf1" };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:cf1", "{{ vars.source }}")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: { vars: { source: "WhatsApp Ad" } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect(
      (h.state.upsertCalls[0].payload as { value: string }).value,
    ).toBe("WhatsApp Ad");
  });

  it("refuses to write a custom field from another account", async () => {
    h.state.owned = { id: "c1" };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep("custom:foreign-cf", "x")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls.filter((call) => call.table === "contacts")).toHaveLength(0);
  });
});

describe("send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)", () => {
  it("refuses a private / link-local destination and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    h.state.owned = { id: "c1" };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep("http://169.254.169.254/latest/meta-data/")];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: "new_message_received",
      contactId: "c1",
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain("automation_steps");
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: "s1",
    automationId: "a1",
    stepType: "send_webhook",
    position: 0,
    parentStepId: null,
    stepConfig: { url, headers: { "Metadata-Flavor": "Google" }, body_template: "{}" },
    branch: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function automationWithUpdateStep() {
  return {
    id: "a1",
    accountId: ACCOUNT,
    userId: "u1",
    triggerType: "new_message_received",
    triggerConfig: {},
    isActive: true,
    executionCount: 0,
    lastExecutedAt: null,
    name: "test automation",
    description: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function updateStep() {
  return {
    id: "s1",
    automationId: "a1",
    stepType: "update_contact_field",
    position: 0,
    parentStepId: null,
    stepConfig: { field: "company", value: "pwned-by-automation" },
    branch: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function customStep(field: string, value: string) {
  return {
    id: "s1",
    automationId: "a1",
    stepType: "update_contact_field",
    position: 0,
    parentStepId: null,
    stepConfig: { field, value },
    branch: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

describe("triggerMatches — interactive_reply", () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: "a1",
      account_id: ACCOUNT,
      user_id: "u1",
      name: "menu step",
      trigger_type: "interactive_reply",
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: "",
      updated_at: "",
    };
  }

  it("matches when the tapped id is in reply_ids (exact)", () => {
    expect(
      triggerMatches(automation(["yes", "no"]), { interactive_reply_id: "yes" }),
    ).toBe(true);
  });

  it("does not match a different id", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "maybe" }),
    ).toBe(false);
  });

  it("does not match on a substring (exact only)", () => {
    expect(
      triggerMatches(automation(["yes"]), { interactive_reply_id: "yes_please" }),
    ).toBe(false);
  });

  it("does not match when no reply id is present or config is empty", () => {
    expect(triggerMatches(automation(["yes"]), {})).toBe(false);
    expect(triggerMatches(automation([]), { interactive_reply_id: "yes" })).toBe(false);
  });
});
