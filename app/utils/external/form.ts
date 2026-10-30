// The external account form and the requests made from it (FR-8). The form reports one input; the
// section turns it into the body of a create (POST) or a change (PUT).
import type {
  ExternalAccountInput,
  ExternalAccountUpdate,
  ExternalAuthMode,
} from '../../../shared/types/external'

export interface ExternalFormInput {
  name: string
  url: string
  authMode: ExternalAuthMode
  /** Only for `basic`. */
  username: string
  /** Only for `basic`; empty when the form was left to keep the old one. */
  password: string
  /** `#rrggbb`, or '' for "the colour the server gives the calendar". */
  color: string
  /** "Remember on this device": keep the sealed credential in this browser's storage. */
  remember: boolean
}

export function toCreateBody(input: ExternalFormInput): ExternalAccountInput {
  const login = input.authMode === 'basic'
  return {
    name: input.name,
    url: input.url,
    authMode: input.authMode,
    color: input.color || null,
    ...(login ? { username: input.username, password: input.password } : {}),
  }
}

export function toUpdateBody(input: ExternalFormInput): ExternalAccountUpdate {
  const login = input.authMode === 'basic'
  return {
    name: input.name,
    url: input.url,
    authMode: input.authMode,
    username: login ? input.username : null,
    color: input.color || null,
    // Without a password the server keeps the credential it has sealed, if the change allows it.
    ...(login && input.password !== '' ? { password: input.password } : {}),
  }
}
