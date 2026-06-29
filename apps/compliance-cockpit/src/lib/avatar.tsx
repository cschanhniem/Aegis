/**
 * Email avatar — deterministic colored initial badge. Same email →
 * same color forever (hashed pick from an 8-color palette). No network
 * fetch, no Gravatar dependency, no broken-image flash.
 *
 * Use as <EmailAvatar email="alice@acme.dev" size={22} />.
 */

const PALETTE = ['#EF4444','#F59E0B','#10B981','#0EA5E9','#6366F1','#8B5CF6','#EC4899','#14B8A6']
function hueFor(email: string): string {
  let h = 0
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function EmailAvatar({ email, size = 22 }: { email: string; size?: number }) {
  const norm = email.trim().toLowerCase()
  const initial = (norm[0] || '?').toUpperCase()
  return (
    <span
      aria-label={email}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: '50%',
        background: hueFor(norm), color: '#fff',
        fontSize: Math.round(size * 0.5), fontWeight: 600, flexShrink: 0,
        boxShadow: '0 1px 2px hsl(0 0% 0% / 0.10), inset 0 -1px 0 hsl(0 0% 0% / 0.08)',
      }}
    >{initial}</span>
  )
}
