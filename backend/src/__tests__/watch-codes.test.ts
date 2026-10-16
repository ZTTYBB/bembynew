import { describe, expect, it } from "vitest";
import {
  compileWatchCodeRegex,
  extractWatchCode,
  normaliseWatchCode,
  renderWatchCodeCommand,
} from "../jobs/watchCodes";
import { claimWatchCode, watchCodeKey } from "../db/watchCodeClaims";

describe("watch_codes parsing", () => {
  it("takes the first capture group and supports /pattern/i syntax", () => {
    expect(extractWatchCode("/code[:=]\\s*([A-Z0-9-]+)/i", "code: AbC-77")).toBe("AbC-77");
    expect(extractWatchCode("WIN-[A-Z0-9]+", "you WIN-ABC9 now")).toBe("WIN-ABC9");
  });

  it("does not leak a global regexp lastIndex between messages", () => {
    const pattern = compileWatchCodeRegex("/([A-Z]{3}-\\d+)/g");
    expect(extractWatchCode(pattern, "ABC-1")).toBe("ABC-1");
    expect(extractWatchCode(pattern, "XYZ-2")).toBe("XYZ-2");
  });

  it("renders the code into the command and normalises duplicate spelling", () => {
    expect(renderWatchCodeCommand("/start {code}", "AB 12")).toBe("/start AB 12");
    expect(normaliseWatchCode("  AB   12 ")).toBe("ab 12");
    expect(watchCodeKey("AB 12")).toBe(watchCodeKey(" ab   12 "));
  });

});

describe("watch_codes cross-account claims", () => {
  it("claims each normalised code only once", () => {
    const keys = new Set<string>();
    const fakeDb = {
      inTransaction: false,
      exec: () => {},
      transaction: (fn: () => boolean) => () => fn(),
      prepare: (sql: string) => ({
        run: (...args: unknown[]) => {
          if (sql.trimStart().startsWith("INSERT OR IGNORE")) {
            const key = String(args[0]);
            if (keys.has(key)) return { changes: 0 };
            keys.add(key);
            return { changes: 1 };
          }
          return { changes: 0 };
        },
      }),
    } as any;
    expect(claimWatchCode(fakeDb, { code: "AB 12", sourcePeerId: "1", sourceMessageId: 2 })).toBe(true);
    expect(claimWatchCode(fakeDb, { code: " ab   12 ", sourcePeerId: "1", sourceMessageId: 3 })).toBe(false);
  });
});
