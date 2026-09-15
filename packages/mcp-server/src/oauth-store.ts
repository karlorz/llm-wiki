import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ClientEntry {
  clientId: string;
  clientSecret?: string;
  clientName?: string;
  redirectUris: string[];
}

export interface AuthCodeEntry {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  writerId: string;
  expiresAt: number;
}

export interface AccessTokenEntry {
  tokenHash: string;
  clientId: string;
  writerId: string;
  expiresAt: number;
  scope?: string;
}

export interface RefreshTokenEntry {
  tokenHash: string;
  clientId: string;
  writerId: string;
  expiresAt: number;
  scope?: string;
}

export interface OAuthStore {
  saveClient(client: ClientEntry): Promise<void>;
  getClient(clientId: string): Promise<ClientEntry | null>;

  saveAuthCode(code: AuthCodeEntry): Promise<void>;
  consumeAuthCode(codeHash: string): Promise<AuthCodeEntry | null>;

  saveAccessToken(token: AccessTokenEntry): Promise<void>;
  getAccessToken(tokenHash: string): Promise<AccessTokenEntry | null>;

  saveRefreshToken(token: RefreshTokenEntry): Promise<void>;
  consumeRefreshToken(tokenHash: string): Promise<RefreshTokenEntry | null>;
}

export class InMemoryOAuthStore implements OAuthStore {
  private clients = new Map<string, ClientEntry>();
  private authCodes = new Map<string, AuthCodeEntry>();
  private accessTokens = new Map<string, AccessTokenEntry>();
  private refreshTokens = new Map<string, RefreshTokenEntry>();

  async saveClient(client: ClientEntry): Promise<void> {
    this.clients.set(client.clientId, { ...client });
  }

  async getClient(clientId: string): Promise<ClientEntry | null> {
    return this.clients.get(clientId) ?? null;
  }

  async saveAuthCode(code: AuthCodeEntry): Promise<void> {
    this.authCodes.set(code.codeHash, { ...code });
  }

  async consumeAuthCode(codeHash: string): Promise<AuthCodeEntry | null> {
    const entry = this.authCodes.get(codeHash);
    if (!entry) return null;
    this.authCodes.delete(codeHash);
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  async saveAccessToken(token: AccessTokenEntry): Promise<void> {
    this.accessTokens.set(token.tokenHash, { ...token });
  }

  async getAccessToken(tokenHash: string): Promise<AccessTokenEntry | null> {
    const entry = this.accessTokens.get(tokenHash);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.accessTokens.delete(tokenHash);
      return null;
    }
    return entry;
  }

  async saveRefreshToken(token: RefreshTokenEntry): Promise<void> {
    this.refreshTokens.set(token.tokenHash, { ...token });
  }

  async consumeRefreshToken(tokenHash: string): Promise<RefreshTokenEntry | null> {
    const entry = this.refreshTokens.get(tokenHash);
    if (!entry) return null;
    this.refreshTokens.delete(tokenHash);
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }
}

interface PersistedState {
  clients: Record<string, ClientEntry>;
  authCodes: Record<string, AuthCodeEntry>;
  accessTokens: Record<string, AccessTokenEntry>;
  refreshTokens: Record<string, RefreshTokenEntry>;
}

export class FileOAuthStore implements OAuthStore {
  private filePath: string;
  private state: PersistedState;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.filePath = join(stateDir, "oauth-store.json");
    this.state = this.load();
  }

  private load(): PersistedState {
    if (!existsSync(this.filePath)) {
      return { clients: {}, authCodes: {}, accessTokens: {}, refreshTokens: {} };
    }
    try {
      const content = readFileSync(this.filePath, "utf8");
      return JSON.parse(content) as PersistedState;
    } catch {
      return { clients: {}, authCodes: {}, accessTokens: {}, refreshTokens: {} };
    }
  }

  private persist(): void {
    const payload = JSON.stringify(this.state, null, 2);
    writeFileSync(this.filePath, payload, { mode: 0o600 });
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      // ignore on systems where chmod may fail
    }
  }

  private commit(mutate: () => void): void {
    const snapshot = JSON.parse(JSON.stringify(this.state)) as PersistedState;
    mutate();
    try {
      this.persist();
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  async saveClient(client: ClientEntry): Promise<void> {
    this.commit(() => {
      this.state.clients[client.clientId] = { ...client };
    });
  }

  async getClient(clientId: string): Promise<ClientEntry | null> {
    return this.state.clients[clientId] ?? null;
  }

  async saveAuthCode(code: AuthCodeEntry): Promise<void> {
    this.commit(() => {
      this.state.authCodes[code.codeHash] = { ...code };
    });
  }

  async consumeAuthCode(codeHash: string): Promise<AuthCodeEntry | null> {
    const entry = this.state.authCodes[codeHash];
    if (!entry) return null;
    this.commit(() => {
      delete this.state.authCodes[codeHash];
    });
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }

  async saveAccessToken(token: AccessTokenEntry): Promise<void> {
    this.commit(() => {
      this.state.accessTokens[token.tokenHash] = { ...token };
    });
  }

  async getAccessToken(tokenHash: string): Promise<AccessTokenEntry | null> {
    const entry = this.state.accessTokens[tokenHash];
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.commit(() => {
        delete this.state.accessTokens[tokenHash];
      });
      return null;
    }
    return entry;
  }

  async saveRefreshToken(token: RefreshTokenEntry): Promise<void> {
    this.commit(() => {
      this.state.refreshTokens[token.tokenHash] = { ...token };
    });
  }

  async consumeRefreshToken(tokenHash: string): Promise<RefreshTokenEntry | null> {
    const entry = this.state.refreshTokens[tokenHash];
    if (!entry) return null;
    this.commit(() => {
      delete this.state.refreshTokens[tokenHash];
    });
    if (Date.now() > entry.expiresAt) return null;
    return entry;
  }
}
