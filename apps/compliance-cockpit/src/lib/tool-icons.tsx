/**
 * Agent-tool name → colored icon badge.
 *
 * Each tool category gets a vivid filled circular badge (Datadog /
 * Sentry / Linear service-icon pattern) so rows scan in a single
 * glance. The glyph inside is white; the badge fill is a saturated
 * brand-ish hue per category. Both color and shape carry meaning.
 */

import {
  Globe, FileText, Database, Mail, Terminal, FileCode2, Zap,
  FileEdit, Trash2, Search, Lock, Cog,
  type LucideIcon,
} from 'lucide-react'

/** Canonical tool buckets. */
type ToolKey =
  | 'search'  | 'file_read' | 'file_write' | 'file_delete'
  | 'db'      | 'shell'     | 'email'      | 'http'
  | 'code'    | 'secret'    | 'config'     | 'other'

const ICON: Record<ToolKey, LucideIcon> = {
  search:      Search,
  file_read:   FileText,
  file_write:  FileEdit,
  file_delete: Trash2,
  db:          Database,
  shell:       Terminal,
  email:       Mail,
  http:        Globe,
  code:        FileCode2,
  secret:      Lock,
  config:      Cog,
  other:       Zap,
}

/** Saturated brand-ish fill per category. Picked from real product palettes:
 *  search=Google blue, email=Gmail red, db=Postgres blue, shell=terminal black,
 *  http=Postman orange, file_*=teal/amber/red, code=React blue,
 *  secret=lock amber, config=gray. */
const COLOR: Record<ToolKey, string> = {
  search:      '#4285F4',   // Google blue
  file_read:   '#0EA5E9',   // sky blue
  file_write:  '#F59E0B',   // amber (write = caution)
  file_delete: '#EF4444',   // red (destructive)
  db:          '#336791',   // Postgres blue
  shell:       '#1F2937',   // terminal black
  email:       '#EA4335',   // Gmail red
  http:        '#FF6C37',   // Postman orange
  code:        '#61DAFB',   // React blue
  secret:      '#D97706',   // sharp amber
  config:      '#6B7280',   // neutral gray
  other:       '#9CA3AF',   // light gray
}

/** Map a raw tool name (snake_case from the SDK) to its canonical bucket. */
function classify(toolName: string | null | undefined): ToolKey {
  if (!toolName) return 'other'
  const n = toolName.toLowerCase()

  if (/search|lookup|find|query_(?:wiki|kb|knowledge)|fancy_lookup/.test(n)) return 'search'

  if (/(?:^|_)delete[_-]?(?:file|object)|rm$|unlink/.test(n))    return 'file_delete'
  if (/write|append|put_(?:file|object)|upload|save/.test(n))    return 'file_write'
  if (/read|cat|head|tail|get_(?:file|object)|fetch_file/.test(n)) return 'file_read'

  if (/sql|query|select|insert|update|delete_row|db|database/.test(n)) return 'db'

  if (/shell|run_cmd|execute_(?:code|cmd|shell)|bash|sh$|spawn/.test(n)) return 'shell'

  if (/email|mail|smtp/.test(n)) return 'email'

  if (/http|fetch|request|webhook|post|get_url|api_call/.test(n)) return 'http'

  if (/code|compile|build|publish|deploy|npm|pip/.test(n)) return 'code'

  if (/secret|token|key|password|credential/.test(n)) return 'secret'

  if (/config|setting|env/.test(n)) return 'config'

  return 'other'
}

/** Legacy API — returns the raw Lucide component + a hex tint.
 *  Kept so existing call sites that destructure { Icon, color } don't break.
 *  New code should prefer the <ToolIcon /> badge component below. */
export function toolIconFor(toolName: string | null | undefined): { Icon: LucideIcon; color: string } {
  const key = classify(toolName)
  return { Icon: ICON[key], color: COLOR[key] }
}

/**
 * Colored circular icon badge.
 *
 *   <ToolIcon name="execute_sql" />        — 22px badge (default)
 *   <ToolIcon name="send_email" size={28}/> — bigger
 *
 * The `size` prop is the badge diameter. The Lucide glyph inside scales
 * to about 60% of that. White-on-color, with a soft drop-shadow so the
 * badge reads as a "real" service icon on both light and dark surfaces.
 */
export function ToolIcon({
  name,
  size = 22,
  className,
}: {
  name: string | null | undefined
  size?: number
  className?: string
}) {
  const key = classify(name)
  const Icon = ICON[key]
  const color = COLOR[key]
  const glyphSize = Math.round(size * 0.58)
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        boxShadow: '0 1px 2px hsl(0 0% 0% / 0.10), inset 0 -1px 0 hsl(0 0% 0% / 0.08)',
      }}
      aria-label={key}
    >
      <Icon size={glyphSize} color="#fff" strokeWidth={2.2} aria-hidden="true" />
    </span>
  )
}
