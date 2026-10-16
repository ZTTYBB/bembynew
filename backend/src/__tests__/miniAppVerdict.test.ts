import { describe, it, expect } from "vitest";
import { miniAppVerdict } from "../jobs/cloudflare";

const CLEAN = { challenged: false, solved: true, text: "每日签到\n签到成功！获得 5 猪币" };

describe("miniAppVerdict", () => {
  it("passes a page that rendered and had its control pressed", () => {
    expect(miniAppVerdict({ ...CLEAN, inAppAction: "签到" })).toEqual({ ok: true });
  });

  it("fails a blank page rather than calling it challenge-free", () => {
    const v = miniAppVerdict({ challenged: false, solved: true, text: "" });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/blank/);
  });

  it("names the load trouble when the page never rendered", () => {
    const v = miniAppVerdict({
      challenged: false,
      solved: true,
      text: "  ",
      navError: "page crashed: Page crashed!",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("Page crashed!");
  });

  it("fails when the control the caller asked for was never pressed", () => {
    const v = miniAppVerdict({ ...CLEAN, inAppFailure: '"立即签到" is not on the app page' });
    expect(v).toEqual({ ok: false, reason: '"立即签到" is not on the app page' });
  });

  it("reports a refused challenge as such, not as a blank page", () => {
    const v = miniAppVerdict({ challenged: true, solved: false, text: "人机验证失败" });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/I am not a bot/);
  });

  it("keeps the challenge verdict when a refused page rendered nothing", () => {
    const v = miniAppVerdict({ challenged: true, solved: false, text: "" });
    expect(v.reason).toMatch(/I am not a bot/);
  });

  it("passes a page whose control was already used today", () => {
    expect(miniAppVerdict({ ...CLEAN, inAppAction: "already done: 已签到" })).toEqual({ ok: true });
  });

  it("still fails a blank page when the steps only waited and scrolled", () => {
    const v = miniAppVerdict({
      challenged: false,
      solved: true,
      text: "",
      inAppAction: "waited 3000ms → scrolled the page to 0,1071",
      inAppActed: false,
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/blank/);
  });

  it("passes a blank-looking page once a step actually pressed something", () => {
    expect(
      miniAppVerdict({
        challenged: false,
        solved: true,
        text: "",
        inAppAction: "scrolled the page to 0,1071 → pressed 签到",
        inAppActed: true,
      }),
    ).toEqual({ ok: true });
  });
});

describe("miniAppVerdict — an app asking to be verified", () => {
  it("fails when the app still asks for a human check after the press", () => {
    const v = miniAppVerdict({
      challenged: false,
      solved: true,
      text: "每日签到\n请完成人机验证以进行签到\n取消",
      inAppAction: "签到",
    });
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/human verification/);
  });

  it("passes once that wording is gone", () => {
    expect(
      miniAppVerdict({
        challenged: true,
        solved: true,
        text: "签到成功！获得 5 猪币",
        inAppAction: "签到",
      }),
    ).toEqual({ ok: true });
  });
});
