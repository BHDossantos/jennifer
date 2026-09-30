import { z } from 'zod';
import type { Space, Sensitivity } from '../core/types.js';
import { type Clock, newId, sha256 } from '../core/util.js';
import type { MemoryEntry, MemoryStore } from './memory.js';

/**
 * Explicit context bridge from a user-supplied ChatGPT export (spec §11).
 * Jennifer never scrapes a signed-in account or reuses session cookies; she
 * only knows conversations Bruno chose to import.
 *
 * Accepts the `conversations.json` shape found in ChatGPT data exports. The
 * format is validated leniently and unknown shapes are rejected rather than
 * guessed at.
 */
const ExportMessage = z.object({
  id: z.string(),
  author: z.object({ role: z.string() }),
  create_time: z.number().nullable().optional(),
  content: z.object({ content_type: z.string().optional(), parts: z.array(z.unknown()).optional() }).optional(),
});
const ExportConversation = z.object({
  id: z.string().optional(),
  conversation_id: z.string().optional(),
  title: z.string().nullable().optional(),
  create_time: z.number().nullable().optional(),
  mapping: z.record(z.string(), z.object({ message: ExportMessage.nullable().optional() })),
});
const ExportFile = z.array(ExportConversation);

export interface ImportedMessage {
  importId: string;
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  role: string;
  text: string;
  createdAt?: Date;
}

export interface ImportRecord {
  id: string;
  ownerId: string;
  checksum: string;
  importedAt: Date;
  messageCount: number;
  duplicateCount: number;
  conversationIds: string[];
  deleted: boolean;
}

export interface ProposedMemory {
  id: string;
  sourceMessage: ImportedMessage;
  kind: MemoryEntry['kind'];
  value: string;
  space: Space;
  sensitivity: Sensitivity;
}

const SENSITIVE_HINTS = /\b(health|medical|diagnos|bank|iban|salary|debt|passport|codice fiscale|ssn|password|lawyer|divorce|girlfriend|boyfriend|wife|husband)\b/i;

export class ChatGptImporter {
  private imports = new Map<string, ImportRecord>();
  private messages = new Map<string, ImportedMessage>(); // key: conversationId:messageId
  private proposals = new Map<string, ProposedMemory>();

  constructor(
    private clock: Clock,
    private memory: MemoryStore,
  ) {}

  /** Parse, checksum and deduplicate. Nothing enters active memory here. */
  importExport(ownerId: string, rawJson: string, selectedConversationIds?: string[]): ImportRecord {
    const checksum = sha256(rawJson);
    const prior = [...this.imports.values()].find((i) => i.checksum === checksum && !i.deleted && i.ownerId === ownerId);
    if (prior) return prior;

    const parsed = ExportFile.parse(JSON.parse(rawJson));
    const rec: ImportRecord = { id: newId('imp'), ownerId, checksum, importedAt: this.clock.now(), messageCount: 0, duplicateCount: 0, conversationIds: [], deleted: false };
    for (const conv of parsed) {
      const convId = conv.conversation_id ?? conv.id ?? newId('cgc');
      if (selectedConversationIds && !selectedConversationIds.includes(convId)) continue;
      rec.conversationIds.push(convId);
      for (const node of Object.values(conv.mapping)) {
        const m = node.message;
        if (!m) continue;
        const text = (m.content?.parts ?? []).filter((p): p is string => typeof p === 'string').join('\n').trim();
        if (!text || m.author.role === 'system' || m.author.role === 'tool') continue;
        const key = `${convId}:${m.id}`;
        if (this.messages.has(key)) {
          rec.duplicateCount++;
          continue;
        }
        this.messages.set(key, {
          importId: rec.id,
          conversationId: convId,
          conversationTitle: conv.title ?? 'Untitled',
          messageId: m.id,
          role: m.author.role,
          text,
          createdAt: m.create_time ? new Date(m.create_time * 1000) : undefined,
        });
        rec.messageCount++;
      }
    }
    this.imports.set(rec.id, rec);
    return rec;
  }

  importedMessages(importId: string): ImportedMessage[] {
    return [...this.messages.values()].filter((m) => m.importId === importId);
  }

  /**
   * Propose memory additions from Bruno's own statements in the import.
   * Assistant-side text is not treated as fact about Bruno.
   */
  propose(importId: string, space: Space, extract: (m: ImportedMessage) => Array<{ kind: MemoryEntry['kind']; value: string }>): ProposedMemory[] {
    const out: ProposedMemory[] = [];
    for (const m of this.importedMessages(importId)) {
      if (m.role !== 'user') continue;
      for (const f of extract(m)) {
        if (this.memory.isDeleted(this.imports.get(importId)!.ownerId, undefined, f.value)) continue;
        const p: ProposedMemory = { id: newId('prop'), sourceMessage: m, kind: f.kind, value: f.value, space, sensitivity: SENSITIVE_HINTS.test(f.value) ? 'sensitive' : 'normal' };
        this.proposals.set(p.id, p);
        out.push(p);
      }
    }
    return out;
  }

  pendingProposals(): ProposedMemory[] {
    return [...this.proposals.values()];
  }

  /** Bruno accepts a proposal from the import review screen. */
  accept(proposalId: string, ownerId: string): MemoryEntry {
    const p = this.proposals.get(proposalId);
    if (!p) throw new Error(`No proposal ${proposalId}`);
    this.proposals.delete(proposalId);
    return this.memory.add({
      ownerId,
      kind: p.kind,
      space: p.space,
      value: p.value,
      source: {
        kind: 'imported_conversation',
        ref: `chatgpt:${p.sourceMessage.importId}:${p.sourceMessage.conversationId}:${p.sourceMessage.messageId}`,
        excerpt: p.sourceMessage.text.slice(0, 280),
        assertedBy: ownerId,
      },
      confidence: 'reported',
      sensitivity: p.sensitivity,
      retention: 'indefinite',
      effectiveFrom: p.sourceMessage.createdAt,
    });
  }

  /** Answer lookup against imported conversations only; missing history is admitted, never invented. */
  search(ownerId: string, query: string): { found: ImportedMessage[]; note: string } {
    const q = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const owned = new Set([...this.imports.values()].filter((i) => i.ownerId === ownerId && !i.deleted).map((i) => i.id));
    const found = [...this.messages.values()].filter((m) => owned.has(m.importId) && q.some((t) => m.text.toLowerCase().includes(t)));
    return {
      found,
      note: found.length ? 'Answer is limited to imported conversations; see source references.' : "I don't have that in the conversations you've imported, so I can't answer from your ChatGPT history.",
    };
  }

  deleteImport(importId: string): void {
    const rec = this.imports.get(importId);
    if (!rec) return;
    rec.deleted = true;
    for (const [k, m] of this.messages) if (m.importId === importId) this.messages.delete(k);
    for (const [k, p] of this.proposals) if (p.sourceMessage.importId === importId) this.proposals.delete(k);
  }
}
