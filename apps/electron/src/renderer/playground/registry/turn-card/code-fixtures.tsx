import { type FileChange } from "@craft-agent/ui";

// ============================================================================
// Code Preview Overlay - Playground Wrapper
// ============================================================================

export const sampleTypeScriptCode = `import { useState, useEffect, useCallback } from 'react'
import type { Session, AuthToken } from '../types'
import { encryptToken, decryptToken } from '../lib/crypto'

/**
 * TokenManager - Handles secure token storage and lifecycle
 *
 * Features:
 * - AES-256 encryption for token storage
 * - Automatic refresh before expiry (5 min buffer)
 * - Token revocation and cleanup
 */
export class TokenManager {
  private readonly encryptionKey: CryptoKey
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map()

  constructor(private readonly storage: TokenStorage) {
    this.encryptionKey = this.deriveKey()
  }

  /**
   * Store a new token pair securely.
   * Encrypts both access and refresh tokens before persisting.
   */
  async storeToken(sessionId: string, token: AuthToken): Promise<void> {
    const encrypted = await encryptToken(token, this.encryptionKey)
    await this.storage.set(sessionId, encrypted)

    // Schedule refresh before expiry
    this.scheduleRefresh(sessionId, token.expiresIn)
  }

  /**
   * Retrieve and decrypt a stored token.
   * Returns null if token doesn't exist or decryption fails.
   */
  async getToken(sessionId: string): Promise<AuthToken | null> {
    const encrypted = await this.storage.get(sessionId)
    if (!encrypted) return null

    try {
      return await decryptToken(encrypted, this.encryptionKey)
    } catch (error) {
      console.error('[TokenManager] Decryption failed:', error)
      await this.revokeToken(sessionId)
      return null
    }
  }

  /**
   * Revoke a token and clean up associated resources.
   */
  async revokeToken(sessionId: string): Promise<void> {
    const timer = this.refreshTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.refreshTimers.delete(sessionId)
    }
    await this.storage.delete(sessionId)
  }

  private scheduleRefresh(sessionId: string, expiresIn: number): void {
    // Refresh 5 minutes before expiry
    const refreshIn = Math.max(0, (expiresIn - 300) * 1000)
    const timer = setTimeout(() => this.refreshToken(sessionId), refreshIn)
    this.refreshTimers.set(sessionId, timer)
  }

  private async refreshToken(sessionId: string): Promise<void> {
    const token = await this.getToken(sessionId)
    if (!token?.refreshToken) return

    try {
      const newToken = await this.oauth.refresh(token.refreshToken)
      await this.storeToken(sessionId, newToken)
    } catch (error) {
      console.error('[TokenManager] Refresh failed:', error)
      await this.revokeToken(sessionId)
    }
  }

  private deriveKey(): CryptoKey {
    // Key derivation from environment secret
    return crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(process.env.TOKEN_SECRET),
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt']
    ) as unknown as CryptoKey
  }
}

interface TokenStorage {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
`

export const samplePythonCode = `"""
Machine Learning Pipeline - Data preprocessing and model training

This module provides a complete ML pipeline for classification tasks,
including data loading, preprocessing, training, and evaluation.
"""

import numpy as np
import pandas as pd
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import StandardScaler, LabelEncoder
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.metrics import classification_report, confusion_matrix
from typing import Optional, Tuple, Dict, Any
import logging

logger = logging.getLogger(__name__)


class MLPipeline:
    """End-to-end machine learning pipeline for classification."""

    def __init__(self, random_state: int = 42):
        self.random_state = random_state
        self.scaler = StandardScaler()
        self.label_encoder = LabelEncoder()
        self.model: Optional[Any] = None
        self._is_fitted = False

    def load_data(self, filepath: str) -> pd.DataFrame:
        """Load dataset from CSV with basic validation."""
        logger.info(f"Loading data from {filepath}")
        df = pd.read_csv(filepath)

        if df.empty:
            raise ValueError(f"Empty dataset: {filepath}")

        logger.info(f"Loaded {len(df)} rows, {len(df.columns)} columns")
        return df

    def preprocess(
        self,
        df: pd.DataFrame,
        target_col: str,
        drop_cols: Optional[list] = None,
    ) -> Tuple[np.ndarray, np.ndarray]:
        """Preprocess data: encode labels, scale features, handle missing values."""
        if drop_cols:
            df = df.drop(columns=drop_cols, errors='ignore')

        # Handle missing values
        numeric_cols = df.select_dtypes(include=[np.number]).columns
        df[numeric_cols] = df[numeric_cols].fillna(df[numeric_cols].median())

        # Encode target
        y = self.label_encoder.fit_transform(df[target_col])

        # Scale features
        X = df.drop(columns=[target_col])
        X = pd.get_dummies(X, drop_first=True)  # One-hot encode categoricals
        X_scaled = self.scaler.fit_transform(X)

        return X_scaled, y

    def train(
        self,
        X: np.ndarray,
        y: np.ndarray,
        model_type: str = "random_forest",
        **kwargs: Dict[str, Any],
    ) -> Dict[str, float]:
        """Train model and return cross-validation scores."""
        if model_type == "random_forest":
            self.model = RandomForestClassifier(
                random_state=self.random_state, **kwargs
            )
        elif model_type == "gradient_boosting":
            self.model = GradientBoostingClassifier(
                random_state=self.random_state, **kwargs
            )
        else:
            raise ValueError(f"Unknown model type: {model_type}")

        # Cross-validation
        scores = cross_val_score(self.model, X, y, cv=5, scoring="accuracy")
        logger.info(f"CV Accuracy: {scores.mean():.4f} (+/- {scores.std():.4f})")

        # Fit on full training data
        self.model.fit(X, y)
        self._is_fitted = True

        return {"mean_accuracy": scores.mean(), "std_accuracy": scores.std()}
`

