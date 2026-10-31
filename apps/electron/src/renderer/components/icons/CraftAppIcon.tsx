import craftLogo from "@/assets/craft_logo_c.svg"

interface CraftAppIconProps {
  className?: string | undefined
  size?: number | undefined
}

/**
 * CraftAppIcon - Displays the Craft logo (colorful "C" icon)
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  return (
    <img
      src={craftLogo}
      alt="Craft"
      width={size}
      height={size}
      className={className}
    />
  )
}
