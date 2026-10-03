// Kept free of Workers imports so tests can load it.
/**
 * Rate-limit key for a client IP. IPv6 clients usually control a whole /64,
 * so they are grouped by it; IPv4 addresses stand alone.
 */
export function ipKey(ip: string): string {
  if (!ip.includes(':')) return ip
  const [head = '', tail = ''] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left
  return `${groups.slice(0, 4).map(g => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}
