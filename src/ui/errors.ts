/**
 * Turn anything a failed call throws into a sentence a person can read.
 *
 * `usePluginAction()` does not throw an `Error`. On failure it throws the
 * host's `PluginBridgeError`, a plain `{ code, message, details? }` object, so
 * `error instanceof Error` is false. The old `String(error)` fallback then
 * rendered "[object Object]", and the real reason ("Another person is signing
 * in…") never reached the page.
 */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const { message, error: nested } = error as { message?: unknown; error?: unknown };
    if (typeof message === "string" && message.trim()) return message;
    if (typeof nested === "string" && nested.trim()) return nested;
  }
  return fallback;
}
