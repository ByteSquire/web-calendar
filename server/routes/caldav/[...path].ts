import { handleGatewayRequest } from '../../utils/gateway/nitro'

// All methods: h3 falls back to this handler for PROPFIND, REPORT and the other WebDAV methods.
export default defineEventHandler((event) => handleGatewayRequest(event))
