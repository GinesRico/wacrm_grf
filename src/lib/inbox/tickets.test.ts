import { describe, expect, it } from "vitest";

import {
  InboxWorkflowError,
  getConversationMutationPatch,
} from "./tickets";

describe("getConversationMutationPatch", () => {
  it("accepts a pending unassigned conversation for the current agent", () => {
    expect(
      getConversationMutationPatch(
        "accept",
        { status: "pending", assigned_agent_id: null },
        "u1",
      ),
    ).toEqual({ status: "open", assigned_agent_id: "u1" });
  });

  it("rejects accepting a conversation already assigned to another agent", () => {
    expect(() =>
      getConversationMutationPatch(
        "accept",
        { status: "pending", assigned_agent_id: "u2" },
        "u1",
      ),
    ).toThrow(InboxWorkflowError);
  });

  it("returns open conversations to pending and clears assignment", () => {
    expect(
      getConversationMutationPatch(
        "return_to_pending",
        { status: "open", assigned_agent_id: "u1" },
        "u1",
      ),
    ).toEqual({ status: "pending", assigned_agent_id: null });
  });

  it("resolves pending conversations for the current agent", () => {
    expect(
      getConversationMutationPatch(
        "resolve",
        { status: "pending", assigned_agent_id: null },
        "u1",
      ),
    ).toEqual({ status: "closed", assigned_agent_id: "u1" });
  });

  it("reopens closed conversations for the current agent", () => {
    expect(
      getConversationMutationPatch(
        "reopen",
        { status: "closed", assigned_agent_id: null },
        "u1",
      ),
    ).toEqual({ status: "open", assigned_agent_id: "u1" });
  });

  it("can transfer assignment and line together", () => {
    expect(
      getConversationMutationPatch(
        "assign",
        { status: "open", assigned_agent_id: "u1" },
        "u1",
        "u2",
        "line-2",
      ),
    ).toEqual({ assigned_agent_id: "u2", whatsapp_config_id: "line-2" });
  });

  it("can clear assignment without changing line", () => {
    expect(
      getConversationMutationPatch(
        "assign",
        { status: "open", assigned_agent_id: "u1" },
        "u1",
        null,
      ),
    ).toEqual({ assigned_agent_id: null });
  });

  it("returns to pending when transferring to a department queue without an agent", () => {
    expect(
      getConversationMutationPatch(
        "assign",
        { status: "open", assigned_agent_id: "u1" },
        "u1",
        null,
        "line-1",
        "department-1",
      ),
    ).toEqual({
      status: "pending",
      assigned_agent_id: null,
      whatsapp_config_id: "line-1",
      department_id: "department-1",
    });
  });
});
