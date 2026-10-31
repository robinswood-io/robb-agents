import { ACTION_DETAILS } from './host-authorization.ts';

export const GENERIC_MUTATION_TERM_ALIASES: Record<string, string[]> = {
  accept: ['accept', 'accepte', 'accepter'],
  activate: ['activate', 'active', 'activer'],
  add: ['add', 'ajoute', 'ajouter'],
  approve: ['approve', 'approuve', 'approuver'],
  archive: ['archive', 'archiver'],
  assign: ['assign', 'assigne', 'assigner'],
  cancel: ['cancel', 'annule', 'annuler'],
  close: ['close', 'ferme', 'fermer'],
  configure: ['configure', 'configurer'],
  copy: ['copy', 'copie', 'copier'],
  create: ['create', 'cree', 'creer'],
  delete: ['delete', 'remove', 'destroy', 'erase', 'purge', 'supprime', 'supprimer'],
  destroy: ['delete', 'destroy', 'supprime', 'supprimer'],
  disable: ['disable', 'desactive', 'desactiver'],
  edit: ['edit', 'update', 'modify', 'modifie', 'modifier', 'mets', 'mettre', 'mets a jour', 'mettre a jour'],
  enable: ['enable', 'active', 'activer'],
  execute: ['execute', 'run', 'trigger', 'execute', 'executer', 'lance', 'lancer'],
  grant: ['grant', 'accorde', 'accorder'],
  install: ['install', 'installe', 'installer'],
  invite: ['invite', 'inviter'],
  merge: ['merge', 'fusionne', 'fusionner'],
  modify: ['modify', 'edit', 'update', 'modifie', 'modifier', 'mets', 'mettre', 'mets a jour', 'mettre a jour'],
  move: ['move', 'deplace', 'deplacer'],
  patch: ['patch', 'corrige', 'corriger', 'modifie', 'modifier'],
  post: ['post', 'publie', 'publier'],
  remove: ['remove', 'delete', 'supprime', 'supprimer'],
  rename: ['rename', 'renomme', 'renommer'],
  replace: ['replace', 'remplace', 'remplacer'],
  reset: ['reset', 'reinitialise', 'reinitialiser'],
  restore: ['restore', 'restaure', 'restaurer'],
  revoke: ['revoke', 'revoque', 'revoquer'],
  rotate: ['rotate', 'tourne', 'renouvelle', 'renouveler'],
  run: ['run', 'execute', 'trigger', 'lance', 'lancer', 'execute', 'executer'],
  save: ['save', 'enregistre', 'enregistrer'],
  schedule: ['schedule', 'planifie', 'planifier'],
  set: ['set', 'configure', 'definis', 'definir'],
  start: ['start', 'demarre', 'demarrer', 'lance', 'lancer'],
  stop: ['stop', 'arrete', 'arreter'],
  submit: ['submit', 'soumets', 'soumettre'],
  trigger: ['trigger', 'run', 'declenche', 'declencher', 'lance', 'lancer'],
  uninstall: ['uninstall', 'desinstalle', 'desinstaller'],
  update: ['update', 'edit', 'modify', 'mets', 'mettre', 'mets a jour', 'mettre a jour', 'modifie', 'modifier'],
  upload: ['upload', 'televerse', 'televerser'],
  write: ['write', 'ecris', 'ecrire'],
};

const NON_DESTRUCTIVE_IMPLEMENTATION_TOKENS = new Set([
  'activate', 'add', 'alter', 'append', 'apply', 'configure', 'copy', 'create',
  'edit', 'enable', 'execute', 'export', 'import', 'install', 'link', 'mark',
  'modify', 'move', 'patch', 'replace', 'restore', 'run', 'save', 'set', 'start',
  'submit', 'trigger', 'update', 'upload', 'upsert', 'write',
]);

export const IN_SCOPE_IMPLEMENTATION_ALIASES = [
  'apply', 'applique', 'appliquer', 'change', 'change le', 'corrige', 'corriger',
  'deploy', 'deployment', 'deploie', 'deploiement', 'deployer', 'fix', 'implement',
  'implante', 'implanter', 'mets a jour', 'mettre a jour', 'modifie', 'modifier',
  'reactivate', 'reactive', 'reactiver',
];

export const REMOTE_SERVICE_LIFECYCLE_AUTHORIZATION_TERMS = [[
  ...ACTION_DETAILS.service_restart.authorizationTermGroups[0]!,
  'deploy', 'deployment', 'deploie', 'deploiement', 'deployer',
]];

export function genericMutationAuthorizationTerms(
  token: string | undefined,
  allowImplementationAliases = false,
): string[][] {
  if (!token) return ACTION_DETAILS.external_mutation.authorizationTermGroups;
  const aliases = GENERIC_MUTATION_TERM_ALIASES[token] ?? [token];
  return [allowImplementationAliases && NON_DESTRUCTIVE_IMPLEMENTATION_TOKENS.has(token)
    ? [...new Set([...aliases, ...IN_SCOPE_IMPLEMENTATION_ALIASES])]
    : aliases];
}
