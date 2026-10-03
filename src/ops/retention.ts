import type { Clock } from '../core/util.js';
import type { Config } from '../core/config.js';
import type { Db } from '../db/db.js';
import type { ConversationStore } from '../events/conversations.js';
import type { ActionService } from '../actions/service.js';
import type { FeedbackStore } from '../learning/feedback.js';
import type { PhoneService } from '../voice/phone.js';
import type { AuditLog } from '../audit/audit.js';

const DAY = 24 * 3600_000;

/**
 * Daily retention job (spec §17): raw messages, call records/transcripts,
 * audit log and learning examples each have their own period. Memory and
 * imported AI history are Bruno's to delete explicitly, so they are not
 * purged on a timer. Conversations with pending work keep their messages.
 */
export class RetentionService {
  constructor(
    private d: {
      clock: Clock;
      retention: Config['retention'];
      conversations: ConversationStore;
      actions: ActionService;
      feedback: FeedbackStore;
      phone: PhoneService;
      audit: AuditLog;
      ownerId: string;
      db?: Db;
    },
  ) {}

  /** Durable mode: also purge the audit table. */
  useDb(db: Db): void {
    this.d.db = db;
  }

  async purge(): Promise<{ messages: number; calls: number; feedback: number; audit: number }> {
    const now = this.d.clock.now().getTime();
    const r = this.d.retention;
    const out = { messages: 0, calls: 0, feedback: 0, audit: 0 };
    if (r.messagesDays > 0) {
      const busy = new Set(
        this.d.actions
          .list({ ownerId: this.d.ownerId })
          .filter((a) => a.conversationId && ['proposed', 'validated', 'awaiting_decision', 'ready', 'executing', 'unknown'].includes(a.state))
          .map((a) => a.conversationId!),
      );
      out.messages = this.d.conversations.purgeMessagesBefore(new Date(now - r.messagesDays * DAY), busy).length;
    }
    if (r.callsDays > 0) out.calls = await this.d.phone.purgeBefore(new Date(now - r.callsDays * DAY));
    if (r.feedbackDays > 0) out.feedback = this.d.feedback.purgeBefore(new Date(now - r.feedbackDays * DAY));
    if (r.auditDays > 0 && this.d.db) {
      const res = await this.d.db.query('DELETE FROM audit_event WHERE at < $1', [new Date(now - r.auditDays * DAY)]);
      out.audit = (res as { rowCount?: number; affectedRows?: number }).rowCount ?? (res as { affectedRows?: number }).affectedRows ?? 0;
    }
    if (out.messages + out.calls + out.feedback + out.audit > 0) this.d.audit.record('system', 'retention.purged', undefined, out);
    return out;
  }
}
