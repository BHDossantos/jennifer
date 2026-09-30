import { createHash } from 'node:crypto';

/**
 * Embedding adapter. Production uses a hosted embedding model behind this
 * interface (stored in pgvector); tests and the simulator use a deterministic
 * hashing embedder so retrieval behavior is reproducible offline.
 */
export interface Embedder {
  embed(text: string): number[];
}

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'for', 'on', 'at', 'my', 'me', 'i', 'do', 'what', 'with', 'you']);

export class HashingEmbedder implements Embedder {
  constructor(private dims = 256) {}

  embed(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    const tokens = text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t));
    for (const t of tokens) {
      const h = createHash('md5').update(t).digest();
      const idx = h.readUInt16BE(0) % this.dims;
      v[idx]! += 1;
    }
    return v;
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