// ============================================================================
// Multi-Diff Preview Overlay - Playground Wrapper
// ============================================================================

export const sampleMultiDiffChanges: FileChange[] = [
  {
    id: 'change-1',
    filePath: '/src/auth/index.ts',
    toolType: 'Edit',
    original: `  async authenticate(credentials: Credentials): Promise<Session> {
    const token = await this.oauth.getToken(credentials);
    return this.createSession(token);
  }`,
    modified: `  async authenticate(credentials: Credentials): Promise<Session> {
    // Validate credentials before attempting OAuth flow
    this.validateCredentials(credentials);

    // Generate PKCE challenge for security
    const { verifier, challenge } = await generatePKCE();

    const token = await this.oauth.getToken(credentials, {
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
    });

    // Store verifier for token exchange verification
    await this.storeVerifier(token.authCode, verifier);

    return this.createSession(token);
  }`,
  },
  {
    id: 'change-2',
    filePath: '/src/auth/oauth.ts',
    toolType: 'Edit',
    original: `export interface OAuthOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
}`,
    modified: `export interface OAuthOptions {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  /** PKCE code challenge for authorization request */
  codeChallenge?: string;
  /** PKCE challenge method (always S256) */
  codeChallengeMethod?: 'S256' | 'plain';
}`,
  },
  {
    id: 'change-3',
    filePath: '/src/middleware/rate-limiter.ts',
    toolType: 'Write',
    original: '',
    modified: `import { Redis } from 'ioredis'

/**
 * Sliding window rate limiter using Redis.
 * Limits authentication attempts to prevent brute force attacks.
 */
export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly windowMs: number = 60000,
    private readonly maxAttempts: number = 5,
  ) {}

  async isAllowed(key: string): Promise<boolean> {
    const now = Date.now()
    const windowStart = now - this.windowMs

    // Remove expired entries and count remaining
    await this.redis.zremrangebyscore(key, 0, windowStart)
    const count = await this.redis.zcard(key)

    if (count >= this.maxAttempts) {
      return false
    }

    // Add current attempt
    await this.redis.zadd(key, now, \`\${now}\`)
    await this.redis.expire(key, Math.ceil(this.windowMs / 1000))

    return true
  }
}
`,
  },
  {
    id: 'change-4',
    filePath: '/src/auth/index.ts',
    toolType: 'Edit',
    original: `import { OAuthClient } from './oauth'
import { TokenManager } from './tokens'`,
    modified: `import { OAuthClient } from './oauth'
import { TokenManager } from './tokens'
import { RateLimiter } from '../middleware/rate-limiter'
import { AuditLogger } from '../lib/audit'`,
  },
]

export const sampleSingleChange: FileChange[] = [
  {
    id: 'single-1',
    filePath: '/src/components/Button.tsx',
    toolType: 'Edit',
    original: `export function Button({ children, onClick }: ButtonProps) {
  return (
    <button onClick={onClick} className="btn">
      {children}
    </button>
  )
}`,
    modified: `export function Button({ children, onClick, variant = 'primary', disabled }: ButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn('btn', \`btn-\${variant}\`, disabled && 'btn-disabled')}
    >
      {children}
    </button>
  )
}`,
  },
]
