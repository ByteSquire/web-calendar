// The checks the server runs once at startup (L2), so a bad configuration stops it there instead
// of failing every request later. The runner is plain; the plugin that wires it to the glue
// modules is server/plugins/startup.ts.
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { createEvent, type H3Event } from 'h3'

export interface StartupCheck {
  name: string
  /** Throws (or rejects) when the part is not usable. */
  run: () => unknown
}

/** Runs every check, none is skipped because another failed. Returns one message per failure. */
export async function runStartupChecks(checks: readonly StartupCheck[]): Promise<string[]> {
  const failures: string[] = []
  for (const check of checks) {
    try {
      await check.run()
    } catch (error) {
      failures.push(`${check.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return failures
}

/**
 * A request event for a self-test: it never touches the network and has no client address. Real
 * Node objects, because the gateway glue reads the Node request and response directly.
 */
export function createSelfTestEvent(method: string, path: string): H3Event {
  const request = new IncomingMessage(new Socket())
  request.method = method
  request.url = path
  return createEvent(request, new ServerResponse(request))
}
