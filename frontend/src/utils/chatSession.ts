export type ChatSession = {
  accountId: number | null;
  chatId: string | null;
  generation: number;
};

/**
 * Async messenger work may finish after the user navigates elsewhere. Keep
 * state writes scoped to the account/chat generation that started the work.
 */
export function isChatSessionCurrent(
  current: ChatSession,
  expected: ChatSession,
): boolean {
  return (
    current.accountId === expected.accountId &&
    current.chatId === expected.chatId &&
    current.generation === expected.generation
  );
}
