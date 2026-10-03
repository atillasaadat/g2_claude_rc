// Every bridge call shares one BLE link. Concurrent render and storage calls
// can crash the connection, and a flaky hop can hang for ~30 s, so calls run
// one at a time with a per-call timeout.

export const BRIDGE_TIMEOUT_MS = 4_000

export class BridgeQueue {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(label: string, fn: () => Promise<T>, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<T> {
    const next = this.tail.then(() => withTimeout(label, fn(), timeoutMs))
    // Keep the chain alive after a failure; the caller still sees the error.
    this.tail = next.catch(() => undefined)
    return next
  }
}

function withTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
