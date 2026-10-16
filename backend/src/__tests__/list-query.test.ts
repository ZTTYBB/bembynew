import { describe, expect, it } from "vitest";
import { parsePaging } from "../routes/list-query";

describe("list paging limits", () => {
  it.each([200, 500, 1000, 2000])("accepts %i rows without silently clamping", (size) => {
    expect(parsePaging({ page: "2", pageSize: String(size) })).toEqual({
      page: 2,
      pageSize: size,
      limit: size,
      offset: size,
    });
  });

  it("caps numbered pages at 2000", () => {
    expect(parsePaging({ page: "1", pageSize: "1000000" })?.limit).toBe(2000);
  });

  it("keeps All explicit and retains legacy list requests", () => {
    expect(parsePaging({ page: "9", pageSize: "0" })).toEqual({
      page: 1,
      pageSize: 0,
      limit: -1,
      offset: 0,
    });
    expect(parsePaging({})).toBeNull();
  });
});
