import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { McpDaemonConfig } from "./config.js";
import { WorkspaceError } from "./workspace-store.js";

/** Explicit production opt-in. Partial/invalid configuration never downgrades to local storage. */
export function workspaceDeploymentConfig(env: NodeJS.Dict<string>, cfg: McpDaemonConfig) {
 if(env.SKILLWIKI_WORKSPACE_ENABLED===undefined || env.SKILLWIKI_WORKSPACE_ENABLED==="false")return undefined;
 if(env.SKILLWIKI_WORKSPACE_ENABLED!=="true" || !cfg.oauth?.enabled || !cfg.oauth.issuer)throw new WorkspaceError("WORKSPACE_CONFIG_INVALID");
 const required=(name:string)=>{const value=env[name];if(!value?.trim())throw new WorkspaceError("WORKSPACE_CONFIG_REQUIRED");return value;};
 const stateDir=required("SKILLWIKI_WORKSPACE_STATE_DIR"),localRoot=required("SKILLWIKI_WORKSPACE_LOCAL_ROOT");
 if(!isAbsolute(stateDir)||!isAbsolute(localRoot))throw new WorkspaceError("WORKSPACE_CONFIG_INVALID");
 const issuer=new URL(cfg.oauth.issuer).origin;
 if(!issuer.startsWith("https://"))throw new WorkspaceError("WORKSPACE_HTTPS_REQUIRED");
 const clientId=required("SKILLWIKI_WORKSPACE_GITHUB_CLIENT_ID");
 const secretFile=env.SKILLWIKI_WORKSPACE_GITHUB_CLIENT_SECRET_FILE;
 const clientSecret=secretFile?readFileSync(secretFile,"utf8").trim():required("SKILLWIKI_WORKSPACE_GITHUB_CLIENT_SECRET");
 if(!clientSecret)throw new WorkspaceError("WORKSPACE_CONFIG_REQUIRED");
 const hours=(name:string)=>{const value=Number(required(name))*3600_000;if(!Number.isSafeInteger(value)||value<=0)throw new WorkspaceError("WORKSPACE_CONFIG_INVALID");return value;};
 const creatorIds=(env.SKILLWIKI_WORKSPACE_CREATOR_IDS??"").split(",").filter(Boolean);
 if(creatorIds.some(x=>!(/^[1-9][0-9]*$/).test(x)))throw new WorkspaceError("WORKSPACE_CONFIG_INVALID");
 if(!cfg.s3Bucket||!cfg.s3Endpoint||!cfg.s3AccessKeyId||!cfg.s3SecretAccessKey)throw new WorkspaceError("WORKSPACE_STORAGE_CONFIG_REQUIRED");
 return {stateDir,issuer,github:{clientId,clientSecret},creatorIds,grantLifetimeMs:hours("SKILLWIKI_WORKSPACE_GRANT_HOURS"),invitationLifetimeMs:hours("SKILLWIKI_WORKSPACE_INVITATION_HOURS"),storage:{localRoot,remote:cfg.rcloneRemote,bucket:cfg.s3Bucket,prefix:required("SKILLWIKI_WORKSPACE_S3_PREFIX"),endpoint:cfg.s3Endpoint,region:cfg.s3Region,reconcileIntervalMs:cfg.reconcileIntervalMs}};
}
