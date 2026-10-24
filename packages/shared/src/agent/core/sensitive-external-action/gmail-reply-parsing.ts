import { gmailBodyEnvelopeSpans } from './gmail-body-envelopes.ts';
import { requestClauses } from './request-authorization.ts';
import { isTargetFreeGenericContinuation } from './structured-gmail-send.ts';
import { normalizeForMatch } from './target-syntax.ts';

export const LEGACY_CONTEXTUAL_GMAIL_REPLY_TOOL = 'mcp__google-contacts__gmail_reply';

export const CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_TOOL = 'mcp__google-contacts__gmail_reply_preflight';

export const CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_TOOL = 'mcp__google-contacts__gmail_reply_all_preflight';

export const CONTEXTUAL_GMAIL_REPLY_TOOL = 'mcp__google-contacts__gmail_reply_bound';

export const CONTEXTUAL_GMAIL_REPLY_ALL_TOOL = 'mcp__google-contacts__gmail_reply_all';

export const CONTEXTUAL_GMAIL_SEND_TOOL = 'mcp__google-contacts__gmail_send';

export const GMAIL_MESSAGE_ID = /^[0-9a-f]{12,32}$/iu;

const CONTEXTUAL_GMAIL_REPLY_KEYS = new Set([
  'messageId', 'expectedRecipientEmail', 'expectedSenderEmail', 'recipientBinding', 'body', 'isHtml',
  '_displayName', '_intent',
]);

const CONTEXTUAL_GMAIL_REPLY_ALL_KEYS = new Set([
  'messageId', 'expectedSenderEmail', 'recipientBinding', 'body', 'isHtml', '_displayName', '_intent',
]);

export const CONTEXTUAL_GMAIL_REPLY_PREFLIGHT_KEYS = new Set([
  'messageId', 'expectedRecipientEmail', 'expectedSenderEmail', 'body', 'isHtml', '_displayName', '_intent',
]);

export const CONTEXTUAL_GMAIL_REPLY_ALL_PREFLIGHT_KEYS = new Set([
  'messageId', 'expectedSenderEmail', 'body', 'isHtml', '_displayName', '_intent',
]);

export const CONTEXTUAL_REPLY_VERB = /\b(?:reply|respond|answer|write\s+back|repond|reponds|repondez|repondre)\b|\bfais(?:\s+(?:lui|leur))?\s+un\s+retour\b|\beffectue(?:r|s|z)?\s+(?:(?:une?|la)\s+)?(?:unique\s+)?(?:reponse|envoi)\s+(?:(?:via|par)\s+)?(?:l\s+)?(?:api|gmail)\b/u;

export const CONTEXTUAL_REPLY_PREPARATION = /\b(?:prepare|prepares|preparer|redige|rediger|draft|compose|composes|composer|write)\b[^.!?;\n]{0,60}\b(?:reply|response|reponse)\b/u;

export const CONTEXTUAL_SEND_VERB = /\b(?:send|envoi|envoie|envoyer|transmets|transmettre)\b/u;

export const CONTEXTUAL_REPLY_PRONOUN = /\b(?:reply|respond|answer|write\s+back)\s+(?:back\s+)?(?:to\s+)?(?:all|everyone|them|him|her|this\s+(?:email|message)|that\s+(?:email|message)|the\s+(?:email|message|sender))\b|\b(?:repond|reponds|repondez|repondre)\s+(?:a\s+)?(?:tous|toutes|leur|lui|ce\s+(?:mail|courriel|message)|cet\s+email|l\s+(?:email|courriel)|au\s+(?:mail|courriel|message))\b|\bfais\s+(?:lui|leur)\s+un\s+retour\b/u;

export const CONTEXTUAL_REPLY_THREAD = /\b(?:(?:dans|sur)\s+(?:(?:ce|le)\s+)?(?:meme\s+)?fil(?:\s+(?:existant|actuel|original|d\s+origine))?|(?:in|on)\s+(?:(?:this|the)\s+)?(?:(?:same|existing|current|original)\s+)?thread|same\s+recipients?|existing\s+recipients?|sans\s+(?:modifier|changer|alterer)\s+(?:les\s+)?destinataires|without\s+(?:changing|modifying|altering)\s+(?:the\s+)?recipients?)\b/u;

export const CONTEXTUAL_REPLY_ALL_SCOPE = /\b(?:reply\s+all|reply\s+to\s+(?:all\b(?!\s+(?:(?:the|its|their)\s+)?(?:questions?|points?|arguments?|items?|topics?|comments?|concerns?|requests?|remarks?|objections?|demands?))|everyone|them|each\s+recipient|every\s+recipient|the\s+whole\s+list)|respond\s+to\s+(?:all\b(?!\s+(?:(?:the|its|their)\s+)?(?:questions?|points?|arguments?|items?|topics?|comments?|concerns?|requests?|remarks?|objections?|demands?))|everyone|them|each\s+recipient|every\s+recipient|the\s+whole\s+list)|answer\s+everyone|repond(?:s|ez|re)?\s+(?:a\s+)?(?:tous\b(?!\s+(?:(?:les|ses|leurs?)\s+)?(?:points?|questions?|arguments?|sujets?|elements?|commentaires?|demandes?|requetes?|soucis?|remarques?|objections?))|toutes\b(?!\s+(?:(?:les|ses|leurs?)\s+)?(?:questions?|remarques?|objections?|demandes?|requetes?|preoccupations?))|leur|chacun|tout\s+le\s+monde|l\s+ensemble\s+des\s+destinataires|toute\s+la\s+liste)|sans\s+(?:modifier|changer|alterer)\s+(?:les\s+)?destinataires|without\s+(?:changing|modifying|altering)\s+(?:the\s+)?recipients?|ne\s+(?:modifie|change)\s+pas\s+(?:les\s+)?destinataires|ne\s+retire\s+aucun\s+destinataire)\b/u;

