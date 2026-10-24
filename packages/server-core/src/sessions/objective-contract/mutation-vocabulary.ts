
export const MUTATION_BASH_PATTERN = /(?:^|\s)(?:apply_patch|chmod|chown|cp|install|ln|mkdir|mv|rm|rmdir|sed\s+-i|touch|truncate|deploy|git\s+(?:commit|merge|push)(?![-\w])|systemctl\s+(?:disable|enable|restart|start|stop)|(?:npm|bun|pnpm|yarn)\s+(?:install|publish)|(?:python\d*|bun|node)\s+[^\n]*(?:build|generate|write|create)|docx-tool|xlsx-tool|pptx-tool|pdf-tool)\b/i;
