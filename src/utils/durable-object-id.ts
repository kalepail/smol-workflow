const DURABLE_OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/i;

export function isDurableObjectId(id: unknown): id is string {
  return typeof id === "string" && DURABLE_OBJECT_ID_PATTERN.test(id);
}
