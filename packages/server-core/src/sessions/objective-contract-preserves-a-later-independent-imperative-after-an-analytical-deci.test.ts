import { describe, expect, it } from "bun:test";
import type { Message } from "@craft-agent/core/types";
import { buildObjectiveContractPrompt, hasObjectiveExecutionEvidence, isObjectiveEvidenceInvalidatingMutation, isObjectiveMutationTool, objectiveRequiresExecutionEvidence, transitionObjectiveContract } from "./objective-contract.ts";

describe('durable objective contract', () => {
  it('preserves a later independent imperative after an analytical decision clause', () => {
    for (const text of [
      'Analyse si le correctif est nécessaire; déploie-le en production.',
      'Analyse si le correctif est nécessaire. Déploie-le en production.',
      'Review whether the fix is needed; deploy it to production.',
      'Review whether the fix is needed. Deploy it to production.',
      'Analyse si le correctif est nécessaire : si oui, déploie-le en production.',
      'Review whether the fix is needed: if so, deploy it to production.',
      'Analyse si le correctif est nécessaire, puis déploie-le en production.',
      'Review whether the fix is needed, then deploy it to production.',
    ]) {
      const objective = transitionObjectiveContract({
        messageId: `analytical-then-imperative-${text}`,
        text,
      });
      expect(objective.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    }

    for (const text of [
      'Analyse si le correctif est nécessaire.',
      'Analyse si le correctif est nécessaire;',
      'Review whether the fix is needed.',
      'Review whether the fix is needed;',
      'Review whether we should fix then deploy the service.',
      'Review whether we should fix and then deploy the service.',
      'Analyse si nous devons corriger, puis déployer le service ?',
    ]) {
      const objective = transitionObjectiveContract({
        messageId: `analytical-only-${text}`,
        text,
      });
      expect(objective.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(false);
    }
  });

  it('treats a bounded affirmative access conclusion as execution authority', () => {
    const proud = transitionObjectiveContract({
      messageId: 'proud-access-decision',
      text: "Le client nous a partagé cette image de son agent dans le cadre de l'accès à son dossier de stagging via agent pour éditions sous contrôle. Donc on peut lui ouvrir l'accès car ça semble toujours bloqué dans le cadre de la procédure transmise. par contre là j'ai aussi un problème ou il a accès à Workspace en dossier au lieu de seulement Projet Alpha ou Projet Beta avec son app",
    });
    expect(proud.requiresExecutionEvidence).toBe(true);
    expect(objectiveRequiresExecutionEvidence(proud)).toBe(true);

    for (const text of [
      "Analyse si on peut lui ouvrir l'accès au dossier.",
      "Vérifie si on peut lui ouvrir l'accès au dossier.",
      "Donc on peut analyser l'accès au dossier.",
      "Donc on peut lui ouvrir l'accès ?",
      "Alors nous pouvons lui donner les droits d'accès ?",
      "Donc on peut lui ouvrir l'accès, n'est-ce pas.",
      "Alors nous pouvons lui donner les droits d'accès ou pas.",
      "Donc on peut lui ouvrir l'accès ou bien faut-il attendre.",
      "Donc on peut lui ouvrir l'accès, c'est bien ça.",
      "Donc on peut lui ouvrir l'accès, mais ne le fais pas.",
      "Donc on peut lui ouvrir l'accès, mais il ne faut pas le faire.",
      "Donc on peut lui ouvrir l'accès, toutefois ne lui ouvre pas les droits.",
      "Donc on peut lui ouvrir l'accès, cependant n'ouvre rien.",
      "Donc on peut lui ouvrir l'accès, mais attends ma confirmation.",
      "Donc on peut lui ouvrir l'accès si tu confirmes.",
      "Donc on peut lui ouvrir l'accès après ta confirmation.",
      "Donc on peut lui ouvrir l'accès seulement si le client valide.",
      "Donc on peut lui ouvrir l'accès sous réserve de validation.",
      "Donc on peut lui ouvrir l'accès quand le client aura confirmé.",
      "Donc on peut lui ouvrir l'accès à condition que tu sois d'accord.",
      "Donc on peut lui ouvrir l'accès dès que le client aura confirmé.",
      "Donc on peut lui ouvrir l'accès une fois que le client aura validé.",
      "Donc on peut lui ouvrir l'accès à réception de son accord.",
      "Donc on peut lui ouvrir l'accès si ça lui convient.",
      "Donc on peut lui ouvrir l'accès en principe.",
      "Donc on peut lui ouvrir l'accès seulement si le client dit oui.",
      "Donc on peut lui ouvrir l'accès quand le client donne son feu vert.",
      "Donc on peut lui ouvrir l'accès si le client nous donne le go.",
      "Donc on peut lui ouvrir l'accès sous réserve du feu vert du client.",
      "Donc on peut lui ouvrir l'accès seulement si le client accepte.",
      "Donc on peut lui ouvrir l'accès si le client ne s'y oppose pas.",
      "Donc on peut lui ouvrir l'accès si le client est OK.",
      "Donc on peut lui ouvrir l'accès quand le client nous répondra favorablement.",
      "Donc on peut lui ouvrir l'accès après le retour positif du client.",
      "Donc on peut lui ouvrir l'accès sous réserve de l'aval du client.",
      "Donc on peut lui ouvrir l'accès sous réserve de l’accord du client.",
      "Donc on peut lui ouvrir l'accès sous réserve de l’aval du client.",
      "Donc on peut lui ouvrir l'accès à réception de l’autorisation du client.",
      "Donc on peut lui ouvrir l'accès après l’approbation du client.",
      "Donc on peut lui ouvrir l'accès en attente de l’accord du client.",
      "Donc on peut lui ouvrir l'accès à condition d’avoir l’accord du client.",
      "Donc on peut lui ouvrir l'accès pourvu que le client accepte.",
      "Donc on peut lui ouvrir l'accès uniquement avec l’accord du client.",
      "Donc on peut lui ouvrir l'accès pas avant l’accord du client.",
      "Donc on peut lui ouvrir l'accès une fois l’accord reçu.",
      "Donc on peut lui ouvrir l'accès dès obtention du feu vert.",
      "Donc on peut lui ouvrir l'accès si le client le souhaite.",
      "Donc on peut lui ouvrir l'accès si l'utilisateur le veut.",
      "Donc on peut lui ouvrir l'accès si tu me le demandes.",
      "Donc on peut lui ouvrir l'accès dès que le client en fait la demande.",
      "Donc on peut lui ouvrir l'accès si le client estime que c'est bon.",
      "Donc on peut lui ouvrir l'accès si le client ne voit pas d'objection.",
      "Donc on peut lui ouvrir l'accès si le script est validé par le client.",
      "Donc on peut lui ouvrir l'accès si le client valide le script.",
      "Donc on peut lui ouvrir l'accès si le client confirme que le test passe.",
      "Donc on peut lui ouvrir l'accès dès que le client valide le contrôle.",
      "Donc on peut lui ouvrir l'accès si le client valide le script.",
      "Donc on peut lui ouvrir l'accès si l'équipe sécurité confirme que le test passe.",
      "Donc on peut lui ouvrir l'accès si le responsable confirme que l'API répond 200.",
      "Donc on peut lui ouvrir l'accès quand le manager valide le contrôle.",
      "Donc on peut lui ouvrir l'accès si le client dit que le build est bon.",
      "Donc on peut lui ouvrir l'accès si le client répond que l'API est OK.",
      "Donc on peut lui ouvrir l'accès si le responsable trouve le contrôle bon.",
      "Donc on peut lui ouvrir l'accès. Mais seulement si tu confirmes.",
      "Donc on peut lui ouvrir l'accès. Après ta confirmation.",
      "Donc on peut lui ouvrir l'accès. Sous réserve de validation.",
      "Donc on peut lui ouvrir l'accès. Quand le client aura confirmé.",
      "Donc on peut lui ouvrir l'accès. Mais ne le fais pas.",
      "Donc on peut lui ouvrir l'accès. N'ouvre finalement pas cet accès.",
      "Donc on peut lui ouvrir l'accès. Est-ce bien ce que tu recommandes ?",
      "Donc on peut lui ouvrir l'accès. Faut-il vraiment le faire ?",
      "Donc on peut lui ouvrir l'accès. Peux-tu me confirmer ?",
      "Donc on peut lui ouvrir l'accès. Tu confirmes ?",
      "Donc on peut lui ouvrir l'accès. Tu es sûr ?",
      "Donc on peut lui ouvrir l'accès. Vraiment ?",
      "Donc on peut lui ouvrir l'accès. D'accord ?",
      "Donc on peut lui ouvrir l'accès. Devons-nous encore attendre ?",
      "Donc on peut lui ouvrir l'accès. Toutefois, ne le fais pas.",
      "Donc on peut lui ouvrir l'accès. Cependant, n'ouvre rien.",
      "Donc on peut lui ouvrir l'accès, tu confirmes.",
      "Donc on peut lui ouvrir l'accès, vous confirmez.",
      "Donc on peut lui ouvrir l'accès, confirme-moi.",
      "Donc on peut lui ouvrir l'accès, d'accord.",
      "Donc on peut lui ouvrir l'accès, tu es sûr.",
      "Donc on peut lui ouvrir l'accès, vraiment.",
      "Donc on peut lui ouvrir l'accès, correct.",
      "Donc on peut lui ouvrir l'accès. Tu confirmes.",
      "Donc on peut lui ouvrir l'accès. Tu es sûr.",
      "Donc on peut lui ouvrir l'accès. D'accord.",
      "Le rapport dit :\nDonc on peut lui ouvrir l'accès car ça semble bloqué.",
      "Exemple d’instruction :\nDonc on peut lui ouvrir l’accès.",
      "Analyse ce texte :\n```\nDonc on peut lui ouvrir l’accès.\n```",
      "Ne fais aucune modification. Donc on peut lui ouvrir l’accès.",
      "N’ouvre rien pour le moment. Donc on peut lui ouvrir l’accès.",
      "Analyse seulement, sans agir. Donc on peut lui ouvrir l’accès.",
      "Do not change anything. Donc on peut lui ouvrir l’accès.",
      "Le rapport dit : donc on peut lui ouvrir l'accès au dossier.",
      "Donc on ne peut pas lui ouvrir l'accès au dossier.",
    ]) {
      const observational = transitionObjectiveContract({
        messageId: `access-decision-negative-${text}`,
        text,
      });
      expect(observational.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(observational)).toBe(false);
    }

    for (const text of [
      "Donc on peut lui ouvrir l'accès si nécessaire.",
      "Donc on peut lui ouvrir l'accès si cela débloque le client.",
      "Donc on peut lui ouvrir l'accès dès que le script a fini.",
      "Donc on peut lui ouvrir l'accès si tout est bon.",
      "Donc on peut lui ouvrir l'accès si le contrôle est validé automatiquement.",
      "Donc on peut lui ouvrir l'accès si le chemin existe.",
      "Donc on peut lui ouvrir l'accès si l'API répond 200.",
      "Donc on peut lui ouvrir l'accès si les permissions actuelles correspondent à la procédure.",
      "Donc on peut lui ouvrir l'accès si le fichier contient la clé.",
      "Donc on peut lui ouvrir l'accès si le port 443 est ouvert.",
      "Donc on peut lui ouvrir l'accès si la version déployée est correcte.",
      "Donc on peut lui ouvrir l'accès si le checksum correspond.",
      "Donc on peut lui ouvrir l'accès si le certificat est valide.",
      "Donc on peut lui ouvrir l'accès si la réponse HTTP vaut 200.",
      "Donc on peut lui ouvrir l'accès si le dossier est accessible.",
      "Donc on peut lui ouvrir l'accès si la configuration est conforme.",
      "Donc on peut lui ouvrir l'accès si le build est approuvé par GitHub Actions.",
      "Donc on peut lui ouvrir l'accès si le build est approuvé par la CI.",
    ]) {
      const conditionalExecution = transitionObjectiveContract({
        messageId: `access-decision-verifiable-condition-${text}`,
        text,
      });
      expect(conditionalExecution.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(conditionalExecution)).toBe(true);
    }

    for (const text of [
      "Donc on peut lui ouvrir l'accès ? Corrige le déploiement maintenant.",
      "Corrige le déploiement maintenant. Donc on peut lui ouvrir l'accès ?",
      "Donc on peut lui ouvrir l'accès, mais ne le fais pas. Déploie uniquement le correctif déjà validé.",
      "Donc on peut lui ouvrir l'accès après sa confirmation. En attendant, corrige la configuration locale.",
    ]) {
      const independentExecution = transitionObjectiveContract({
        messageId: `access-decision-independent-execution-${text}`,
        text,
      });
      expect(independentExecution.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(independentExecution)).toBe(true);
    }

    const activeMutation = transitionObjectiveContract({
      messageId: 'access-prior-active-mutation',
      text: 'Corrige le déploiement et vérifie le résultat.',
    });
    for (const text of [
      "Ne fais aucune modification. Donc on peut lui ouvrir l’accès.",
      "N’ouvre rien pour le moment. Donc on peut lui ouvrir l’accès.",
      "Analyse seulement, sans agir. Donc on peut lui ouvrir l’accès.",
      "Do not change anything. Donc on peut lui ouvrir l’accès.",
    ]) {
      const revoked = transitionObjectiveContract({
        existing: activeMutation,
        messageId: `access-prior-active-revocation-${text}`,
        text,
      });
      expect(revoked.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(revoked)).toBe(false);
    }

    const prompt = buildObjectiveContractPrompt(proud);
    expect(prompt).toContain('exact target, project, environment, path');
    expect(prompt).toContain('ask exactly one short structured question');
    expect(prompt).toContain('Do not guess a default, convert a hostname into a user choice');
    expect(prompt).toContain('An Objective authority refusal is not policy-blocker evidence');
  });

  it('lets a direct conversational comma lead-in revoke active execution authority', () => {
    const active = transitionObjectiveContract({
      messageId: 'direct-comma-root', text: 'Réactive le dev login.',
    });
    for (const text of [
      'Finalement, stop.',
      'Non, stop.',
      'OK, annule.',
      'Bon, laisse tomber.',
      'S’il te plaît, arrête.',
      'Maintenant, n’envoie rien.',
      'En fait, stop.',
      'Finalement, annule.',
      'Oui, n’en fais rien.',
      'Attends, stop.',
    ]) {
      const stopped = transitionObjectiveContract({
        existing: active,
        messageId: `direct-comma-${text}`,
        text,
      });
      expect(stopped.requiresExecutionEvidence).toBeUndefined();
      expect(objectiveRequiresExecutionEvidence(stopped)).toBe(false);
    }

    for (const text of [
      'Le rapport dit, stop.',
      'Exemple, annule.',
      'Citation, n’en fais rien.',
      'Analyse si nous devons continuer, pas maintenant.',
    ]) {
      const continued = transitionObjectiveContract({
        existing: active,
        messageId: `reported-comma-${text}`,
        text,
      });
      expect(continued.requiresExecutionEvidence).toBe(true);
      expect(objectiveRequiresExecutionEvidence(continued)).toBe(true);
    }
  });

  it('does not replace an active correction mission with a read-only clarification', () => {
    const existing = transitionObjectiveContract({ messageId: 'fix', text: 'Corrige la configuration de sécurité puis vérifie le service.' });
    const continued = transitionObjectiveContract({ existing, messageId: 'reply', text: 'Agis comme contre-relecteur indépendant hostile en lecture seule. Vérifie les résultats.' });
    expect(continued.originalText).toBe(existing.originalText);
    expect(continued.completionCriteria).toEqual(existing.completionCriteria);
    expect(objectiveRequiresExecutionEvidence(continued)).toBe(true);
  });

  it('does not count a validation script as proven execution but conservatively invalidates older observations', () => {
    const command = `python3 /session/data/validate_campaign.py >/dev/null && printf '{"ok":true}\\n'`;
    const message: Message = { id: 'check', role: 'tool', content: '', timestamp: 2, toolName: 'Bash', toolInput: { command }, toolResult: '{"ok":true}', toolExecuted: true, toolStatus: 'completed' };
    expect(isObjectiveMutationTool(message)).toBe(false);
    expect(isObjectiveEvidenceInvalidatingMutation(message)).toBe(true);
    expect(isObjectiveMutationTool({ ...message, toolInput: { command: 'rm target.json >/dev/null' } })).toBe(true);
    expect(isObjectiveMutationTool({ ...message, toolInput: { command: 'printf ok >target.json 2>/dev/null' } })).toBe(true);
  });

  it('does not classify git merge-base as git merge, while genuine merge remains a mutation', () => {
    const message: Message = { id: 'ancestry', role: 'tool', content: '', timestamp: 2, toolName: 'mcp__servers__ssh_execute', toolInput: { command: 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager merge-base --is-ancestor abcdef1 abcdef2' }, toolResult: 'exit 0', toolExecuted: true, toolStatus: 'completed' };
    expect(isObjectiveEvidenceInvalidatingMutation(message)).toBe(false);
    for (const command of ['git merge feature', 'git merge', 'git push; git status', 'git commit -m fix', 'ssh host "cd /repo && git push"']) {
      expect(isObjectiveEvidenceInvalidatingMutation({ ...message, toolInput: { command } })).toBe(true);
    }
  });

  it('invalidates stale observations after unknown compound tools and non-read-only shell commands', () => {
    const base: Message = { id: 'mutation', role: 'tool', content: '', timestamp: 2,
      toolStatus: 'completed', toolExecuted: true, toolResult: '{"ok":true}' };
    expect(isObjectiveEvidenceInvalidatingMutation({
      ...base, toolName: 'mcp__ops__get_and_process', toolInput: { host: 'dev', timer: 'cleanup' },
    })).toBe(true);
    for (const command of [
      'git checkout main',
      'git switch main',
      'docker compose restart',
      'launchctl kickstart -k gui/501/io.robinswood.robbagents',
      'perl -pi -e "s/old/new/g" settings.json',
      'find /srv/review -maxdepth 0 -fprintf /srv/review/state.txt changed',
    ]) {
      expect(isObjectiveEvidenceInvalidatingMutation({
        ...base, toolName: 'Bash', toolInput: { command },
      })).toBe(true);
    }
    const safeGit = 'git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c log.showSignature=false -c format.pretty=medium --no-pager';
    for (const command of [`${safeGit} rev-parse HEAD`, `${safeGit} log -1`, 'cat settings.json']) {
      expect(isObjectiveEvidenceInvalidatingMutation({
        ...base, toolName: 'Bash', toolInput: { command },
      })).toBe(false);
    }
  });

  it('does not count quoted comparisons or heredoc Python as mutation evidence', () => {
    for (const command of [
      'python3 -c "assert 3 >= 2"',
      "python3 - <<'PY'\nassert 3 >= 2\nassert 3 > 2\nPY",
      'node -e "console.log(3 > 2)"',
      'echo "this > that"',
    ]) {
      expect(hasObjectiveExecutionEvidence([
        { id: 'u1', role: 'user', content: 'Corrige le résultat', timestamp: 1 },
        { id: 't1', role: 'tool', content: 'true', timestamp: 2, toolName: 'Bash', toolInput: { command }, toolExecuted: true, toolStatus: 'completed' },
      ], 'u1')).toBe(false);
    }
  });

  it('still counts real redirects, including after a quoted comparison', () => {
    for (const command of ['echo ok > output.txt', 'echo ok >> output.txt', 'node -e "console.log(3 >= 2)" > output.txt', "cat <<'EOF' > output.txt\nvalue >= threshold\nEOF"]) {
      expect(hasObjectiveExecutionEvidence([
        { id: 'u1', role: 'user', content: 'Corrige le résultat', timestamp: 1 },
        { id: 't1', role: 'tool', content: 'File saved', timestamp: 2, toolName: 'Bash', toolInput: { command }, toolExecuted: true, toolStatus: 'completed' },
      ], 'u1')).toBe(true);
    }
  });

  it('promotes complex and high-stakes work to mission semantics', () => {
    const objective = transitionObjectiveContract({
      messageId: 'u1',
      text: 'Analyse le NDA, recherche le droit applicable, corrige-le puis vérifie le document.',
      lifetimeCostUsd: 740,
      lifetimeTokens: 2_000_000,
      nowMs: 10,
    });
    expect(objective.orchestrationMode).toBe('mission');
    expect(objective.risk).toBe('high-stakes');
    expect(objective.budgetBaselineUsd).toBe(740);
    expect(objective.completionCriteria).toContain('independent-review-passed');
    expect(buildObjectiveContractPrompt(objective)).toContain('High-stakes evidence gate');
  });

  it('recognizes inflected accounting work as high-stakes', () => {
    const objective = transitionObjectiveContract({
      messageId: 'u-accounting',
      text: 'Corrige cette écriture comptable puis vérifie le grand livre.',
    });
    expect(objective.risk).toBe('high-stakes');
    expect(objective.evidenceRequirement).toBe('authoritative-sources-before-mutation');
    expect(objective.completionCriteria).toContain('independent-review-passed');
  });

  it('derives sensitive mutations without inventing an unrelated authoritative-source domain', () => {
    for (const text of [
      'Change the passwords.',
      'Rotate the API key.',
      'Delete customer personal data.',
      'Pay the invoice.',
      'Restart the production database.',
      'Copy the customer records to Dropbox.',
      'Forward the API key to the vendor.',
      'Copie les données clients dans Dropbox.',
      'Transmets les identifiants au prestataire.',
      'Efface les mots de passe utilisateurs.',
    ]) {
      const objective = transitionObjectiveContract({ messageId: 'sensitive-mutation', text });
      expect(objective).toMatchObject({
        risk: 'high-stakes', orchestrationMode: 'mission', requiresExecutionEvidence: true,
        requiresAcceptanceCriteria: true,
      });
      expect(objective.evidenceRequirement).toBeUndefined();
      expect(objective.evidenceDomain).toBeUndefined();
      expect(objective.completionCriteria).toContain('independent-review-passed');
      expect(objectiveRequiresExecutionEvidence(objective)).toBe(true);
    }

    const domainBound = transitionObjectiveContract({
      messageId: 'security-domain-mutation', text: 'Configure the RBAC permissions and verify them.',
    });
    expect(domainBound).toMatchObject({
      risk: 'high-stakes', evidenceDomain: 'security',
      evidenceRequirement: 'authoritative-sources-before-mutation',
    });

    for (const text of [
      'Accorde le rôle d’administrateur à Alice.',
      'Accorde le rôle d’admin à Alice.',
      'Donne le rôle d’admin à Alice.',
      'Attribue le rôle d’admin à Alice.',
      'Donne à Alice le rôle d’admin.',
      'Set Alice as admin.',
      'Set Alice’s role to administrator.',
      'Change Alice’s role to admin.',
      'Add Alice to administrators.',
      'Ajoute Alice aux administrateurs.',
      'Supprime l’accès admin d’Alice.',
      'Passe Alice administratrice.',
      'Rends Alice administratrice.',
      'Ajoute Alice au groupe des administrateurs.',
      'Promote Alice to administrator.',
    ]) {
      expect(transitionObjectiveContract({ messageId: `rbac-${text}`, text })).toMatchObject({
        risk: 'high-stakes', evidenceDomain: 'security',
        evidenceRequirement: 'authoritative-sources-before-mutation',
        requiresExecutionEvidence: true,
      });
    }
  });
});
