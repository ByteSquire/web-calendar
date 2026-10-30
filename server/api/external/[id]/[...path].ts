import { defineApiHandler } from '../../../utils/api/handler'
import { handleExternalRequest } from '../../../utils/external/nitro'

// The pass-through proxy for an external CalDAV account (FR-8). All methods reach this handler, and
// h3 falls back to it for PROPFIND and REPORT; the proxy allows the read-only ones and answers
// the rest with a JSON 405. The frame is the usual one: a bearer token (an app token over Basic is
// not accepted, `requireUser`), then the proxy, whose own answers are `{ "error": "<code>" }`.
export default defineApiHandler((event, { user }) =>
  handleExternalRequest(event, { id: user.id, sub: user.sub }),
)