export const CONTEXTUAL_REPLY_NEGATION = /\b(?:do\s+not|don\s+t|never|must\s+not)\s+(?:reply|respond|send)\b|\bi\s+don\s+t\s+want\s+you\s+to\s+(?:reply|respond|send)\b|\byou\s+shouldn\s+t\s+(?:reply|respond|send)\b|\bno\s+(?:reply|response)\s+should\s+be\s+sent\b|\b(?:merci\s+de\s+)?ne\s+pas\s+(?:repondre|envoyer)\b|\b(?:ne|n)\s+(?:repond|reponds|repondez|repondre|envoie|envoyer)\b[^.!?;\n]{0,80}\b(?:pas|jamais|plus)\b|\bn\s+envoie\b[^.!?;\n]{0,30}\baucune?\s+(?:reponse|message|mail|email)\b|\bne\s+(?:surtout\s+)?jamais\s+(?:repondre|envoyer)\b|\bil\s+ne\s+faut\b[^.!?;\n]{0,50}\b(?:pas|jamais)\b[^.!?;\n]{0,40}\b(?:repondre|envoyer)\b|\b(?:repondre|envoyer)\b[^.!?;\n]{0,50}\b(?:est|reste)\s+interdit\b|\bje\s+ne\s+te\s+demande\s+pas\s+de\s+(?:repondre|envoyer)\b|\b(?:je\s+t\s+interdis|hors\s+de\s+question)\b[^.!?;\n]{0,50}\b(?:repondre|envoyer)\b|\b(?:evite|evitez|abstiens\s+toi|abstenez\s+vous)\s+(?:d\s+y|de)\s+(?:repondre|envoyer)\b|\b(?:tu|vous)\s+n\s+(?:es|etes)\s+pas\s+autorise(?:e|es|s)?\s+a\s+(?:repondre|envoyer)\b|\btu\s+ne\s+dois\s+en\s+aucun\s+cas\s+(?:repondre|envoyer)\b|\b(?:you\s+are\s+not\s+allowed|i\s+refuse\s+to\s+let\s+you)\s+(?:to\s+)?(?:reply|respond|send)\b|\b(?:sans\s+repondre|without\s+(?:replying|responding))\b/u;

export const CONTEXTUAL_REPLY_EXPLICIT_RETARGET = /\b(?:reply|respond|repond|reponds|repondez|repondre)\b[^.!?;\n]{0,100}\b(?:instead|plutot|rather)\b|\b(?:change|replace|remplace|modifie)\b[^.!?;\n]{0,80}\b(?:recipient|recipients|destinataire|destinataires)\b|\b(?:finalement|actually)\b[^.!?;\n]{0,40}\b(?:transfere|transferer|forward)\b[^.!?;\n]{0,40}(?:\binstead\b)?/u;

export const CONTEXTUAL_REPLY_THREAD_REJECTION = /\b(?:pas|not)\b[^.!?;\n]{0,35}\b(?:(?:dans|sur)\s+(?:ce|le)?\s*(?:meme\s+)?fil|(?:in|on)\s+(?:this|the)?\s*(?:same\s+)?thread)\b|\b(?:dans|sur|in|on)\s+(?:un|une|a|another|other)?\s*(?:nouveau|nouvelle|new|autre|another|other)\s+(?:fil|thread|mail|email|message)\b|\b(?:ne|n)\s+(?:repond|reponds|repondez|repondre|envoie|envoyer)\b[^.!?;\n]{0,50}\brien\b|\b(?:reply|respond|send)\s+nothing\b/u;

const CONTEXTUAL_GMAIL_INLINE_REPLY_TO_FIELD = /`replyTo`/giu;

export const CONTEXTUAL_REPLY_CONFIRMATION_BOUNDARY = /\b(?:only\s+)?(?:after|apres)\s+(?:(?:my|ma|mon|notre|the|la|le)\s+)?(?:confirmation|approval|autorisation|validation|accord|feu vert)\b|\b(?:apres\s+obtention\s+de|upon\s+obtaining)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:accord|approval|autorisation|authorization)\b|\b(?:pas\s+avant|not\s+before)\s+(?:(?:my|ma|mon|notre|the|la|le)\s+)?(?:confirmation|approval|autorisation|validation|accord|feu vert)\b|\b(?:pas\s+sans|not\s+without|pending)\s+(?:(?:my|ma|mon|notre|our)\s+)?(?:confirmation|approval|autorisation|validation|accord|feu\s+vert)\b|\b(?:sous\s+(?:reserve|condition)\s+(?:de|que)|subject\s+to|conditional\s+on)\b[^.!?;\n]{0,70}\b(?:confirmation|approval|approving|autorisation|validation|accord|feu\s+vert|valid)\w*\b|\b(?:des|avec)\s+(?:(?:mon|ma|notre)\s+)?(?:accord|feu\s+vert)\s+(?:uniquement|seulement)?\b|\b(?:confirmation|approval|autorisation|validation|accord|feu vert)\s+(?:required|requis|requise|necessaire)\b|\b(?:demande(?:-moi)?|ask\s+me)\b[^.!?;\n]{0,50}\b(?:confirmation|approval|autorisation|validation|accord|feu vert)\b|\b(?:(?:une\s+fois\s+que|apres\s+que|lorsque|quand|once|when)|(?:(?:uniquement|seulement)\s+)?si|only\s+if|unless|a\s+condition\s+que|pourvu\s+que|provided\s+that|as\s+soon\s+as)\s+(?:je|nous|i|we|tu|vous|you)\b[^.!?;\n]{0,90}\b(?:valid(?:e|er)?|confirm(?:e|er)?|approv(?:e|al)|autoris(?:e|ation)|accord|oppose|recois|receiv|get|have|dis\s+oui|say\s+yes|feu\s+vert|go\s+ahead)\b|\b(?:uniquement|seulement|only)\s+(?:avec|with)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:autorisation|authorization|approval|accord|feu\s+vert)(?:\s+explicite|\s+explicit)?\b|\b(?:avec|with)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:autorisation|authorization|approval|accord|feu\s+vert)\s+(?:uniquement|seulement|only)\b|\b(?:apres|upon)\s+(?:la\s+|reception\s+de\s+|receiving\s+)?(?:(?:mon|ma|notre|my|our)\s+)?(?:accord|approval|autorisation|authorization|feu\s+vert)\b|\b(?:une\s+fois|once)\s+(?:(?:mon|ma|notre|my|our)\s+)?(?:accord|approval|autorisation|authorization)\s+(?:recu|received)\b|\ben\s+attendant\s+(?:(?:mon|ma|notre|le)\s+)?(?:accord|validation|confirmation|autorisation|feu\s+vert)\b/u;

export const CONTEXTUAL_REPLY_AUDIENCE_CHANGE = /\b(?:sauf|hormis|except|excepte|excluding|other\s+than)\b|\ba\s+(?:l\s+exception\s+de|part)\b|\b(?:omit|en\s+retirant|sans\s+inclure|leaving)\b[^.!?;\n]{0,80}(?:\bout\b|[a-z0-9@._+-]+)|\b(?:uniquement|seulement|only)\s+(?:a|to)\s+[a-z0-9@._+-]+\b|\b(?:exclude|exclure|exclus|exclue|retire|retirer|remove|ajoute|ajouter|add|include|inclure)\s+[a-z0-9@._+-]+\b|\b(?:exclude|exclure|exclus|retire|retirer|remove|ajoute|ajouter|add|include|inclure)\b[^.!?;\n]{0,100}\b(?:cc|copie|recipient|recipients|destinataire|destinataires|audience)\b|\b(?:mets?|mettre|copie|copier|copiant|sans\s+(?:mettre|copier)|avec)\b[^.!?;\n]{0,100}\b(?:cc|en\s+copie)\b|\b(?:conserv(?:e|er|ant)|garde|garder|keep)\b[^.!?;\n]{0,70}\b(?:uniquement|seulement|only)\b|\b(?:mais|but)\s+(?:pas|sans|without|enleve|oublie|drop|leave|retire|exclue?)\b[^.!?;\n]{0,40}\b[a-z0-9@._+-]+\b|\b(?:leave\s+[a-z0-9@._+-]+\s+off|drop\s+[a-z0-9@._+-]+|minus\s+[a-z0-9@._+-]+|just\s+not\s+[a-z0-9@._+-]+|enleve\s+[a-z0-9@._+-]+|moins\s+(?!tard\b)[a-z0-9@._+-]+|oublie\s+[a-z0-9@._+-]+|en\s+omettant\s+[a-z0-9@._+-]+)\b|\b(?:including|along\s+with|y\s+compris|en\s+incluant|ajoute|plus(?!\s+tard\b)|and\s+copy|et\s+copie)\s+[a-z0-9@._+-]+\b|\bavec\s+[a-z0-9@._+-]+\s+aussi\b|\b(?:separement|separately|individually|hors\s+de\s+ce\s+fil|outside\s+(?:this|the)\s+thread|par\s+(?:un|une)\s+(?:nouveau|nouvelle)\s+(?:mail|email|message))\b/u;

