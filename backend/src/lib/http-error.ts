/** Error shape matching src/lib/api/types.ts ApiError, thrown by route
 * handlers and translated to a JSON response by the Fastify error handler
 * in src/index.ts. */
export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found.`)
export const forbidden = (message = "You do not have access to this resource.") =>
  new HttpError(403, "FORBIDDEN", message)
export const unauthorized = (message = "Authentication required.") => new HttpError(401, "UNAUTHORIZED", message)
export const badRequest = (message: string) => new HttpError(400, "BAD_REQUEST", message)
