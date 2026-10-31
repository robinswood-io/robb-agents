

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { cn } from "@/lib/utils";
import { Eye, EyeOff } from "lucide-react";

import "@craft-agent/shared/robinswood-branding";

import type { ApiKeyInputViewProps } from "./api-key-input-config";

type ApiKeyBedrockFieldsProps = Pick<ApiKeyInputViewProps, "isDisabled" | "setBedrockAuthMethod" | "bedrockAuthMethod" | "awsAccessKeyId" | "setAwsAccessKeyId" | "showValue" | "awsSecretAccessKey" | "setAwsSecretAccessKey" | "t" | "setShowValue" | "awsSessionToken" | "setAwsSessionToken" | "awsRegion" | "setAwsRegion">;

export function ApiKeyBedrockFields({
  isDisabled,
  setBedrockAuthMethod,
  bedrockAuthMethod,
  awsAccessKeyId,
  setAwsAccessKeyId,
  showValue,
  awsSecretAccessKey,
  setAwsSecretAccessKey,
  t,
  setShowValue,
  awsSessionToken,
  setAwsSessionToken,
  awsRegion,
  setAwsRegion,
}: ApiKeyBedrockFieldsProps) {
  return (
        <>
          {/* Auth Method Toggle */}
          <div className="space-y-2">
            <Label>Authentication</Label>
            <div className={cn(
              "flex rounded-md shadow-minimal overflow-hidden",
              "bg-foreground-2",
              isDisabled && "opacity-50 pointer-events-none"
            )}>
              {([
                { value: 'iam_credentials' as const, label: 'IAM Credentials' },
                { value: 'environment' as const, label: 'Environment (AWS CLI)' },
              ]).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => setBedrockAuthMethod(value)}
                  className={cn(
                    "flex-1 py-1.5 text-[12px] font-medium transition-colors",
                    bedrockAuthMethod === value
                      ? "bg-background text-foreground shadow-minimal"
                      : "text-foreground/50 hover:text-foreground/70"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* IAM Credential Fields */}
          {bedrockAuthMethod === 'iam_credentials' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="aws-access-key-id" className="text-muted-foreground font-normal text-xs">
                  Access Key ID
                </Label>
                <div className={cn("rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
                  <Input
                    id="aws-access-key-id"
                    type="text"
                    value={awsAccessKeyId}
                    onChange={(e) => setAwsAccessKeyId(e.target.value)}
                    placeholder="AKIA..."
                    className="border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                    autoFocus
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aws-secret-key" className="text-muted-foreground font-normal text-xs">
                  Secret Access Key
                </Label>
                <div className={cn("relative rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
                  <Input
                    id="aws-secret-key"
                    type={showValue ? 'text' : 'password'}
                    value={awsSecretAccessKey}
                    onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                    placeholder={t("apiSetup.secretAccessKey")}
                    className="pr-10 border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                  />
                  <button
                    type="button"
                    onClick={() => setShowValue(!showValue)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aws-session-token" className="text-muted-foreground font-normal text-xs">
                  Session Token <span className="text-foreground/30">· optional</span>
                </Label>
                <div className={cn("rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
                  <Input
                    id="aws-session-token"
                    type="text"
                    value={awsSessionToken}
                    onChange={(e) => setAwsSessionToken(e.target.value)}
                    placeholder={t("apiSetup.temporaryCredentials")}
                    className="border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Environment info */}
          {bedrockAuthMethod === 'environment' && (
            <div className="rounded-md bg-foreground-2 p-3">
              <p className="text-xs text-foreground/50">
                Uses your existing AWS credential chain — <code className="text-foreground/70">~/.aws/credentials</code>, <code className="text-foreground/70">AWS_PROFILE</code>, IAM roles, SSO sessions, and environment variables.
              </p>
            </div>
          )}

          {/* AWS Region */}
          <div className="space-y-1.5">
            <Label htmlFor="aws-region" className="text-muted-foreground font-normal text-xs">
              AWS Region
            </Label>
            <div className={cn("rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
              <Input
                id="aws-region"
                type="text"
                value={awsRegion}
                onChange={(e) => setAwsRegion(e.target.value)}
                placeholder="us-east-1"
                className="border-0 bg-transparent shadow-none"
                disabled={isDisabled}
              />
            </div>
          </div>
        </>
      )
}