export const CONTEXTUAL_REPLY_NAMED_AUDIENCE_CHANGE = /\b(?:keep\s+[a-z0-9@._+-]+\s+out|without\s+[a-z0-9@._+-]+\s+copied|with\s+[a-z0-9@._+-]+\s+copied|put\s+[a-z0-9@._+-]+\s+on\s+(?:cc|bcc)|(?:cc|bcc)\s+[a-z0-9@._+-]+|sans\s+[a-z0-9@._+-]+\s+en\s+copie|mets?\s+[a-z0-9@._+-]+\s+parmi\s+les\s+destinataires|[a-z0-9@._+-]+\s+(?:en\s+copie|cc|bcc))\b/u;

export const CONTEXTUAL_REPLY_EXPLICIT_NO_AUDIENCE_CHANGE = /\b(?:ne\s+(?:modifie|change|altere)\s+pas\s+(?:les\s+)?destinataires|ne\s+(?:retire|supprime|exclus)\s+aucun\s+destinataire|sans\s+inclure\s+de\s+nouveau\s+destinataire|do\s+not\s+(?:change|modify|alter|remove|exclude)\s+(?:the\s+|any\s+)?recipients?|leaving\s+(?:the\s+)?recipients?\s+unchanged|without\s+(?:including|adding)\s+any\s+new\s+recipient|omitting\s+no\s+recipients?)\b/gu;

export const CONTEXTUAL_REPLY_NON_AUDIENCE_CONSTRAINT = /\b(?:(?:leaving|keeping|keep|leave|garde|garder|laisse|laisser)\s+(?:the\s+|le\s+|la\s+|l\s+)?(?:subject|wording|body|content|objet|formulation|contenu|texte)\s+(?:unchanged|identical|inchange|inchangee|identique)|(?:excluding|without\s+including|sans\s+inclure|en\s+excluant)\s+(?:any\s+|the\s+|de\s+|des\s+)?(?:attachments?|pieces?\s+jointes?|files?|fichiers?)|(?:avec|with)\s+(?:exactement\s+)?(?:les\s+)?(?:memes?|same)\s+(?:fil|thread)\b[^.!?;\n]{0,180}\b(?:corps|body)\b[^.!?;\n]{0,100})\b/gu;

export const CONTEXTUAL_REPLY_DUPLICATE_CHECK = /\b(?:exclude|exclure)\s+(?:tout\s+|any\s+)?(?:envoi|email|e\s+mail|mail|message|send)\s+(?:deja\s+|already\s+)?(?:effectue|envoye|produit|sent|made)\b/gu;

export const CONTEXTUAL_REPLY_SIGNED_PREFLIGHT_FIELDS = /\bavec\s+exactement\s+(?:le\s+)?jeton\s+(?:le\s+)?destinataire\s+(?:les\s+)?cc\s+(?:le\s+)?fil\s+et\s+(?:le\s+)?corps\s+lies?\s+par\s+ce\s+preflight\b/gu;

const CONTEXTUAL_REPLY_IDEMPOTENT_SEND_CONDITION = /\b(?:s\s+il\s+n\s+est\s+pas\s+deja\s+envoye|(?:(?:seulement|uniquement)\s+)?s\s+il\s+est\s+absent|only\s+if\s+(?:(?:it|the\s+(?:exact\s+)?effect|the\s+(?:reply|message|send))\s+is\s+)?absent|if\s+(?:it|the\s+(?:exact\s+)?effect|the\s+(?:reply|message|send))\s+is\s+not\s+already\s+(?:present|sent))\b/gu;

const CONTEXTUAL_REPLY_POSITIVE_EXISTENCE_NO_RESEND = /\b(?:(?:aucun|pas\s+de)\s+(?:second|nouvel|autre)\s+(?:envoi|message|email|mail)|ne\s+(?:renvoie|reponds|envoie)\s+pas|do\s+not\s+(?:resend|reply|send)|no\s+(?:second|new|other)\s+(?:send|reply|message|email)|reuse\s+(?:the\s+)?existing\s+(?:effect|message))\b[^.!?;\n]{0,120}\b(?:si|if)\s+(?:(?:l\s+)?effet\s+exact|the\s+exact\s+effect)\s+(?:apparait|existe|est\s+present|appears|exists|is\s+present)\b/u;

export const CONTEXTUAL_REPLY_EXACT_EFFECT_CONTINUATION = /\b(?:verifie(?:z)?\s+(?:d\s+abord\s+)?(?:l\s+)?absence|check\s+(?:first\s+)?(?:that\s+)?(?:the\s+)?(?:exact\s+)?effect\s+is\s+absent)\b[^.!?;\n]{0,180}\b(?:seulement\s+s\s+il\s+est\s+absent|only\s+if\s+(?:(?:it|the\s+(?:exact\s+)?effect)\s+is\s+)?absent)\b[^.!?;\n]{0,120}\b(?:effectue(?:r|s|z)?\s+(?:(?:une?|la)\s+)?(?:unique\s+)?(?:reponse|envoi)\s+(?:(?:via|par)\s+)?(?:l\s+)?(?:api|gmail)|perform\s+(?:(?:one|a|single)\s+)?(?:api|gmail)\s+(?:reply|response|send))\b/u;

// This is deliberately a closed continuation grammar, not standalone send
// authority. It refers back to an exact effect already authorized in the
// authenticated history and requires the current segment to carry one anchor.
export const CONTEXTUAL_REPLY_CONCLUSIVE_ABSENCE_CONTINUATION = /\bseulement\s+si\s+l\s+absence\s+exacte\s+est\s+concluante\b[^.!?;\n]{0,200}\bexecute\s+(?:au\s+plus\s+)?une\s+unique\s+reponse\s+liee\s+a\s+(?:l|cette)\s+ancre\b/u;

