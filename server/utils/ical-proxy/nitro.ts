import { createError } from 'h3'
import { createIcalProxy, type IcalProxy } from './cache'
import { ALLOW_PRIVATE_ACK_VARIABLE, outboundScopeError, parseIcalProxyConfig } from './config'
import { IcalFetchError } from './errors'
import { parseHostList } from './host-list'
import { createAddressPolicy, hostnameOf, type AddressPolicy } from './ssrf'

// Nitro glue of the iCal proxy: reads the runtime config once and owns the one proxy instance,
// so its cache is shared by all requests. The logic is in the plain modules next to this file.
// It also owns the address policy every outbound request of the server goes through: the iCal
// subscriptions and the external CalDAV accounts (server/utils/external) use the same one.

let runtime: { proxy: IcalProxy; policy: AddressPolicy; allowPrivate: boolean } | undefined

/** The host of the CalDAV store, which no outbound request may ever reach; null when unusable. */
function radicaleHost(url: string): string | null {
  try {
    return hostnameOf(new URL(url))
  } catch {
    return null
  }
}

function getRuntime() {
  if (!runtime) {
    // Read from the environment, not from runtimeConfig: the second switch is a deliberate act
    // of the operator and has no entry in nuxt.config.ts or .env.example.
    const config = parseIcalProxyConfig(useRuntimeConfig().icalProxy, {
      production: process.env.NODE_ENV === 'production',
      allowPrivateAcknowledged: process.env[ALLOW_PRIVATE_ACK_VARIABLE] === 'true',
    })
    if (config.allowPrivate) {
      console.warn(
        '[ical-proxy] WARNING: private addresses are allowed (NUXT_ICAL_PROXY_ALLOW_PRIVATE): ' +
          'the SSRF guard is OFF. For tests only.',
      )
    }
    const { outbound, radicale } = useRuntimeConfig()
    // A list that cannot be read is not guessed at: dropping a bad entry would allow MORE hosts
    // than the administrator wrote, so the server does not start (server/validate-config.mjs).
    const { list, problems } = parseHostList(String(outbound.allowedHosts))
    if (problems.length > 0) {
      throw new Error(`NUXT_OUTBOUND_ALLOWED_HOSTS cannot be used: ${problems.join('; ')}`)
    }
    const production = process.env.NODE_ENV === 'production'
    const allowAnyHost = String(outbound.allowAnyHost) === 'true'
    const open = outboundScopeError({ production, hostCount: list.size, allowAnyHost })
    if (open) throw new Error(open)
    if (list.size > 0) {
      console.info(`[outbound] only ${list.size} listed host entries may be contacted`)
    } else if (production) {
      console.warn(
        '[outbound] WARNING: NUXT_OUTBOUND_ALLOW_ANY_HOST=true and no host list: the server ' +
          'contacts any public host its users name.',
      )
    }
    const store = radicaleHost(radicale.url)
    const policy = createAddressPolicy({
      allowPrivate: config.allowPrivate,
      allowedHosts: list,
      refusedHosts: store === null ? [] : [store],
    })
    runtime = {
      proxy: createIcalProxy({ config, policy }),
      policy,
      allowPrivate: config.allowPrivate,
    }
  }
  return runtime
}

export function getIcalProxy(): IcalProxy {
  return getRuntime().proxy
}

/** The address policy of all outbound requests: host list, SSRF rules, the store's host refused. */
export function getIcalPolicy(): AddressPolicy {
  return getRuntime().policy
}

/** NUXT_ICAL_PROXY_ALLOW_PRIVATE (tests only): the SSRF rules are off, and so is the https rule. */
export function privateAddressesAllowed(): boolean {
  return getRuntime().allowPrivate
}

/** The 502 of the data endpoint: the browser learns why, never the URL. Others pass unchanged. */
export function toGatewayError(error: unknown): unknown {
  if (!(error instanceof IcalFetchError)) return error
  return createError({
    statusCode: 502,
    statusMessage: 'Bad Gateway',
    data: { reason: error.reason },
  })
}
