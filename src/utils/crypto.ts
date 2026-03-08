export function constantTimeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let result = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i++) {
    const aByte = i < aBytes.length ? aBytes[i]! : 0;
    const bByte = i < bBytes.length ? bBytes[i]! : 0;
    result |= aByte ^ bByte;
  }
  return result === 0;
}
