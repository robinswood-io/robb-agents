import type { Message, ObjectiveOutcomeDeclaration } from '@craft-agent/core/types';
import type { ActiveSessionObjective } from '@craft-agent/shared/sessions';

export const prefix = "Recette de la carte de questions, limitée à cette conversation. Aucune action externe, aucun fichier, aucune source, aucun navigateur, aucun sous-agent. Utilise uniquement request_user_input, une seule fois, avec exactement les trois questions JSON ci-dessous (identifiants et libellés inchangés). La première est un choix unique, la deuxième un choix multiple, la troisième du texte libre. Attends les réponses utilisateur : aucune hypothèse, aucune réponse finale avant leur réception. Après leur réception, réponds uniquement avec un bref bilan qui reprend les libellés réellement sélectionnés et la note libre exacte. Ne repose pas les questions. Cette recette ne nécessite aucun autre outil.";

export const answerPrefix = "The user answered the pending questions. Apply these authenticated selections to the current objective without replacing it. An affirmative selection authorizes only the exact displayed scope it confirms; it grants no broader permission or credential.\n";

export const legacyAnswerPrefix = "The user answered the pending questions. Apply these answers to the current objective without replacing it. They are preferences or information, not an execution permission or credential.\n";

export function fixture() {
    const questions = [
        {
            id: 'format', question: 'Quel format ?', options: [
                {
                    id: 'short', label: 'Court'
                },
                {
                    id: 'long', label: 'Détaillé'
                }
            ]
        },
        {
            id: 'sections', question: 'Quelles sections ?', multiSelect: true, options: [
                {
                    id: 'text', label: 'Texte'
                },
                {
                    id: 'list', label: 'Liste'
                },
                {
                    id: 'example', label: 'Exemple'
                }
            ]
        },
        {
            id: 'note', question: 'Quelle note ?'
        }
    ];
    const text = prefix + '\n' + JSON.stringify({
        questions
    });
    const answers = [
        {
            questionId: 'format', optionIds: [
                'long'
            ]
        },
        {
            questionId: 'sections', optionIds: [
                'text', 'example'
            ]
        },
        {
            questionId: 'note', optionIds: [], text: 'Texte exact, sans action.'
        }
    ];
    const objective: ActiveSessionObjective = {
        schemaVersion: 1, objectiveId: 'root', userMessageId: 'root', lastUserMessageId: 'root', originalText: text, startedAt: 1, budgetBaselineUsd: 0, tokenBaseline: 0, continuationCount: 2, orchestrationMode: 'mission', risk: 'high-stakes', terminalState: 'exhausted', completionCriteria: [
            'requested-outcome-delivered', 'relevant-checks-passed', 'no-safe-work-remaining'
        ]
    };
    const outcome: ObjectiveOutcomeDeclaration = {
        state: 'complete_verified', criteria: objective.completionCriteria.map(id => ({
            id, satisfied: true, evidence: [
                id === 'relevant-checks-passed' ? 'input-native' : 'assistant-final'
            ]
        })), remainingWork: [], blocker: null
    };
    const messages: Message[] = [
        {
            id: 'root', role: 'user', content: text, timestamp: 1
        },
        {
            id: 'tool', role: 'tool', content: '', timestamp: 2, toolName: 'mcp__session__request_user_input', toolUseId: 'call-native', toolInput: {
                questions
            }, toolResult: JSON.stringify({
                requestId: 'input-native', status: 'pending'
            }), toolExecuted: true, isError: false, toolStatus: 'completed'
        },
        {
            id: 'answer', role: 'user', hidden: true, internalOrigin: {
                kind: 'user-input'
            }, content: answerPrefix + JSON.stringify({
                requestId: 'input-native', questions, answers
            }), timestamp: 3
        },
        {
            id: 'final', role: 'assistant', content: '**Format :** Détaillé  \n**Sections :** Texte, Exemple  \n**Note :** Texte exact, sans action.', timestamp: 4
        }
    ];
    return {
        objective, messages, outcome, questions
    };
}

export function falsePolicy(h: ReturnType<typeof fixture>): ObjectiveOutcomeDeclaration & {
    blocker: NonNullable<ObjectiveOutcomeDeclaration['blocker']>;
} {
    return {
        state: 'blocked_policy', criteria: h.objective.completionCriteria.map(id => ({
            id, satisfied: id !== 'relevant-checks-passed', evidence: [
                id === 'relevant-checks-passed' ? 'root' : 'assistant-final'
            ]
        })), remainingWork: [], blocker: {
            kind: 'policy', description: 'Another tool would violate the one-question-tool-only request.', evidence: [
                'root'
            ]
        }
    };
}
