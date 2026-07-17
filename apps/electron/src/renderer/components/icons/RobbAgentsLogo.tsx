interface RobbAgentsLogoProps {
  className?: string
}

/** Full Robb Agents wordmark for design-system and marketing surfaces. */
export function RobbAgentsLogo({ className }: RobbAgentsLogoProps) {
  return (
    <div className={className} role="img" aria-label="Robb Agents">
      <svg viewBox="0 0 340 64" fill="none" xmlns="http://www.w3.org/2000/svg" className="h-full w-full">
        <g transform="translate(0 0)">
          <path
            d="M8 49V15h19.5C38.2 15 45 20.8 45 30c0 6.2-3.4 11-9.1 13.7L47 55H35.5L25.6 44H19v5H8Zm11-15h8.1c4.3 0 6.9-1.7 6.9-4.7s-2.6-4.7-6.9-4.7H19V34Z"
            fill="currentColor"
          />
          <path d="M4 54.5c12.7-4.3 23.2-4.1 32-.8 3.2 1.2 6.1 1.8 8.8 1.8" stroke="currentColor" strokeOpacity=".55" strokeWidth="5" strokeLinecap="round" />
          <circle cx="40.5" cy="13.5" r="4.5" fill="currentColor" fillOpacity=".55" />
        </g>
        <text x="62" y="34" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="27" fontWeight="600" letterSpacing="-1.2">ROBB</text>
        <text x="62" y="54" fill="currentColor" opacity=".55" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="13" fontWeight="600" letterSpacing="3.1">AGENTS</text>
      </svg>
    </div>
  )
}
