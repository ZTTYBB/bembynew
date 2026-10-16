/**
 * CloakBrowser is ESM-only while this backend is compiled as CommonJS.
 * Keep the dynamic-import bridge isolated so callers can mock the SDK at the
 * module boundary without touching browser lifecycle code.
 */
type CloakModule = typeof import("cloakbrowser");

const importEsm = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<unknown>;

let modulePromise: Promise<CloakModule> | undefined;

export function loadCloakBrowser(): Promise<CloakModule> {
  modulePromise ??= importEsm("cloakbrowser") as Promise<CloakModule>;
  return modulePromise;
}
