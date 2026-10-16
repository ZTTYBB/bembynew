/**
 * JavaScript regular expressions run on the event loop and have no built-in
 * timeout. This is a deliberately conservative guard for operator-supplied
 * patterns: a quantified group containing another quantifier is the common
 * catastrophic-backtracking shape (`(a+)+`, `(?:.*)+`, ...).
 *
 * It is not a proof that an arbitrary regexp is linear. Callers still bound
 * pattern and input sizes, and should use this check before compiling a
 * persisted/user-supplied expression.
 */
export function assertSafeRegexSource(
  source: string,
  label = "Regular expression",
  maxLength = 500,
): void {
  if (source.length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters`);
  }

  type Group = { hasQuantifier: boolean };
  const groups: Group[] = [];
  let inClass = false;
  let escaped = false;
  let lastWasAtom = false;
  let closedGroup: Group | undefined;

  const quantifier = (index: number): boolean => {
    const char = source[index];
    if (char === "*" || char === "+" || char === "?") return true;
    if (char !== "{") return false;
    const end = source.indexOf("}", index + 1);
    return end >= 0 && /^\{\d+(?:,\d*)?\}$/.test(source.slice(index, end + 1));
  };

  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (escaped) {
      escaped = false;
      lastWasAtom = true;
      closedGroup = undefined;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      lastWasAtom = true;
      closedGroup = undefined;
      continue;
    }
    if (char === "[") {
      inClass = true;
      lastWasAtom = true;
      closedGroup = undefined;
      continue;
    }
    if (char === "(") {
      groups.push({ hasQuantifier: false });
      lastWasAtom = false;
      closedGroup = undefined;
      continue;
    }
    if (char === ")") {
      const group = groups.pop();
      if (!group) throw new Error(`${label} has an unmatched closing parenthesis`);
      if (group.hasQuantifier && groups.length) groups[groups.length - 1].hasQuantifier = true;
      closedGroup = group;
      lastWasAtom = true;
      continue;
    }
    if (quantifier(i) && (lastWasAtom || closedGroup !== undefined)) {
      if (closedGroup?.hasQuantifier) {
        throw new Error(`${label} contains nested quantifiers that may block the server`);
      }
      if (groups.length) groups[groups.length - 1].hasQuantifier = true;
      if (char === "{") {
        const end = source.indexOf("}", i + 1);
        i = end;
      }
      lastWasAtom = false;
      closedGroup = undefined;
      continue;
    }
    if (char === "|" || char === "^" || char === "$") {
      lastWasAtom = false;
      closedGroup = undefined;
      continue;
    }
    // Regex group modifiers (`?:`, `?=`, `?!`, `?<name>`) are syntax, not
    // standalone quantifiers. Everything else is an atom.
    lastWasAtom = true;
    closedGroup = undefined;
  }
  if (escaped || inClass || groups.length) {
    throw new Error(`${label} has an incomplete character class or group`);
  }
}
