import { describe, expect, it } from 'vitest';
import { selectConversationToReopen } from './select-conversation-to-reopen';

describe('selectConversationToReopen', () => {
  it('returns undefined when a tab is already open', () => {
    expect(
      selectConversationToReopen(true, [{ id: 'a', lastInteractedAt: '2026-01-01T00:00:00.000Z' }])
    ).toBeUndefined();
  });

  it('returns undefined when there are no conversations to reopen', () => {
    expect(selectConversationToReopen(false, [])).toBeUndefined();
  });

  it('reopens the only conversation when no tab is open', () => {
    expect(selectConversationToReopen(false, [{ id: 'only', lastInteractedAt: null }])).toBe(
      'only'
    );
  });

  it('reopens the most-recently-interacted conversation', () => {
    const id = selectConversationToReopen(false, [
      { id: 'old', lastInteractedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'newest', lastInteractedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'middle', lastInteractedAt: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(id).toBe('newest');
  });

  it('prefers a conversation with a timestamp over ones that were never interacted with', () => {
    const id = selectConversationToReopen(false, [
      { id: 'never-a', lastInteractedAt: null },
      { id: 'interacted', lastInteractedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'never-b', lastInteractedAt: null },
    ]);
    expect(id).toBe('interacted');
  });

  it('falls back to the last-added conversation when none have timestamps', () => {
    const id = selectConversationToReopen(false, [
      { id: 'first', lastInteractedAt: null },
      { id: 'last', lastInteractedAt: null },
    ]);
    expect(id).toBe('last');
  });

  it('ignores unparseable timestamps instead of dropping the conversation', () => {
    const id = selectConversationToReopen(false, [
      { id: 'broken', lastInteractedAt: 'not-a-date' },
    ]);
    expect(id).toBe('broken');
  });
});
