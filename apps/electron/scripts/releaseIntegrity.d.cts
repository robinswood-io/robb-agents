/** Public contract of the CommonJS packaging hook; exercised by release-integrity.test.ts. */
declare function beforePack(context: beforePack.PackContext): Promise<void>;
declare namespace beforePack {
  interface IntegrityContext {
    electronPlatformName?: string | undefined;
    packager?: {
      platformSpecificBuildOptions?: { forceCodeSigning?: boolean | undefined } | undefined;
      config?: { forceCodeSigning?: boolean | undefined } | undefined;
    } | undefined;
  }
  interface PackContext extends IntegrityContext {
    packager: NonNullable<IntegrityContext['packager']> & { projectDir: string };
  }
  function parseDirtyFlag(value?: string): boolean | undefined;
  function validateReleaseSourceState(state: {
    declaredDirty?: string | undefined;
    gitPorcelain?: string | undefined;
  }): void;
  function inspectReleaseSource(rootDir: string, env?: NodeJS.ProcessEnv): string;
  function requiresMacReleaseIntegrity(context?: IntegrityContext | null): boolean;
  function requiresReleaseSourceIntegrity(context?: IntegrityContext | null, env?: NodeJS.ProcessEnv): boolean;
  function resolveRepositoryRoot(projectDir: string): string;
}
export = beforePack;
