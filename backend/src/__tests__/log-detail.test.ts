import { describe, expect, it } from "vitest";
import { compactLogDetail } from "../jobs/logDetail";

function image(size: number, fill = "A"): string {
  const chars = Math.ceil(size * 4 / 3);
  return `data:image/jpeg;base64,${fill.repeat(chars).slice(0, chars)}`;
}

describe("compactLogDetail", () => {
  it("keeps failure screenshots ahead of earlier successful screenshots", () => {
    const input = [
      { label: "first", screenshot: image(8, "A") },
      { label: "failed", error: "timeout", screenshot: image(8, "B") },
      { label: "last", screenshot: image(8, "C") },
    ];
    const output = compactLogDetail(input, { maxBytes: 16, maxCount: 2 });
    expect(output[0].screenshot).toBeUndefined();
    expect(output[1].screenshot).toBe(input[1].screenshot);
    expect(output[2].screenshot).toBe(input[2].screenshot);
    expect(input[0].screenshot).toBeTruthy();
  });

  it("removes repeated image data and keeps non-image fields untouched", () => {
    const repeated = image(6);
    const input = {
      steps: [
        { label: "a", screenshot: repeated, outcome: "ok" },
        { label: "b", screenshot: repeated, outcome: "ok" },
      ],
      note: "keep me",
    };
    const output = compactLogDetail(input, { maxBytes: 100 });
    // Keep the last occurrence so the detail points at the final page state.
    expect(output.steps[0].screenshot).toBeUndefined();
    expect(output.steps[1].screenshot).toBe(repeated);
    expect(output.steps.map((step) => step.outcome)).toEqual(["ok", "ok"]);
    expect(output.note).toBe("keep me");
  });

  it("handles nested web-step arrays and an explicit zero budget", () => {
    const input = {
      steps: [{
        webSteps: [{ screenshot: image(10) }, { screenshot: image(10, "B") }],
      }],
    };
    const output = compactLogDetail(input, { maxBytes: 0 });
    expect(output.steps[0].webSteps[0].screenshot).toBeUndefined();
    expect(output.steps[0].webSteps[1].screenshot).toBeUndefined();
  });

  it("does not mutate the live detail object", () => {
    const input = { screenshot: image(4), nested: { screenshot: image(4, "B") } };
    const output = compactLogDetail(input, { maxCount: 1, maxBytes: 100 });
    expect(output).not.toBe(input);
    expect(input.screenshot).toBeTruthy();
    expect(input.nested.screenshot).toBeTruthy();
  });
});

