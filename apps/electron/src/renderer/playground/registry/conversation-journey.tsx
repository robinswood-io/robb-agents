import type { ComponentEntry } from './types'
import { ConversationJourneyPreview, JOURNEY_SCENARIOS } from '../demos/mobile-webui/ConversationJourneyPreview'

export const conversationJourneyComponents: ComponentEntry[] = [{
  id: 'conversation-journey',
  name: 'Conversation Journey',
  category: 'Chat',
  description: 'Production ChatDisplay with confirmed plans, host outcomes, missing finals and permission handoffs. Technical sentinels remain hidden.',
  component: ConversationJourneyPreview,
  layout: 'full',
  previewOverflow: 'hidden',
  props: [
    { name: 'scenario', control: { type: 'select', options: JOURNEY_SCENARIOS }, defaultValue: 'working' },
    { name: 'viewport', control: { type: 'select', options: [{ label: 'Ordinateur', value: 'desktop' }, { label: 'Mobile · 390 px', value: 'mobile' }] }, defaultValue: 'desktop' },
  ],
  variants: JOURNEY_SCENARIOS.map(item => ({ name: item.label, props: { scenario: item.value } })),
}]
