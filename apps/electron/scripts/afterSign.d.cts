import type sourceIntegrity = require('./releaseIntegrity.cjs');

/** Public contract of the CommonJS signing hook; no signing command is run by importing it. */
declare function afterSign(context: afterSign.SignContext): Promise<void>;
declare namespace afterSign {
  interface SignContext extends sourceIntegrity.IntegrityContext {
    appOutDir: string;
    packager: NonNullable<sourceIntegrity.IntegrityContext['packager']> & {
      appInfo?: { productFilename?: string | undefined } | undefined;
      platformSpecificBuildOptions?: {
        forceCodeSigning?: boolean | undefined;
        notarize?: boolean | undefined;
      } | undefined;
    };
  }
  interface CommandResult { returncode: number; text: string }
  function validateDeveloperIdInspection(returncode: number, text: string): void;
  function validateReleaseVerificationResults(results: {
    codesign: CommandResult;
    gatekeeper: CommandResult;
    stapler: CommandResult;
  }): void;
  function verifyReleaseApplication(appPath: string, requireNotarization?: boolean): void;
}
export = afterSign;
