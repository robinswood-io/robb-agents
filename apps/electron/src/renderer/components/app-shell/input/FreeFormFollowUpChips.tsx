

import { AnimatePresence, motion } from 'motion/react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui';

import { type FollowUpInputItem } from "./free-form-input-contracts";
import { formatFollowUpChipText } from "./free-form-input-helpers";

interface FreeFormFollowUpChipsProps {
  followUpItems: FollowUpInputItem[]
  animateFollowUpLayout: boolean
  t: import("i18next").TFunction<"translation", undefined>
  onFollowUpClick: ((item: FollowUpInputItem, anchor?: { x: number; y: number; }) => void) | undefined
  onFollowUpIndexClick: ((item: FollowUpInputItem) => void) | undefined
}

export function FreeFormFollowUpChips({
  followUpItems,
  animateFollowUpLayout,
  t,
  onFollowUpClick,
  onFollowUpIndexClick,
}: FreeFormFollowUpChipsProps) {
  return (
<AnimatePresence initial={false}>
          {followUpItems.length > 0 && (
            <motion.div
              key="follow-up-chips"
              layout={animateFollowUpLayout}
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <motion.div layout={animateFollowUpLayout} className="px-3 pt-3.5 pb-0">
                <motion.div layout={animateFollowUpLayout} className="flex flex-wrap gap-1">
                  <AnimatePresence initial={false}>
                    {followUpItems.map((item, idx) => {
                      const chipIndex = item.index ?? idx + 1
                      const tooltipText = item.selectedText.trim() || t('chat.selectedText')
                      const selectedExcerpt = formatFollowUpChipText(item.selectedText, t('chat.selectedText'), 50)
                      const noteExcerpt = formatFollowUpChipText(item.noteLabel, t('chat.followUp'), 50)

                      return (
                        <motion.button
                          key={item.id}
                          type="button"
                          layout={animateFollowUpLayout}
                          initial={{ opacity: 0, y: 6, scale: 0.98 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -4, scale: 0.98 }}
                          transition={{ duration: 0.16, ease: [0.2, 0, 0.2, 1] }}
                          className="inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-[6px] bg-foreground/2 pl-1.5 pr-2 py-1 text-[13px] text-foreground/80 select-none transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect()
                            onFollowUpClick?.(item, {
                              x: rect.left + rect.width / 2,
                              y: rect.top - 8,
                            })
                          }}
                        >
                          <Tooltip delayDuration={250}>
                            <TooltipTrigger asChild>
                              <span
                                role="button"
                                tabIndex={0}
                                className="inline-flex h-4 min-w-4 cursor-pointer items-center justify-center rounded-[4px] bg-background px-0.5 text-[10px] font-medium text-foreground shadow-minimal focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                                onMouseDown={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }}
                                onClick={(event) => {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  onFollowUpIndexClick?.(item)
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    onFollowUpIndexClick?.(item)
                                  }
                                }}
                              >
                                {chipIndex}
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-[420px] break-words text-xs">
                              {tooltipText}
                            </TooltipContent>
                          </Tooltip>
                          <span className="min-w-0 max-w-full overflow-hidden text-ellipsis whitespace-nowrap pr-0.5 text-left">
                            <span className="italic text-foreground/60">{selectedExcerpt}</span>
                            <span className="mx-1 text-foreground/40">·</span>
                            <span>{noteExcerpt}</span>
                          </span>
                        </motion.button>
                      )
                    })}
                  </AnimatePresence>
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
  )
}
