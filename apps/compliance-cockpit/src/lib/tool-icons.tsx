/**
 * Agent-tool name → colored icon badge.
 *
 * Two layers:
 *
 *   1. BRAND OVERRIDES — if the tool name matches a known SaaS / cloud
 *      service (gmail_send, slack_post, stripe_charge, github_create_pr,
 *      pg_select, etc.) we render that service's real logo glyph on its
 *      brand-color disc. SVG paths inlined from Simple Icons (CC0).
 *
 *   2. CATEGORY FALLBACK — for generic tools (web_search, send_email,
 *      execute_sql, shell, …) we render a Lucide glyph on a saturated
 *      category color, Datadog / Sentry / Linear service-icon style.
 *
 * Adding a new brand: paste its Simple Icons <path d="..."> below.
 * Adding a new category: add to ICON + COLOR + classify().
 */

import {
  Globe, FileText, Database, Mail, Terminal, FileCode2, Zap,
  FileEdit, Trash2, Search, Lock, Cog,
  type LucideIcon,
} from 'lucide-react'

// ── BRAND LOGOS ────────────────────────────────────────────────────────────
//   Simple Icons + Lobe Icons paths. White-on-color rendering, 24x24 viewBox.

interface BrandSpec {
  bg: string         // brand color
  path: string       // SVG path data (viewBox 0 0 24 24)
}

