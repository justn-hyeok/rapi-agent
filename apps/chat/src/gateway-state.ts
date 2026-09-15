export function establishesGatewaySession(
  eventType: string | undefined,
): boolean {
  return eventType === "READY" || eventType === "RESUMED";
}
