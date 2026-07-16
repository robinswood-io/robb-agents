interface RobbAgentsSymbolProps {
  className?: string
  title?: string
  /** Use one UI color when the surrounding surface requires a template mark. */
  monochrome?: boolean
}

/**
 * Robb Agents product symbol: a deliberate R with a coral agent trajectory.
 * The R follows the surrounding UI color while the trajectory keeps the
 * Robinswood coral recognition cue at every size.
 */
export function RobbAgentsSymbol({ className, title, monochrome = false }: RobbAgentsSymbolProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <path
        d="M15 48V14h19.5C45.2 14 52 19.8 52 29c0 6.2-3.4 11-9.1 13.7L54 54H42.5L32.6 43H26v5H15Zm11-15h8.1c4.3 0 6.9-1.7 6.9-4.7s-2.6-4.7-6.9-4.7H26V33Z"
        fill="currentColor"
      />
      <path
        d="M10 53.5c12.7-4.3 23.2-4.1 32-.8 7.7 2.9 14.5 2.1 20.5-2.8"
        stroke={monochrome ? 'currentColor' : '#E0796B'}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle cx="47.5" cy="12.5" r="4.5" fill={monochrome ? 'currentColor' : '#E0796B'} />
    </svg>
  )
}