const BRAND: Record<string, BrandSpec> = {
  gmail: {
    bg: '#EA4335',
    path: 'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  },
  slack: {
    bg: '#4A154B',
    path: 'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
  },
  stripe: {
    bg: '#635BFF',
    path: 'M13.479 9.883c-1.626-.604-2.512-1.067-2.512-1.803 0-.622.511-.978 1.422-.978 1.667 0 3.379.642 4.558 1.22l.666-4.111c-.935-.446-2.847-1.177-5.49-1.177-1.87 0-3.425.489-4.536 1.401-1.155.954-1.757 2.334-1.757 4 0 3.023 1.847 4.315 4.842 5.401 1.936.69 2.59 1.18 2.59 1.928 0 .735-.62 1.158-1.766 1.158-1.46 0-3.864-.71-5.444-1.624l-.677 4.16c1.358.768 3.867 1.535 6.475 1.535 1.978 0 3.624-.467 4.74-1.345 1.244-.98 1.889-2.42 1.889-4.275 0-3.087-1.857-4.371-4.943-5.481l-.057-.009z',
  },
  github: {
    bg: '#181717',
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  },
  aws: {
    bg: '#FF9900',
    path: 'M6.763 10.036c0 .296.032.535.088.71.064.176.144.368.256.576.04.063.056.127.056.183 0 .08-.048.16-.152.24l-.503.335a.383.383 0 0 1-.208.072c-.08 0-.16-.04-.239-.112a2.47 2.47 0 0 1-.287-.375 6.18 6.18 0 0 1-.248-.471c-.622.734-1.405 1.101-2.347 1.101-.67 0-1.205-.191-1.596-.574-.391-.384-.59-.894-.59-1.533 0-.678.239-1.23.726-1.644.487-.415 1.133-.623 1.955-.623.272 0 .551.024.846.064.296.04.6.104.918.176v-.583c0-.607-.127-1.03-.375-1.277-.255-.248-.686-.367-1.3-.367-.28 0-.568.031-.863.103-.295.072-.583.16-.862.272a2.287 2.287 0 0 1-.28.104.488.488 0 0 1-.127.023c-.112 0-.168-.08-.168-.247v-.391c0-.128.016-.224.056-.28a.597.597 0 0 1 .224-.167c.279-.144.614-.264 1.005-.36a4.84 4.84 0 0 1 1.246-.151c.95 0 1.644.216 2.091.647.439.43.662 1.085.662 1.963v2.586zm-3.24 1.214c.263 0 .534-.048.822-.144.287-.096.543-.271.758-.51.128-.152.224-.32.272-.512.047-.191.08-.423.08-.694v-.335a6.66 6.66 0 0 0-.735-.136 6.02 6.02 0 0 0-.75-.048c-.535 0-.926.104-1.19.32-.263.215-.39.518-.39.917 0 .375.095.655.295.846.191.2.47.296.838.296zm6.41.862c-.144 0-.24-.024-.304-.08-.064-.048-.12-.16-.168-.311L7.586 5.55a1.398 1.398 0 0 1-.072-.32c0-.128.064-.2.191-.2h.783c.151 0 .255.025.31.08.065.048.113.16.16.312l1.342 5.284 1.245-5.284c.04-.16.088-.264.151-.312a.549.549 0 0 1 .32-.08h.638c.152 0 .256.025.32.08.063.048.12.16.151.312l1.261 5.348 1.381-5.348c.048-.16.104-.264.16-.312a.52.52 0 0 1 .311-.08h.743c.127 0 .2.065.2.2 0 .04-.009.08-.017.128a1.137 1.137 0 0 1-.056.2l-1.923 6.17c-.048.16-.104.263-.168.311a.51.51 0 0 1-.303.08h-.687c-.151 0-.255-.024-.32-.08-.063-.056-.119-.16-.15-.32l-1.238-5.148-1.23 5.14c-.04.16-.087.264-.15.32-.065.056-.177.08-.32.08zm10.256.215c-.415 0-.83-.048-1.229-.143-.399-.096-.71-.2-.918-.32-.128-.071-.215-.151-.247-.223a.563.563 0 0 1-.048-.224v-.407c0-.167.064-.247.183-.247.048 0 .096.008.144.024.048.016.12.048.2.08.271.12.566.215.878.279.319.064.63.096.95.096.502 0 .894-.088 1.165-.264a.86.86 0 0 0 .415-.758.777.777 0 0 0-.215-.559c-.144-.151-.416-.287-.807-.415l-1.157-.36c-.583-.183-1.014-.454-1.277-.813a1.902 1.902 0 0 1-.4-1.158c0-.335.073-.63.216-.886.144-.255.336-.479.575-.654.24-.184.51-.32.83-.415.32-.096.655-.136 1.006-.136.175 0 .359.008.535.032.183.024.35.056.518.088.16.04.312.08.455.127.144.048.256.096.336.144a.69.69 0 0 1 .24.2.43.43 0 0 1 .071.263v.375c0 .168-.064.256-.184.256a.83.83 0 0 1-.303-.096 3.652 3.652 0 0 0-1.532-.311c-.455 0-.815.071-1.062.223-.248.152-.375.383-.375.71 0 .224.08.416.24.567.159.152.454.304.877.44l1.134.358c.574.184.99.44 1.237.767.247.327.367.702.367 1.117 0 .343-.072.655-.207.926-.144.272-.336.511-.583.703-.248.2-.543.343-.886.447-.36.111-.734.167-1.142.167zm1.823 4.948c-2.586 1.911-6.341 2.926-9.57 2.926-4.525 0-8.602-1.674-11.685-4.46-.247-.224-.024-.527.272-.351 3.32 1.93 7.43 3.1 11.682 3.1 2.864 0 6.014-.598 8.91-1.83.439-.2.81.287.39.615zm1.07-1.214c-.327-.423-2.179-.2-3.013-.103-.247.032-.287-.183-.064-.343 1.476-1.038 3.9-.738 4.18-.391.28.351-.08 2.775-1.465 3.93-.215.184-.422.088-.327-.151.32-.79 1.038-2.56.71-2.942z',
  },
  notion: {
    bg: '#000000',
    path: 'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933z',
  },
  postgres: {
    bg: '#336791',
    // Simplified elephant silhouette
    path: 'M17.128 0a8.27 8.27 0 0 0-2.187.299l-.041.014a8.474 8.474 0 0 0-1.252-.097 7.792 7.792 0 0 0-4.563 1.34 12.061 12.061 0 0 0-2.508-.262C4.583 1.282 2.45 1.69 1.061 2.5.378 2.897 0 3.357 0 3.857c0 .288.166.567.5.835.36.29.804.523 1.34.708.502.173.943.276 1.41.314.062.005.13.008.197.008.42 0 .763-.094 1.066-.297.302-.2.49-.46.49-.756 0-.155-.057-.302-.166-.42a.604.604 0 0 0-.41-.176c-.16 0-.295.06-.41.156-.06.05-.137.157-.184.323l-.014.05-.013.04c-.012.027-.027.04-.046.04a.297.297 0 0 1-.105-.026 2.85 2.85 0 0 1-.46-.21c-.276-.16-.398-.288-.398-.42 0-.137.166-.297.495-.485.42-.24 1.04-.42 1.787-.518.747-.097 1.6-.146 2.464-.146.733 0 1.41.04 2.005.124-.733.733-1.34 1.658-1.787 2.737-.475 1.146-.708 2.354-.708 3.595 0 .932.146 1.84.435 2.7.146.434.314.842.5 1.214.024.05.094.184.21.412.115.227.226.43.337.62.222.382.466.747.733 1.094 1.094 1.42 2.563 2.354 4.4 2.807.92.226 1.86.34 2.8.34 2.094 0 3.937-.518 5.51-1.55 1.58-1.04 2.804-2.55 3.65-4.547.846-1.997 1.27-4.243 1.27-6.73 0-.55-.024-1.1-.073-1.65-.05-.55-.122-1.094-.22-1.63a8.27 8.27 0 0 0-1.094-2.927A8.27 8.27 0 0 0 19.5.85 8.27 8.27 0 0 0 17.128 0z',
  },
  openai: {
    bg: '#10A37F',
    // Simplified OpenAI mark (just the central node)
    path: 'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646z',
  },
  anthropic: {
    bg: '#D97757',
    path: 'M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z',
  },
}

/** Match a tool name to a brand. Returns null if it's generic. */
function detectBrand(toolName: string | null | undefined): keyof typeof BRAND | null {
  if (!toolName) return null
  const n = toolName.toLowerCase()
  if (/^gmail|_gmail|gmail_/.test(n)) return 'gmail'
  if (/^slack|_slack|slack_/.test(n)) return 'slack'
  if (/^stripe|_stripe|stripe_/.test(n)) return 'stripe'
  if (/^github|_github|github_|^gh_|_gh_/.test(n)) return 'github'
  if (/^aws|_aws|aws_|^s3_|_s3_|^lambda_|_lambda_/.test(n)) return 'aws'
  if (/^notion|_notion|notion_/.test(n)) return 'notion'
  if (/^postgres|_postgres|postgres_|^pg_/.test(n)) return 'postgres'
  if (/^openai|_openai|openai_|^gpt_/.test(n)) return 'openai'
  if (/^anthropic|_anthropic|anthropic_|^claude_/.test(n)) return 'anthropic'
  return null
}

// ── CATEGORY FALLBACK ─────────────────────────────────────────────────────

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
  search:      '#4285F4',   // Google blue
  file_read:   '#0EA5E9',   // sky blue
  file_write:  '#F59E0B',   // amber
  file_delete: '#EF4444',   // red
  db:          '#336791',   // Postgres blue
  shell:       '#1F2937',   // terminal black
  email:       '#EA4335',   // Gmail red (generic email defaults to Gmail tone)
  http:        '#FF6C37',   // Postman orange
  code:        '#61DAFB',   // React blue
  secret:      '#D97706',   // amber alert
  config:      '#6B7280',   // gray
  other:       '#9CA3AF',   // light gray
}