export const CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD = /\b(?:payload\s+(?:obligatoire\s+et\s+immuable|required\s+and\s+immutable)|required\s+and\s+immutable\s+payload)\b/iu;

// Structured restart prompts use literal tool names and a closed immutable
// payload instead of the shorter natural-language continuation above. Keep
// this grammar narrow: it must require the canonical preflight, both Gmail
// reconciliation scopes, the zero-candidate result, and the bound reply tool.
export const CONTEXTUAL_REPLY_STRUCTURED_EXACT_EFFECT_CONTINUATION = /\b(?:avant\s+toute\s+mutation|before\s+any\s+mutation)\b.{0,1200}\bgmail\s+reply\s+preflight\b.{0,1800}\bsent\b.{0,500}\bdraft\b.{0,900}\bcandidate\s+count\s+0\b.{0,1200}\b(?:seulement\s+si\s+toutes\s+ces\s+conditions\s+sont\s+satisfaites|only\s+if\s+all\s+(?:of\s+)?these\s+conditions\s+are\s+satisfied)\b.{0,800}\bgmail\s+reply\s+bound\b/u;

// The negative half of that same exact-once branch is a safety condition, not
// a revocation: no send is permitted when a duplicate may exist or pagination
// makes the read ambiguous. Keep this narrow so an unconditional "n'envoie
// rien" continues to revoke authority.
export const CONTEXTUAL_REPLY_DUPLICATE_AMBIGUITY_NO_SEND = /^(?:si\s+un\s+envoi(?:\s+ou\s+un\s+brouillon)?\s+identique\s+existe\s+peut\s+exister\s+ou\s+si\s+la\s+pagination\s+la\s+lecture\s+reste\s+ambigue\s+n\s+envoie\s+rien(?:\s+et\s+cloture\s+sur\s+cette\s+preuve)?|si\s+un\s+candidat\s+une\s+ambiguite\s+ou\s+une\s+preuve\s+incomplete\s+apparait\s+n\s+envoie\s+rien\s+et\s+cloture\s+factuellement|if\s+a\s+candidate\s+an\s+ambiguity\s+or\s+incomplete\s+evidence\s+appears\s+do\s+not\s+send\s+anything\s+and\s+close\s+factually)$/u;

export const CONTEXTUAL_REPLY_STRUCTURED_BOUND_EXECUTION = /^(?:seulement\s+si\s+toutes\s+ces\s+conditions\s+sont\s+satisfaites\s+utilise\s+immediatement\s+le\s+recipient\s+binding\s+frais\s+dans\s+au\s+plus\s+un(?:e)?\s+unique\s+gmail\s+reply\s+bound\s+au\s+payload\s+strictement\s+identique|only\s+if\s+all(?:\s+of)?\s+these\s+conditions\s+are\s+satisfied\s+immediately\s+use\s+the\s+fresh\s+recipient\s+binding\s+in\s+at\s+most\s+one\s+gmail\s+reply\s+bound(?:\s+call)?\s+with\s+the\s+strictly\s+identical\s+payload)$/u;

export const CONTEXTUAL_REPLY_STRUCTURED_RECONCILIATION = /^(?:continue\s+uniquement\s+si\b(?=[\s\S]{0,900}\breconciliation\s+sent\s+et\s+draft\b)(?=[\s\S]{0,900}\b(?:entierement\s+)?paginee\b)(?=[\s\S]{0,900}\bcandidate\s+count\s+0\b)|continue\s+only\s+if\b(?=[\s\S]{0,900}\bsent\s+and\s+draft\s+reconciliation\b)(?=[\s\S]{0,900}\bfully\s+paginated\b)(?=[\s\S]{0,900}\bcandidate\s+count\s+0\b))[\s\S]{1,900}$/u;

export const CONTEXTUAL_REPLY_STRUCTURED_UNCERTAIN_RESULT = /^(?:ne\s+repete\s+jamais\s+l\s+effet\s+si\s+le\s+resultat\s+de\s+l\s+appel\s+est\s+incertain\s+reconcilie\s+sent\s+et\s+draft\s+avant\s+toute\s+decision|never\s+repeat\s+the\s+effect\s+if\s+the\s+call\s+result\s+is\s+uncertain\s+reconcile\s+sent\s+and\s+draft\s+before\s+any\s+decision)$/u;

export const CONTEXTUAL_REPLY_SENT_DRAFTS_RECONCILIATION = /^(?:reconcilie\s+d\s+abord\s+par\s+api\s+l\s+ancre\s+[0-9a-f]{12,32}\s+ainsi\s+que\s+sent\s+et\s+drafts\s+avec\s+comparaison\s+exacte\s+complete\s+de\s+l\s+effet\s+autorise\s+dans\s+ce\s+chat|reconcilie\s+d\s+abord\s+par\s+api\s+l\s+ancre\s+[0-9a-f]{12,32}\s+et\s+le\s+fil\s+complet\s+dans\s+sent\s+et\s+drafts\s+avec\s+pagination\s+complete\s+et\s+comparaison\s+exacte\s+de\s+l\s+effet\s+autorise\s+dans\s+ce\s+chat)$/u;

export const CONTEXTUAL_REPLY_NAMED_AUDIENCE_REMOVAL = /\b(?:(?:do\s+not|don\s+t)\s+copy\s+[a-z0-9@._+-]+|take\s+[a-z0-9@._+-]+\s+off\s+(?:the\s+)?(?:thread|recipients?|cc)|ne\s+copie\s+pas\s+[a-z0-9@._+-]+|(?:passe|deplace)\s+[a-z0-9@._+-]+\s+en\s+(?:cci|bcc))\b/u;

