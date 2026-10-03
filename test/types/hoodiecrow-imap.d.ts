// Minimal typing for the hoodiecrow test IMAP server (test-only dependency).
declare module 'hoodiecrow-imap' {
  const hoodiecrow: (options: Record<string, unknown>) => any;
  export default hoodiecrow;
}
