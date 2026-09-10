export function notificationProtocolScheme(packaged: boolean): string {
  return packaged ? 'dfy-dsh-notification' : 'dfy-dsh-notification-dev'
}

/** Only a single explicit notification URL can dispatch an in-memory action. */
export function handleNotificationProtocolArguments(
  args: readonly string[],
  scheme: string,
  handle: (url: string) => unknown,
): boolean {
  const prefix = `${scheme}:`
  const candidates = args.filter((arg) => arg.toLowerCase().startsWith(prefix))
  if (candidates.length === 0) return false
  if (candidates.length === 1) handle(candidates[0]!)
  // Unknown, stale, or ambiguous notification URLs never become approval
  // requests or an instruction to focus a different pending interaction.
  return true
}
