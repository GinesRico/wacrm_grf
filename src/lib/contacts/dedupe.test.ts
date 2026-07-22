import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Array<{
    id: string;
    userId: string;
    accountId: string;
    phone: string;
    phoneNormalized: string | null;
    name: string | null;
    email: string | null;
    company: string | null;
    avatarUrl: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>,
}));

vi.mock("@/db/client", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => h.rows,
      }),
    }),
  },
}));

import {
  dedupeByPhone,
  findExistingContact,
  isExactMatch,
  isUniqueViolation,
  normalizeKey,
} from "./dedupe";

function contact(id: string, phone: string) {
  return {
    id,
    userId: "u1",
    accountId: "acct",
    phone,
    phoneNormalized: null,
    name: null,
    email: null,
    company: null,
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

beforeEach(() => {
  h.rows = [];
});

describe("normalizeKey", () => {
  it("strips every non-digit", () => {
    expect(normalizeKey("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizeKey("15551234567")).toBe("15551234567");
  });

  it("collapses different formats of the same number to one key", () => {
    expect(normalizeKey("+44 7911 123456")).toBe(normalizeKey("447911123456"));
  });
});

describe("isExactMatch", () => {
  it("treats different formatting of the same digits as exact", () => {
    expect(isExactMatch({ id: "1", phone: "+1 555-123-4567" }, "15551234567")).toBe(
      true,
    );
  });

  it("is false for a trunk-variant (fuzzy) match", () => {
    // last-8 match but not the same full number
    expect(isExactMatch({ id: "1", phone: "37063949836" }, "370063949836")).toBe(
      false,
    );
  });
});

describe("isUniqueViolation", () => {
  it("detects Postgres 23505", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
  });
  it("is false for other errors / non-objects", () => {
    expect(isUniqueViolation({ code: "23502" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation("boom")).toBe(false);
  });
});

describe("dedupeByPhone", () => {
  it("keeps the first occurrence and counts in-file duplicates", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "+1 555-1111", name: "A" },
      { phone: "15551111", name: "B" }, // same digits as #1
      { phone: "+1 555-2222", name: "C" },
    ]);
    expect(unique.map((r) => r.name)).toEqual(["A", "C"]);
    expect(duplicates).toBe(1);
  });

  it("drops rows with no digits", () => {
    const { unique, duplicates } = dedupeByPhone([
      { phone: "   " },
      { phone: "+1 555-3333" },
    ]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe("findExistingContact", () => {
  it("returns a trunk-variant match via phonesMatch", async () => {
    h.rows = [contact("c1", "37063949836")];
    const hit = await findExistingContact(null, "acct", "+370 063 949 836");
    expect(hit?.id).toBe("c1");
  });

  it("returns null when no candidate matches", async () => {
    h.rows = [contact("c1", "15559999999")];
    const hit = await findExistingContact(null, "acct", "+1 555-123-4567");
    expect(hit).toBeNull();
  });

  it("returns null for an empty phone without querying", async () => {
    h.rows = [contact("c1", "15551234567")];
    expect(await findExistingContact(null, "acct", "   ")).toBeNull();
  });
});
