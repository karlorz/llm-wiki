import { describe,expect,it } from "vitest";
import { loadConfig } from "../src/config.js";
import { workspaceDeploymentConfig } from "../src/workspace-config.js";
const base={SKILLWIKI_MCP_VAULT:"/tmp/legacy",SKILLWIKI_MCP_TOKEN_MAP:"/tmp/tokens",SKILLWIKI_MCP_RCLONE_REMOTE:"storage",SKILLWIKI_MCP_RCLONE_BUCKET:"bucket/wiki",SKILLWIKI_MCP_S3_ENDPOINT:"https://objects.example",SKILLWIKI_MCP_S3_BUCKET:"bucket",SKILLWIKI_MCP_S3_ACCESS_KEY:"fixture",SKILLWIKI_MCP_S3_SECRET_KEY:"fixture",SKILLWIKI_MCP_OAUTH_ENABLED:"true",SKILLWIKI_MCP_OAUTH_ISSUER:"https://wiki.example"};
const enabled={SKILLWIKI_WORKSPACE_ENABLED:"true",SKILLWIKI_WORKSPACE_STATE_DIR:"/tmp/control",SKILLWIKI_WORKSPACE_LOCAL_ROOT:"/tmp/native",SKILLWIKI_WORKSPACE_GITHUB_CLIENT_ID:"fixture",SKILLWIKI_WORKSPACE_GITHUB_CLIENT_SECRET:"fixture",SKILLWIKI_WORKSPACE_S3_PREFIX:"workspaces",SKILLWIKI_WORKSPACE_GRANT_HOURS:"720",SKILLWIKI_WORKSPACE_INVITATION_HOURS:"168"};
describe("workspace production opt-in",()=>{
 it("is disabled unless explicitly enabled",()=>{expect(workspaceDeploymentConfig(base,loadConfig(base))).toBeUndefined();});
 it("requires complete policy, isolated paths and HTTPS rather than falling back",()=>{
  expect(workspaceDeploymentConfig({...base,...enabled},loadConfig(base))?.storage.prefix).toBe("workspaces");
  for(const key of ["SKILLWIKI_WORKSPACE_GITHUB_CLIENT_SECRET","SKILLWIKI_WORKSPACE_S3_PREFIX","SKILLWIKI_WORKSPACE_GRANT_HOURS"]){const env:Record<string,string>={...base,...enabled};delete env[key];expect(()=>workspaceDeploymentConfig(env,loadConfig(base))).toThrow();}
  expect(()=>workspaceDeploymentConfig({...base,...enabled,SKILLWIKI_WORKSPACE_LOCAL_ROOT:"relative"},loadConfig(base))).toThrow();
  expect(()=>workspaceDeploymentConfig({...base,...enabled},loadConfig({...base,SKILLWIKI_MCP_OAUTH_ISSUER:"http://wiki.example"}))).toThrow("HTTPS");
 });
});
