// Relay WebSocket URLs, shared by the channel and the glasses app.

export type Role = 'computer' | 'glasses'

const trim = (relayUrl: string): string => relayUrl.replace(/\/+$/, '')

/** A key room. `auth` is relayAuthToken(key, roomId): the relay turns away sockets without it. */
export function relayRoomUrl(relayUrl: string, roomId: string, role: Role, auth: string): string {
  return `${trim(relayUrl)}/v1/room/${roomId}?role=${role}&auth=${encodeURIComponent(auth)}`
}

/** A pairing room (pairing by code): open to anyone, short-lived. */
export function relayPairUrl(relayUrl: string, roomId: string, role: Role): string {
  return `${trim(relayUrl)}/v1/pair/${roomId}?role=${role}`
}
