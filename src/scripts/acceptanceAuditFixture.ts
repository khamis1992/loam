import type { ChatOptions } from '../ollama.js';
import { ACCEPTANCE_AUDIT_SYSTEM } from '../agent/acceptanceAudit.js';

/** Test-only canned reviewer for runtime tests with known fixture contracts.
 * Not semantic evidence: real review correctness is evaluated separately. */
export function acceptanceAuditFixture(options: ChatOptions): string | undefined {
  if (options.messages[0]?.content !== ACCEPTANCE_AUDIT_SYSTEM) return undefined;
  const input = JSON.parse(options.messages[1]!.content);
  return JSON.stringify({ verdict: 'pass', reason: 'Known runtime-test fixture contract', scenarios: input.proposedContract.scenarios.map((_scenario: unknown, index: number) => ({
    index, verdict: 'pass', requestQuote: input.originalRequest.slice(0, 500), reason: 'Canned audit for this test fixture; runtime assertions remain mandatory.',
  })) });
}
