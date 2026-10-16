import type { CustomAction } from "../types";
import { assertSafeRegexSource } from "../util/regexSafety";

type SaveTagAction = Extract<CustomAction, { type: "save_tag" }>;

/** Read the first capture group (or the full match) from the latest reply batch. */
export function extractTagValue(
  action: Pick<SaveTagAction, "value" | "regex">,
  replyTexts: string[],
): string {
  const pattern = action.regex?.trim();
  let value = action.value ?? "";
  if (pattern) {
    if (pattern.length > 500) throw new Error("Tag regex is too long");
    const delimited = pattern.match(/^\/(.+)\/([gimsuy]*)$/);
    let regex: RegExp;
    try {
      assertSafeRegexSource(
        delimited ? delimited[1] : pattern,
        "Tag regular expression",
      );
      regex = new RegExp(
        delimited ? delimited[1] : pattern,
        delimited ? delimited[2] : "i",
      );
    } catch (err: any) {
      throw new Error(`Invalid tag regex: ${err?.message ?? "invalid pattern"}`);
    }
    const match = regex.exec(replyTexts.filter(Boolean).join("\n"));
    if (!match) {
      throw new Error(`Tag regex "${pattern}" did not match the latest reply`);
    }
    value = match[1] ?? match[0];
  }
  value = value.trim();
  if (!value) throw new Error("Tag value or regex is required");
  if (value.length > 512) throw new Error("Tag value is too long");
  return value;
}