export const CONTEXTUAL_REPLY_NO_SEND_BOUNDARY = /\b(?:brouillons?|drafts?|(?:garde|garder|laisse|laisser)\b[^.!?;\n]{0,30}\bdans\s+(?:les\s+)?brouillons?|sans\s+(?:(?:l|la|le)(?:['’]\s*|\s+))?(?:envoyer|envoi|transmettre|expedier|soumettre|passer\s+a\s+l\s+envoi)|without\s+(?:sending|send|transmitting|submitting|dispatch)|(?:ne|sans)\s+(?:clique(?:r)?|appuie|click(?:ing)?|press|hit)\b[^.!?;\n]{0,45}\b(?:envoyer|send|bouton\s+d\s+envoi|send\s+button)|(?:merci\s+de\s+)?ne\s+pas\s+(?:envoyer|transmettre|expedier|soumettre|livrer|deliver|valider\s+l\s+envoi|declencher\s+l\s+envoi|finaliser\s+l\s+envoi)|(?:make\s+sure\s+not\s+to|refrain\s+from|avoid)\s+(?:send(?:ing)?|deliver(?:ing)?|submit(?:ting)?|transmit(?:ting)?)|do\s+not\s+(?:actually\s+send|send|deliver|submit|transmit|click\s+(?:the\s+)?send(?:\s+button)?|finalize\s+the\s+send|trigger\s+delivery)(?:\s+it)?(?:\s+yet)?|don\s+t\s+(?:send|deliver|submit|transmit|hit\s+(?:the\s+)?send(?:\s+button)?|go\s+through\s+with\s+sending)(?:\s+it)?|ne\s+(?:(?:l|la|le)(?:['’]\s*|\s+))?(?:envoie|envoies|envoyez|envoyer|transmets|transmettez|transmettre|expedie|expedies|expediez|expedier|soumets|soumettre|declenche|finalise)\s+pas(?:\s+encore)?|ne\s+clique\s+pas\b[^.!?;\n]{0,35}\bbouton\s+d\s+envoi\b|ne\s+(?:le|la)\s+fais\s+pas\s+partir|je\s+ne\s+veux\s+aucun\s+envoi|(?:je\s+veux\s+relire|let\s+me\s+review(?:\s+it)?)\b[^.!?;\n]{0,40}\b(?:avant\s+l\s+envoi|before\s+sending)|(?:pour\s+(?:ma\s+)?(?:relecture|validation)\s+(?:uniquement|seulement)|for\s+my\s+review\s+only|not\s+for\s+sending)|(?:retiens?|bloque|hold|mets?)\b[^.!?;\n]{0,30}\b(?:l\s+envoi|attente\s+d\s+envoi|email|mail)|save\s+it\s+without\s+dispatch|(?:ne\s+)?procede\s+pas\s+a\s+(?:l\s+)?envoi|sans\s+proceder\s+a\s+(?:l\s+)?envoi|ne\s+fais\s+pas\s+partir\s+(?:le|la|l)\s+(?:mail|email|courriel|message)|(?:laisse\s+moi\s+(?:l\s+envoyer|faire\s+partir\s+(?:le|la|l)\s+(?:mail|email|courriel|message))|je\s+ferai\s+l\s+envoi\s+moi\s+meme|leave\s+the\s+final\s+send\s+to\s+me|i\s+will\s+send\s+it\s+myself|stop\s+short\s+of\s+sending)|(?:garde|keep|leave)\b[^.!?;\n]{0,30}\b(?:non\s+envoyee|unsent))\b/u;

export const CONTEXTUAL_REPLY_REPORTED_SPEECH = /\b(?:report|rapport|document|message|email|mail|note)\b[^.!?;\n]{0,100}\b(?:recommends?|recommendation|recommande|suggests?|suggere|says?|states?|dit|indique|asks?|demande)\b[^.!?;\n]{0,45}\b(?:to\s+)?(?:reply|respond|answer|send|de\s+(?:repondre|envoyer))\b|\b(?:m\s+a|nous\s+a|a)\s+demande\s+de\s+repondre\b/u;

export const CONTEXTUAL_REPLY_META_INSTRUCTION = /\b(?:(?:voici|here\s+is|this\s+is|ci\s+dessous|below)\b[^.!?;\n]{0,80}\b(?:exemple|example|sample|modele|template|prompt|citation|quote)\b|(?:exemple|example|sample|modele|template|copie|copy)\s+(?:(?:de|d\s+un|du|of|for)\s+)?(?:prompt|instruction|request|demande|texte|text)\b|(?:citation|quote)\b|(?:texte\s+cite|quoted\s+text)\b|(?:prompt|instruction|texte|text)\s+(?:(?:contient|contains?|cite|quotes?)|(?:a\s+tester|to\s+test|a\s+analyser|to\s+analy[sz]e|non\s+executee?|not\s+executed))\b|(?:documentation|document|reference)\b[^.!?;\n]{0,80}\b(?:contient|contains?|cite|quotes?)\b[^.!?;\n]{0,50}\b(?:instruction|prompt|request|demande)\b|(?:supposons|suppose|imagine)\b[^.!?;\n]{0,60}\b(?:instruction|prompt|request|demande)\b|(?:je\s+veux\s+que\s+tu|i\s+want\s+you\s+to)\s+(?:analyses?|audites?|review|analy[sz]e)\b[^.!?;\n]{0,60}\b(?:prompt|instruction|texte|text)\b|(?:a\s+titre\s+d\s+exemple|pour\s+reference(?:\s+uniquement)?|for\s+reference(?:\s+only)?|hypothetical(?:ly)?|hypothetique(?:ment)?|sans\s+l\s+executer|do\s+not\s+execute|instruction\s+non\s+executee?|not\s+an\s+instruction))\b/u;

const CONTEXTUAL_REPLY_UNSATISFIED_CONDITION = /\b(?:once|when|if|provided(?:\s+that)?|as\s+soon\s+as|unless|une\s+fois\s+que|lorsque|quand|si|des\s+que|a\s+condition\s+que|pourvu\s+que)\b[^.!?;\n]{1,100}/u;

export const CONTEXTUAL_REPLY_NON_DIRECTIVE = /\b(?:je\s+pense\s+qu\s+il\s+faudrait|il\s+faudrait|on\s+devrait|on\s+pourrait|tu\s+pourrais|tu\s+peux\s+peut\s+etre|peut\s+etre)\b[^.!?;\n]{0,60}\brepondre\b/u;

export const CONTEXTUAL_REPLY_REPLACED_BY_READ_ONLY = /\b(?:(?:finalement|en\s+fait|actually)\b[^.!?;\n]{0,70}(?:(?:seulement|juste?|only)\b[^.!?;\n]{0,35}\b(?:analyse|analyze|resume|resumer|summary|summarize)|(?:analyse|analyze|resume|resumer|summary|summarize)\b[^.!?;\n]{0,35}\b(?:seulement|juste?|only))|(?:seulement|juste?|only)\s+(?:a\s+|un\s+)?(?:resume|summary|analyse|analysis)\b(?:[^.!?;\n]{0,30}\b(?:pas\s+(?:une\s+)?reponse|instead))?|ignore\s+(?:la\s+)?reponse\b[^.!?;\n]{0,40}\b(?:resume|summarize)|(?:analyse|analyze|resume|summary|summarize)\b[^.!?;\n]{0,35}\binstead\b)\b/u;

export const CONTEXTUAL_UNRELATED_ADDITIONAL_SEND = /\b(?:rapport|report|pdf|document|fichier|file|notification\s+slack|slack\s+(?:message|notification))\b/u;

