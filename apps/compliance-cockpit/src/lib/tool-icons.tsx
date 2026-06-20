/**
 * One mapping of agent-tool name → Lucide icon + warm-palette color.
 * Used everywhere a tool call is rendered so rows scan in a single
 * glance instead of forcing the reader to parse the snake_case name.
 *
 * Adding a new tool? Pick the closest verb / object icon from lucide.dev
 * and a color from the existing palette below — don't introduce new hues.
 */

import {
  Globe, FileText, Database, Send, Mail, Terminal, FileCode2, Zap,
  Folder, FileEdit, Trash2, Search, Lock, Key, ShieldQuestion, Cog,
  type LucideIcon,
} from 'lucide-react'

/** Canonical tool buckets — kept short so adding new tools is cheap. */
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

const COLOR: Record<ToolKey, string> = {
  search:      'hsl(210 25% 42%)',  // calm blue
  file_read:   'hsl(255 18% 48%)',  // muted purple
  file_write:  'hsl(36  35% 38%)',  // warm amber (writes are write-heavier)
  file_delete: 'hsl(0   30% 44%)',  // soft red (destructive)
  db:          'hsl(36  28% 36%)',  // warm brown
  shell:       'hsl(220 10% 28%)',  // near-black (powerful)
  email:       'hsl(180 22% 34%)',  // teal
  http:        'hsl(210 25% 42%)',  // calm blue (same as search)
  code:        'hsl(255 18% 48%)',  // muted purple
  secret:      'hsl(36  60% 36%)',  // sharp amber (sensitive)
  config:      'hsl(45  8%  46%)',  // gray
  other:       'hsl(45  8%  46%)',  // gray
}

/** Map a raw tool name (snake_case from the SDK) to its canonical bucket. */
function classify(toolName: string | null | undefined): ToolKey {
  if (!toolName) return 'other'
  const n = toolName.toLowerCase()

  // search / lookup verbs
  if (/search|lookup|find|query_(?:wiki|kb|knowledge)|fancy_lookup/.test(n)) return 'search'

  // file ops — order matters: write/delete before read
  if (/(?:^|_)delete[_-]?(?:file|object)|rm$|unlink/.test(n))    return 'file_delete'
  if (/write|append|put_(?:file|object)|upload|save/.test(n))    return 'file_write'
  if (/read|cat|head|tail|get_(?:file|object)|fetch_file/.test(n)) return 'file_read'

  // database
  if (/sql|query|select|insert|update|delete_row|db|database/.test(n)) return 'db'

  // shell / commands
  if (/shell|run_cmd|execute_(?:code|cmd|shell)|bash|sh$|spawn/.test(n)) return 'shell'

  // email
  if (/email|mail|smtp/.test(n)) return 'email'

  // generic HTTP
  if (/http|fetch|request|webhook|post|get_url|api_call/.test(n)) return 'http'

  // code / source maps / packages
  if (/code|compile|build|publish|deploy|npm|pip/.test(n)) return 'code'

  // credentials / secrets
  if (/secret|token|key|password|credential/.test(n)) return 'secret'

  // config
  if (/config|setting|env/.test(n)) return 'config'

  return 'other'
}

export function toolIconFor(toolName: string | null | undefined): { Icon: LucideIcon; color: string } {
  const key = classify(toolName)
  return { Icon: ICON[key], color: COLOR[key] }
}

/** Drop-in <ToolIcon name="execute_sql" /> renderer. */
export function ToolIcon({ name, size = 14, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const { Icon, color } = toolIconFor(name)
  return <Icon size={size} className={className} style={{ color, flexShrink: 0 }} aria-hidden="true" />
}
