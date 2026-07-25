export function shouldSendAsSteering(text: string, hasActiveRequest: boolean): boolean {
  return hasActiveRequest && !text.trim().startsWith('/');
}