function classify(toolName: string | null | undefined): ToolKey {
  if (!toolName) return 'other'
  const n = toolName.toLowerCase()
  if (/search|lookup|find|query_(?:wiki|kb|knowledge)|fancy_lookup/.test(n)) return 'search'
  if (/(?:^|_)delete[_-]?(?:file|object)|rm$|unlink/.test(n))    return 'file_delete'
  if (/write|append|put_(?:file|object)|upload|save/.test(n))    return 'file_write'
  if (/read|cat|head|tail|get_(?:file|object)|fetch_file/.test(n)) return 'file_read'
  if (/sql|query|select|insert|update|delete_row|^db|_db|database/.test(n)) return 'db'
  if (/shell|run_cmd|execute_(?:code|cmd|shell)|bash|sh$|spawn/.test(n)) return 'shell'
  if (/email|mail|smtp/.test(n)) return 'email'
  if (/http|fetch|request|webhook|post|get_url|api_call/.test(n)) return 'http'
  if (/code|compile|build|publish|deploy|npm|pip/.test(n)) return 'code'
  if (/secret|token|key|password|credential/.test(n)) return 'secret'
  if (/config|setting|env/.test(n)) return 'config'
  return 'other'
}

/** Legacy API kept for backward compatibility — returns Lucide + hex. */
export function toolIconFor(toolName: string | null | undefined): { Icon: LucideIcon; color: string } {
  const key = classify(toolName)
  return { Icon: ICON[key], color: COLOR[key] }
}

/**
 * Colored circular icon badge with brand-aware override.
 *
 *   <ToolIcon name="execute_sql" />          — Postgres-blue Database
 *   <ToolIcon name="gmail_send" />           — Gmail-red envelope (BRAND)
 *   <ToolIcon name="stripe_charge" />        — Stripe-purple S (BRAND)
 *   <ToolIcon name="execute_shell" size={28}/> — terminal-black >_
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
  const brand = detectBrand(name)
  const glyphSize = Math.round(size * 0.6)

  // Brand override — render the real service logo.
  if (brand) {
    const spec = BRAND[brand]
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
          background: spec.bg,
          flexShrink: 0,
          boxShadow: '0 1px 2px hsl(0 0% 0% / 0.10), inset 0 -1px 0 hsl(0 0% 0% / 0.08)',
        }}
        aria-label={brand}
      >
        <svg width={glyphSize} height={glyphSize} viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
          <path d={spec.path} />
        </svg>
      </span>
    )
  }

  // Category fallback.
  const key = classify(name)
  const Icon = ICON[key]
  const color = COLOR[key]
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
