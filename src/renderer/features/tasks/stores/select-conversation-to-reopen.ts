export interface ReopenableConversation {
  id: string;
  lastInteractedAt: string | null;
}

/**
 * Decides which conversation a task should reopen when it is re-selected.
 *
 * Closing a conversation tab never deletes the conversation — it only removes
 * the tab and dehydrates the session. When the user closes the last tab and
 * then re-selects the task from the sidebar, we want to land them back on a
 * conversation instead of the empty state (the conversations sidebar that would
 * otherwise let them reopen it is collapsed by default).
 *
 * Returns the id of the most-recently-interacted conversation when no tab is
 * open in any pane and the task has at least one conversation; otherwise
 * undefined — meaning nothing should be reopened, either because a tab is
 * already open or because the task genuinely has no conversations.
 */
export function selectConversationToReopen(
  anyTabOpen: boolean,
  conversations: readonly ReopenableConversation[]
): string | undefined {
  if (anyTabOpen) return undefined;

  let selectedId: string | undefined;
  let selectedTime = -Infinity;
  for (const conversation of conversations) {
    const parsed = conversation.lastInteractedAt
      ? new Date(conversation.lastInteractedAt).getTime()
      : 0;
    const time = Number.isNaN(parsed) ? 0 : parsed;
    // `>=` so that, on ties (e.g. all timestamps null), the last conversation in
    // iteration order wins — conversation maps iterate in insertion order, so
    // this picks the most-recently-added conversation as the tiebreak.
    if (time >= selectedTime) {
      selectedTime = time;
      selectedId = conversation.id;
    }
  }
  return selectedId;
}