export const CONTEXTUAL_REPLY_DEFERRED_BOUNDARY = /^(?:attends?|patiente|pause|pas\s+encore|stoppe|hold\s+on|wait|pause\s+there|not\s+yet|do\s+not\s+proceed|don\s+t\s+do\s+it\s+yet|i\s+ll\s+tell\s+you\s+when|je\s+te\s+dirai\s+quand|laisse\s+en\s+attente)\.?$|\b(?:pas\s+maintenant|not\s+now|plus\s+tard|later|demain|tomorrow|ce\s+soir|this\s+evening|(?:mais|but)\s+(?:attend(?:s|ez)?|pause)|attend(?:s|ez|re)?\s+pour\s+le\s+moment|wait\s+for\s+now|hold\s+off|attend(?:s|ez|re)?\s+(?:mon|ma|notre|le)\s+(?:accord|validation|confirmation|feu\s+vert)|wait\s+for\s+(?:my|our|the)\s+(?:approval|validation|confirmation|go-ahead)|quand\s+je\s+(?:confirme|valide|te\s+le\s+demanderai|te\s+le\s+dirai)|des\s+que\s+je\s+te\s+le\s+dirai|lorsque\s+je\s+te\s+dirai\s+de\s+le\s+faire|when\s+i\s+(?:confirm|approve|tell\s+you\s+to)|once\s+i\s+tell\s+you\s+to\s+do\s+it|(?:a|on)\s+(?:mon|my)\s+signal|(?:a|at)\s+(?:midi|noon)|(?:apres|after)\s+(?:le\s+)?(?:dejeuner|lunch))\b|\b(?:pas\s+avant|not\s+before|no\s+earlier\s+than|at|a)\s+\d{1,2}(?:(?::|h)\d{0,2})?\s*(?:am|pm|h)?\b|\b(?:dans|in)\s+(?:\d+|une?|one|two|deux|trois|three)\s+(?:heures?|hours?|minutes?)\b|\b(?:(?:pas\s+avant|not\s+before|on)?\s*(?:next\s+)?(?:vendredi|samedi|dimanche|lundi|mardi|mercredi|jeudi|friday|saturday|sunday|monday|tuesday|wednesday|thursday))\b/u;

/** A condition blocks a contextual reply only when it belongs to the same
 * sentence as a reply/send directive. A later, independent style sentence
 * such as "If useful, keep it concise" must not revoke an already explicit
 * send request. */
export function hasContextualReplyUnsatisfiedCondition(rawText: string): boolean {
  return requestClauses(rawText).some(rawClause => {
    // "If it has not already been sent" is an idempotency guard, not a
    // deferred approval or an unknown third-party condition. The connector's
    // signed preflight and exact-once ledger still bind the eventual action.
    const normalizedClause = normalizeForMatch(rawClause);
    if (CONTEXTUAL_REPLY_POSITIVE_EXISTENCE_NO_RESEND.test(normalizedClause)) return false;
    const clause = normalizedClause
      .replace(CONTEXTUAL_REPLY_IDEMPOTENT_SEND_CONDITION, ' ');
    return CONTEXTUAL_REPLY_UNSATISFIED_CONDITION.test(clause)
      && (CONTEXTUAL_REPLY_VERB.test(clause)
        || CONTEXTUAL_SEND_VERB.test(clause)
        || CONTEXTUAL_REPLY_PREPARATION.test(clause));
  });
}

export function isCanonicalContextualGmailReplyInput(
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  const allowedKeys = toolName === CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
    ? CONTEXTUAL_GMAIL_REPLY_ALL_KEYS
    : CONTEXTUAL_GMAIL_REPLY_KEYS;
  if (!(toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
      || toolName === CONTEXTUAL_GMAIL_REPLY_ALL_TOOL)
    || Object.keys(input).some(key => !allowedKeys.has(key))
    || typeof input.messageId !== 'string'
    || !GMAIL_MESSAGE_ID.test(input.messageId.trim())
    || input.messageId !== input.messageId.trim()
    || typeof input.body !== 'string'
    || input.body.trim().length === 0
    || /\0/u.test(input.body)
    || typeof input.recipientBinding !== 'string'
    || !/^v1\.[0-9]{10}\.[0-9a-f]{64}$/iu.test(input.recipientBinding)
    || toolName === CONTEXTUAL_GMAIL_REPLY_TOOL
      && (typeof input.expectedRecipientEmail !== 'string'
        || input.expectedRecipientEmail !== input.expectedRecipientEmail.trim().toLowerCase()
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedRecipientEmail))
    || toolName === CONTEXTUAL_GMAIL_REPLY_ALL_TOOL
      && input.expectedRecipientEmail !== undefined
    || input.expectedSenderEmail !== undefined
      && (typeof input.expectedSenderEmail !== 'string'
        || input.expectedSenderEmail !== input.expectedSenderEmail.trim().toLowerCase()
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(input.expectedSenderEmail))
    || input.isHtml !== undefined && typeof input.isHtml !== 'boolean') return false;
  for (const key of ['_displayName', '_intent'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || /\0/u.test(input[key]))) {
      return false;
    }
  }
  return true;
}

export type ContextualGmailReplyScope = 'reply' | 'reply-all';

export interface ContextualGmailReplyObjective {
  scope: ContextualGmailReplyScope;
  rawRequest: string;
  constraintRequests: readonly string[];
  requiresExactEffectReconciliation: boolean;
}

export function contextualGmailBodyMaskedText(rawRequest: string): string {
  const span = contextualGmailExactBodySpan(rawRequest);
  return span
    ? `${rawRequest.slice(0, span.start)} ${rawRequest.slice(span.end)}`
    : rawRequest;
}

