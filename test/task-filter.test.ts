import { it, expect } from 'vitest';
import { matchesTask } from '../src/api/task-filter.js';
it('combines text and status without conflating uncertain and confirmed tasks', () => {
 expect(matchesTask('Email to Alice: Proposal', 'awaiting_decision', ' ALICE ', 'awaiting_decision')).toBe(true);
 expect(matchesTask('Email to Alice', 'unknown', 'Alice', 'confirmed')).toBe(false);
 expect(matchesTask('Email to Alice', 'unknown', '', 'unknown')).toBe(true);
 expect(matchesTask('Task for Claude', 'failed', 'invoice', '')).toBe(false);
 expect(matchesTask('', 'ready', ' ', '')).toBe(true);
});
