import { describe, expect, it } from 'vitest';
import { sanitizeForModel } from '../../src/security/untrusted.js';

describe('sanitizeForModel', () => {
  it('strips scripts, styles and tags, keeping visible text', () => {
    expect(sanitizeForModel('<script>alert(1)</script>hello <b>world</b>')).toBe('hello  world');
    expect(sanitizeForModel('<style>p{}</style >text')).toBe('text');
    expect(sanitizeForModel('</script >x<script >y</script >')).toBe('x');
  });

  it('does not let a removed tag join its neighbours into a new one', () => {
    for (const input of ['<scr<b></b>ipt>alert(1)</script>', '<<b>script>bad</script>', '<sc<script>x</script>ript>y']) {
      expect(sanitizeForModel(input)).not.toMatch(/<\s*(script|style)/i);
    }
    expect(sanitizeForModel('<script unclosed')).toBe('&lt;script unclosed');
  });
});