export function contextualGmailRoutingText(rawRequest: string): string {
  // Exact body and subject payloads are data, not control language. Preserve
  // their structural labels for constraint parsing while masking values such
  // as "Reply all", "Do not send", email addresses or hex-like ids.
  const masked = contextualGmailBodyMaskedText(rawRequest)
    // This inline-code identifier documents the connector schema; camel-case
    // normalization must not turn `replyTo` into the instruction "reply to".
    // Natural-language reply/thread directives remain authority-bearing.
    .replace(CONTEXTUAL_GMAIL_INLINE_REPLY_TO_FIELD, '[schema field]')
    .replace(
      /(\b(?:sujet|subject)(?:\s+exact)?\s*(?::|=)?\s*)(?:«[^«»\r\n]{1,998}»|“[^“”\r\n]{1,998}”|"[^"\r\n]{1,998}"|`[^`\r\n]{1,998}`)/giu,
      '$1[exact subject]',
    )
    .replace(
      /(\b(?:sujet|subject)\s+exact\s*(?::|=)\s*)(?![«“"`])([^\r\n]{1,998}?)(?=(?:[ \t]*[.;][ \t]*|[ \t]*\r?\n[ \t]*)(?:(?:corps|body|texte|text|message)\s+exact|exact\s+(?:body|text|message))\b)/giu,
      '$1[exact subject]',
    );
  if (!CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(masked)) {
    return masked;
  }
  // In the closed structured format, the subject line is immutable payload
  // data. Do not let words such as “signature”, “attachments”, “HTML” or “do
  // not send” inside that value become routing/control instructions. The
  // exact-subject parser intentionally reads the unmasked request separately.
  return masked.replace(
    /(^|\r?\n)([ \t]*[-*][ \t]*(?:sujet|subject)[ \t]*:[ \t]*)[^\r\n]{1,998}/giu,
    '$1$2[exact subject]',
  );
}

/** Mask declarations and post-send audit fields from the control-language
 * detectors once a structured immutable payload has been recognized. Those
 * fields still feed the exact constraint parser; they simply must not be
 * mistaken for a second audience change or a request to attach/sign content. */
export function contextualGmailStructuredImmutableControlText(
  rawRequest: string,
  maskPayloadDeclarations = true,
): string {
  const routingText = contextualGmailRoutingText(rawRequest);
  if (!CONTEXTUAL_REPLY_STRUCTURED_IMMUTABLE_PAYLOAD.test(routingText)) {
    return routingText;
  }
  const withoutPayloadDeclarations = maskPayloadDeclarations
    ? routingText.replace(
      /(?:^|\r?\n)[ \t]*[-*][ \t]*(?:from|sender|exp[ée]diteur|to|cc|bcc|cci|sujet|subject|texte\s+brut|plain\s+text|pi[eè]ces?\s+jointes?|attachments?|signature|corps\s+exact|exact\s+body)\b[^\r\n]*/giu,
      '\n',
    )
    : routingText;
  return withoutPayloadDeclarations
    .replace(
      /\b(?:continue\s+uniquement\s+si\b(?=[^.!?\r\n]{0,1200}\br[ée]conciliation\s+sent\s+et\s+draft\b)|continue\s+only\s+if\b(?=[^.!?\r\n]{0,1200}\bsent\s+and\s+draft\s+reconciliation\b))(?=[^.!?\r\n]{0,1200}\b(?:enti[eè]rement\s+pagin[ée]e|fully\s+paginated)\b)(?=[^.!?\r\n]{0,1200}\bcandidate\s*count\b[^0-9\r\n]{0,10}0\b)[^.!?\r\n]{1,1200}/giu,
      ' ',
    )
    .replace(
      /\b(?:apr[èe]s\s+l['’]\s*appel\s*,?\s*v[ée]rifie(?:z)?\s+par\s+api|after\s+the\s+call\s*,?\s*verify\s+via\s+(?:the\s+)?api)\b[^.!?\r\n]{0,700}\b(?:absence\s+de\s+signature|no\s+signature)\b/giu,
      ' ',
    );
}

export function contextualGmailMessageIds(rawRequest: string): string[] {
  const values: string[] = [];
  const routingText = contextualGmailRoutingText(rawRequest);
  for (const match of routingText.matchAll(
    /\b(?:message(?:\s*id)?|messageid|ancre|ancr[ée](?:e)?|anchor(?:ed)?|fil\s+gmail|gmail\s+(?:thread|message))(?=$|\s|[:=#-])(?:\s+(?:exacte?|exact))?\s*(?:sur|on)?\s*(?::|=|#|-)?\s*`?([0-9a-f]{12,32})`?/giu,
  )) {
    if (match[1]) values.push(match[1].toLowerCase());
  }
  return [...new Set(values)];
}

export function contextualGmailTargetEmails(rawRequest: string): string[] {
  const routingText = contextualGmailRoutingText(rawRequest);
  const recipients: string[] = [];
  for (const match of routingText.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu)) {
    const index = match.index ?? 0;
    const rawPrefix = routingText.slice(Math.max(0, index - 220), index);
    const prefix = normalizeForMatch(rawPrefix);
    // The bound reply schema cannot select a sender identity. Do not mistake
    // explicit audit metadata (`Cible exacte: recipient, From sender`) for a
    // second target recipient. Keep a standalone "mail from Alice" address
    // target-bound rather than silently broadening that ordinary instruction.
    const precedingText = routingText.slice(0, index);
    const hasExplicitRecipientMetadata = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText)
      || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText);
    const explicitSenderMetadata = /(?:^|\s)(?:(?:from|sender|exp[ée]diteur(?:\s+exact)?)\s*(?::|=)|(?:depuis|expectedsenderemail)\s*(?::|=)?)\s*`?\s*$/iu.test(rawPrefix);
    if (explicitSenderMetadata || hasExplicitRecipientMetadata
      && /(?:^|\s)(?:from|sender|expediteur)\s*$/u.test(prefix)) continue;
    const explicitRecipientMetadata = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*$/u.test(prefix)
      || /(?:^|[\s,;])to\s*(?::|=)?\s*$/u.test(prefix);
    const directReplyRecipient = /\b(?:reply|respond|answer|write\s+back|send|reponds?|repondez|repondre|envoie|envoyer|transmets?|transmettre)\b[^.!?;\r\n]{0,180}\b(?:to|a|vers|from|de)\s*$/u.test(prefix)
      && !/\b(?:contact|adresse)\s+(?:de\s+)?reference\b[^.!?;\r\n]{0,40}$/u.test(prefix);
    if (!explicitRecipientMetadata && !directReplyRecipient) continue;
    recipients.push(match[0].toLowerCase());
  }
  return [...new Set(recipients)];
}

/** Extract only explicit sender metadata. This is deliberately separate from
 * recipient discovery: a `From` address must never become a reply target, but
 * when the human names it the closed preflight must bind the authenticated
 * Gmail profile to that exact identity before a send can inherit authority. */
export function contextualGmailExpectedSenderEmails(rawRequest: string): string[] {
  const routingText = contextualGmailRoutingText(rawRequest);
  const senders: string[] = [];
  for (const match of routingText.matchAll(
    /(?:^|[.,;\n]|[ \t]+)(from|sender|exp[ée]diteur(?:\s+exact)?|depuis|expectedsenderemail)[ \t]*(:|=)?[ \t]*`?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/giu,
  )) {
    const precedingText = routingText.slice(0, match.index ?? 0);
    const followsExplicitRecipientMetadata = /\b(?:cible\s+exacte|destinataire\s+exact|exact\s+(?:target|recipient))\s*(?::|=)?\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText)
      || /(?:^|[\s,;])to\s*(?::|=)\s*[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(precedingText);
    // Preserve the historical natural-language meaning of "mail from Alice"
    // unless `From:` is explicitly metadata or follows an exact recipient
    // field in the same operational instruction.
    const senderLabel = normalizeForMatch(match[1] ?? '');
    if (match[2] !== undefined || senderLabel === 'depuis'
      || senderLabel === 'expectedsenderemail' || followsExplicitRecipientMetadata) {
      senders.push(match[3]!.toLowerCase());
    }
  }
  return [...new Set(senders)];
}

export function latestContextualGmailMention(objectiveSegments: readonly string[]): string | undefined {
  for (let index = objectiveSegments.length - 1; index >= 0; index -= 1) {
    const rawRequest = objectiveSegments[index] ?? '';
    const normalizedRequest = normalizeForMatch(contextualGmailRoutingText(rawRequest));
    if (!normalizedRequest || isTargetFreeGenericContinuation(normalizedRequest)) continue;
    const namesReply = CONTEXTUAL_REPLY_VERB.test(normalizedRequest);
    const preparesReply = CONTEXTUAL_REPLY_PREPARATION.test(normalizedRequest);
    const namesThreadBoundSend = CONTEXTUAL_SEND_VERB.test(normalizedRequest)
      && CONTEXTUAL_REPLY_THREAD.test(normalizedRequest);
    const namesContextualScope = CONTEXTUAL_REPLY_PRONOUN.test(normalizedRequest)
      || CONTEXTUAL_REPLY_THREAD.test(normalizedRequest)
      || contextualGmailTargetEmails(rawRequest).length > 0
      || contextualGmailMessageIds(rawRequest).length > 0;
    if ((namesReply || namesThreadBoundSend || preparesReply)
      && (namesContextualScope || preparesReply)) return rawRequest;
  }
  return undefined;
}

function contextualGmailExactBodySpan(
  rawRequest: string,
): { body: string; start: number; end: number } | null | undefined {
  const unquotedBodySpan = (
    bodyStart: number,
  ): { body: string; start: number; end: number } | null => {
    const tail = rawRequest.slice(bodyStart);
    const explicitInstructionLine = /(?:^|\r?\n)[ \t]*(?=(?:next\s+instruction\s*:|instruction\s+suivante\s*:|cet\s+envoi\s+exact\s+est\s+d[ée]j[àa]\s+autoris[ée]|this\s+exact\s+send\s+is\s+already\s+authori[sz]ed|s(?:['’]\s*)?il\s+n(?:['’]\s*)?est\s+pas\s+d[ée]j[àa]\s+envoy[ée](?=$|[\s,.;!?])(?=[^\r\n]{0,200}\bpr[ée]flight\b)(?=[^\r\n]{0,260}\b(?:outil|tool|gmail_reply)\b)))/giu;
    const ambiguousInstructionLikeLine = /(?:^|\r?\n)[ \t]*(?=(?:v[ée]rifie(?:z)?\b|(?:puis|ensuite)\s+(?:v[ée]rifie(?:z)?|poursui(?:s|vez)|continue(?:z)?|termine(?:z)?)\b|apr[èe]s\s+(?:l['’]\s*envoi|avoir\s+envoy[ée])(?:$|[\s,.;!?])|then\s+(?:verify|continue|finish|complete)\b|next\s+(?:verify|continue|finish|complete)\b|after\s+sending\b|verify\s+(?:afterwards|next)\b))/giu;
    const boundary = explicitInstructionLine.exec(tail);
    const ambiguousBoundary = ambiguousInstructionLikeLine.exec(tail);
    // An unquoted body containing instruction-shaped prose is ambiguous. Do
    // not silently truncate it and authorize a different payload; require an
    // explicit structural marker (or quoted delimiters) from the human.
    if (ambiguousBoundary && (!boundary || ambiguousBoundary.index < boundary.index)) return null;
    const bodyEnd = boundary ? bodyStart + boundary.index : rawRequest.length;
    const body = rawRequest.slice(bodyStart, bodyEnd).trim();
    return body && body.length <= 4000 ? { body, start: bodyStart, end: bodyEnd } : null;
  };
  // Accept one explicit machine-readable body envelope. Operational recovery
  // prompts use this form so exact content can contain quotes and line breaks
  // without making the following instructions part of the message body.
  const bodyBlocks = gmailBodyEnvelopeSpans(rawRequest);
  if (!bodyBlocks || bodyBlocks.length > 1) return null;
  const bodyBlock = bodyBlocks[0];
  if (bodyBlock) {
    if (!bodyBlock.body.trim() || bodyBlock.body.length > 4000) return null;
    return bodyBlock;
  }
  const exactness = /\b(?:(?:corps|texte|message|body|text)\s+exact|exactement\s+(?:ce|le)\s+(?:corps|texte|message)|exact\s+(?:body|text|message)|exactly\s+(?:this|the)\s+(?:body|text|message))\b/giu;
  const labels = [...rawRequest.matchAll(exactness)];
  if (labels.length > 1) return null;
  const label = labels[0];
  if (label) {
    const tailOffset = label.index + label[0].length;
    const tail = rawRequest.slice(tailOffset);
    const unquotedBlock = /^[ \t]*:[ \t]*\r?\n/u.exec(tail);
    if (unquotedBlock) return unquotedBodySpan(tailOffset + unquotedBlock[0].length);
    const match = /«([\s\S]{1,4000}?)»|“([\s\S]{1,4000}?)”|"([\s\S]{1,4000}?)"/u.exec(tail);
    if (!match) return null;
    if (!/^[\s:=\-–—]*$/u.test(tail.slice(0, match.index))) return null;
    const delimiter = match[0][0];
    const sameLineRemainder = tail
      .slice(match.index + match[0].length)
      .split(/\r?\n/u, 1)[0] ?? '';
    const hasAnotherSameLineDelimiter = delimiter === '«'
      ? /«|»/u.test(sameLineRemainder)
      : delimiter === '“'
        ? /“|”/u.test(sameLineRemainder)
        : /"/u.test(sameLineRemainder);
    // A second delimited value on the exact-body line is ambiguous. Quoted
    // prose on a later instruction line is outside the field and must not make
    // the already closed body unparsable.
    if (hasAnotherSameLineDelimiter) return null;
    const body = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    return body ? {
      body,
      start: tailOffset + match.index,
      end: tailOffset + match.index + match[0].length,
    } : null;
  }

  // Operational prompts often provide the approved payload as a multiline
  // block rather than quoted prose. Recognize only the narrow, imperative
  // `envoie exactement:` / `send exactly:` form followed by a newline. The
  // block ends at the objective-segment boundary or before an unmistakable
  // next-instruction line; broad labels such as `message:` remain unsupported
  // so surrounding instructions cannot silently become email content.
  const blockLabel = /\b(?:envoie|envoyez|send)\s+exactement\s*:[ \t]*(?:\r?\n)/iu.exec(rawRequest)
    ?? /\bsend\s+exactly\s*:[ \t]*(?:\r?\n)/iu.exec(rawRequest);
  if (!blockLabel) return undefined;
  const bodyStart = blockLabel.index + blockLabel[0].length;
  return unquotedBodySpan(bodyStart);
}

export function contextualGmailExactBody(rawRequest: string): string | null | undefined {
  const span = contextualGmailExactBodySpan(rawRequest);
  if (span === null || span === undefined) return span;
  const labelLineStart = rawRequest.lastIndexOf('\n', span.start) + 1;
  const labelLine = normalizeForMatch(rawRequest.slice(labelLineStart, span.start));
  const genericPayloadLabel = /\b(?:texte|message|text)\s+exact\b|\bexact\s+(?:text|message)\b/u.test(labelLine);
  if (genericPayloadLabel
    && /\b(?:slack|sms|teams|whatsapp|notification|rapport|report)\b/u.test(labelLine)
    && !/\b(?:gmail|e\s*mail|email|courriel|reply|reponse|repond)\b/u.test(labelLine)) {
    return undefined;
  }
  return span.body;
}
