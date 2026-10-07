import { ConnectorProviderError } from "./types/provider.js";
export class ConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}
export function failure(error: unknown): { code: string; message: string } {
  if (error instanceof ConnectionError)
    return { code: error.code, message: error.message };
  if (error instanceof ConnectorProviderError)
    return { code: error.code, message: error.message };
  return {
    code: "unavailable",
    message:
      "Connections could not complete this request. Refresh to check its state; do not repeat an external operation to recover its result.",
  };
}
