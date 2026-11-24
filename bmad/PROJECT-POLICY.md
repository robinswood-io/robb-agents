# Contrat Projet — robinswood-agents

- **Environnement DEV** : Bind-Mount direct + Hot Reload temps réel (`0 build` applicatif ou Docker sur DEV).
- **Contrôles rapides DEV (`< 3 s`)** : `rtk bun /opt/ia-webdev/rulebook-ai/scripts/bmad/rbw.mts check-dev /srv/workspace/robinswood-agents` et `rtk bun test <fichier.test.ts>`.
- **Promotion Production** : Quality Gate complet Bun (`rtk bun /opt/ia-webdev/rulebook-ai/scripts/bmad/rbw.mts promote-prod /srv/workspace/robinswood-agents`) avec migrations et `build` exécutés exclusivement sur le serveur de destination (UE/EEE, Règle 51).
