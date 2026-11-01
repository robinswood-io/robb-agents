/** Configuration validation by resource and permission boundary. */
export type { ValidationIssue, ValidationResult } from './validators/validation-types.ts';
export { StoredConfigSchema, UserPreferencesSchema } from './validators/validation-types.ts';
export { validateConfig, validatePreferences, validateAll } from './validators/app-config.ts';
export { FolderSourceConfigSchema, validateSourceConfig, validateSourceConfigContent, validateSource, validateAllSources } from './validators/sources.ts';
export { SkillMetadataSchema, validateSkill, validateSkillContent, validateAllSkills } from './validators/skills.ts';
export { validateStatuses, validateStatusesContent } from './validators/statuses.ts';
export { validateLabels, validateLabelsContent } from './validators/labels.ts';
export { validatePermissionsContent, validateWorkspacePermissions, validateSourcePermissions, validateDefaultPermissions, validateAllPermissions, isValidPermissionsFile } from './validators/permissions.ts';
export { ThemeOverrideSchema, PresetThemeSchema, validateThemeContent, validateThemeOverrideContent, isValidThemeFile } from './validators/themes.ts';
export { validateToolIconsContent, validateToolIcons } from './validators/tool-icons.ts';
export type { ConfigFileDetection } from './validators/file-detection.ts';
export { formatValidationResult, detectConfigFileType, detectAppConfigFileType, validateConfigFileContent } from './validators/file-detection.ts';
