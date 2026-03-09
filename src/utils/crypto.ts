export function constantTimeCompare(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let result = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i++) {
    // eslint-disable-next-line security/detect-object-injection -- i is a bounds-checked numeric loop index
    const aByte = i < aBytes.length ? aBytes[i]! : 0;
    // eslint-disable-next-line security/detect-object-injection -- i is a bounds-checked numeric loop index
    const bByte = i < bBytes.length ? bBytes[i]! : 0;
    result |= aByte ^ bByte;
  }
  return result === 0;
}
