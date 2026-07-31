const canonicalUuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isCanonicalUuidV7(value: string): boolean {
  return canonicalUuidV7.test(value)
}
