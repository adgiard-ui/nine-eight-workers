const encoder = new TextEncoder();

/**
 * Constant-time check of the manual-trigger header against
 * MANUAL_TRIGGER_SECRET. Both sides are SHA-256 hashed first so the
 * comparison is always over 32 bytes — a plain `!==` (or a byte compare
 * that exits on a length mismatch) leaks how much of a guess was right.
 * An unset/empty configured secret never matches anything.
 */
export async function secretsMatch(provided: string | null, expected: string | undefined): Promise<boolean> {
  if (!expected) {
    return false;
  }
  const [providedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided ?? "")),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const a = new Uint8Array(providedDigest);
  const b = new Uint8Array(expectedDigest);
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return provided !== null && diff === 0;
}
