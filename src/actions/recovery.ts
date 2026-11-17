import type { ActionIntent } from './model.js';

/** Read-only guidance: never authorizes execution or assumes uncertain delivery failed. */
export function actionRecovery(a: Pick<ActionIntent, 'state' | 'attempts' | 'nextAttemptAt'>) {
  const base = { attempts: a.attempts, nextAttemptAt: a.state === 'ready' ? a.nextAttemptAt ?? null : null };
  switch (a.state) {
    case 'unknown': return { ...base, title: 'Delivery is uncertain', nextStep: 'Wait for provider reconciliation. Do not send a duplicate while Jennifer checks whether the original went through.' };
    case 'failed': return { ...base, title: 'Action needs attention', nextStep: 'Review the failure reason and connection status before proposing a replacement. Check provider history if delivery is unclear.' };
    case 'ready': return { ...base, title: a.nextAttemptAt ? 'Retry scheduled' : 'Ready to run', nextStep: a.nextAttemptAt ? 'Jennifer will retry after the scheduled time, subject to the existing approval and safety checks.' : 'Waiting for execution under the existing approval and safety checks.' };
    case 'executing': return { ...base, title: 'Execution in progress', nextStep: 'Wait for the provider result before taking another action.' };
    case 'provider_accepted': return { ...base, title: 'Accepted by provider', nextStep: 'The provider accepted the action. This does not prove the recipient read it or that delivery is confirmed.' };
    case 'awaiting_decision': return { ...base, title: 'Your decision is required', nextStep: 'Review the recipient and content, then approve, edit, or decline this exact version.' };
    default: return null;
  }
}
