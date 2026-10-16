import { test } from "node:test";
import assert from "node:assert/strict";
import { canCreateTemplateJob, defaultCandidateFilters, isRestrictedAccount, matchesCandidateFilters, templateCategory, templateCreationAccountIds } from "../src/utils/templateWorkflow.ts";

const candidate = (extra = {}) => ({
  id: 1, name: "Main Account", phoneNumber: "+86138", authStatus: "authenticated",
  tgDisplayName: "Alice Example", linked: false, restriction: null, successfulTemplateIds: [], ...extra,
});

test("default filters exclude linked accounts but retain restricted accounts", () => {
  const filters = defaultCandidateFilters();
  assert.equal(matchesCandidateFilters(candidate({ linked: true }), filters), false);
  assert.equal(matchesCandidateFilters(candidate({ restriction: "limited" }), filters), true);
});
test("restricted filtering does not treat mild restriction or unknown status as a ban", () => {
  const filters = { ...defaultCandidateFilters(), excludeRestricted: true };
  for (const restriction of ["limited", "blocked", "frozen"]) {
    assert.equal(isRestrictedAccount(candidate({ restriction })), true);
    assert.equal(matchesCandidateFilters(candidate({ restriction }), filters), false);
  }
  for (const restriction of ["mild", "free", "unknown", null]) {
    assert.equal(matchesCandidateFilters(candidate({ restriction }), filters), true);
  }
});
test("include keywords are comma-separated alternatives matched against either name", () => {
  const filters = { ...defaultCandidateFilters(), includeKeywords: "missing, ALICE" };
  assert.equal(matchesCandidateFilters(candidate(), filters), true);
  assert.equal(matchesCandidateFilters(candidate({ tgDisplayName: null }), filters), false);
  assert.equal(matchesCandidateFilters(candidate({ name: "missing" }), filters), true);
});
test("exclude keywords take precedence and do not match phone numbers", () => {
  const filters = { ...defaultCandidateFilters(), includeKeywords: "main", excludeKeywords: "none，Example" };
  assert.equal(matchesCandidateFilters(candidate(), filters), false);
  assert.equal(matchesCandidateFilters(candidate(), { ...filters, excludeKeywords: "+86138" }), true);
});
test("successful-template filtering composes with other filters", () => {
  const filters = { ...defaultCandidateFilters(), succeededTemplateId: 88 };
  assert.equal(matchesCandidateFilters(candidate({ successfulTemplateIds: [88] }), filters), true);
  assert.equal(matchesCandidateFilters(candidate({ successfulTemplateIds: [89] }), filters), false);
  assert.equal(matchesCandidateFilters(candidate({ successfulTemplateIds: [88], linked: true }), filters), false);
  assert.equal(matchesCandidateFilters(candidate({ successfulTemplateIds: [88], linked: true }), { ...filters, excludeLinked: false }), true);
});
test("manual category wins, inferred category is the fallback, and old API rows still render", () => {
  assert.equal(templateCategory({ jobType: "custom", category: "draw", inferredCategory: "join" }), "draw");
  assert.equal(templateCategory({ jobType: "custom", category: "", inferredCategory: "miniapp" }), "miniapp");
  assert.equal(templateCategory({ jobType: "embywatch" }), "watch");
  assert.equal(templateCategory({ jobType: "custom" }), "other");
});
test("creation preview lists only eligible unlinked selected accounts, with Emby independent of TG login", () => {
  const eligibility = {
    accountCount: 5, accountIds: [1, 2, 3, 4], telegramAccountIds: [1, 2],
    templates: [
      { templateId: 10, candidateCount: 2, eligibleCount: 1, linkedAccountIds: [1, 3] },
      { templateId: 20, candidateCount: 4, eligibleCount: 3, linkedAccountIds: [2] },
      { templateId: 30, candidateCount: 2, eligibleCount: 0, linkedAccountIds: [1, 2] },
    ],
  };
  assert.deepEqual(templateCreationAccountIds({ id: 10, jobType: "custom" }, eligibility), [2]);
  assert.deepEqual(templateCreationAccountIds({ id: 20, jobType: "embywatch" }, eligibility), [1, 3, 4]);
  assert.deepEqual(templateCreationAccountIds({ id: 30, jobType: "checkin" }, eligibility), []);
  assert.deepEqual(templateCreationAccountIds({ id: 999, jobType: "custom" }, eligibility), []);
});
test("backend canCreate takes precedence while older candidate responses remain compatible", () => {
  assert.equal(canCreateTemplateJob(candidate({ canCreate: false }), "custom"), false);
  assert.equal(canCreateTemplateJob(candidate({ canCreate: false }), "embywatch"), false);
  assert.equal(canCreateTemplateJob(candidate({ linked: true, canCreate: true }), "embywatch"), false);
  assert.equal(canCreateTemplateJob(candidate({ authStatus: "unauthenticated", canCreate: true }), "embywatch"), true);
  assert.equal(canCreateTemplateJob(candidate({ authStatus: "unauthenticated" }), "custom"), false);
  assert.equal(canCreateTemplateJob(candidate(), "custom"), true);
});
